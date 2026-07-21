# Implementation Plan

## Checklist

- [x] 读取相关前后端契约与质量规范。
- [x] GitNexus 本会话不可用；已用 PTY daemon 契约、fast-context 语义搜索和 `rg` 引用搜索完成影响分析。
- [x] Windows PTY 环境块改为合并最新用户环境，并保持显式覆盖优先级。
- [x] 补充 Windows 环境解析/合并单元测试。
- [x] 正常退出路径统一关闭全部 daemon PTY；后台继续路径保持不变。
- [x] 修正 daemon 查询不可用语义与 shutdown 失败时无条件退出问题。
- [x] 补充退出编排回归测试。
- [x] 更新 `CHANGELOG.md` 的 `V1.3.0` 修复章节。
- [x] 判断 `docs/功能清单.md` 是否需要更新；本次是缺陷修复，不新增功能条目。
- [x] 执行 Node 定向测试与 `git diff --check`；按用户要求跳过 `cargo check`、Rust 测试和 `npx tsc --noEmit`。
- [x] 执行变更影响核对并记录结果。

## Risky Files

- `src-tauri/src/pty/platform/windows.rs`：所有 Windows 本地 PTY 共用。
- `src/App.tsx`：应用退出、后台继续和恢复快照共用。

## Root Cause Statement

- 环境问题位于 daemon 进程环境到新 Windows PTY 的进程创建边界：长期运行的 daemon 只持有启动时快照，直接复用会漏掉后续安装 CLI 更新的用户 `PATH`；但简单用 fresh `PATH` 整值覆盖又会丢失 daemon 的临时路径，因此修复必须落在 Windows 环境块合并层。
- 退出问题位于前端退出守卫到 daemon 生命周期边界：`pty_daemon_sessions` 把“不可用”伪装成空列表，且退出清理在 `finally` 无条件调用 `app_exit`，导致查询/关闭/shutdown 失败都无法阻止应用退出和 daemon 残留。

## Scenario Check

- 本地 PowerShell / PowerShell 7 / CMD / Git Bash：新建 PTY 使用刷新环境；已运行 PTY 不热更新。
- WSL / SSH：仍由现有 launch plan 与环境转发处理；本次只刷新宿主 Windows 进程环境，不改变远端/WSL 内部 `PATH` 规则。
- 单会话 / 多会话 / 隐藏会话：daemon 查询成功且无运行任务时统一 close_all；查询失败时只关闭前台会话，shutdown 失败则留在应用内。
- 正常窗口 / 最小化 / 托盘：真实退出走清理；转入后台继续执行不调用 close/close_all/shutdown。
- daemon 不存在 / 连接失败 / 有活动会话：分别按 shutdown `false`、异常、`sessions active` 处理，不再把未知状态当作空闲。

## Discovery List

- [x] `src-tauri/src/pty/platform/windows.rs`：Windows 环境块来源、解析、合并与 CreateProcessW 输入。
- [x] `src-tauri/src/pty/manager.rs`：确认所有 Windows 新建 PTY 共用 platform spawn，close_all 负责批量结束会话。
- [x] `src-tauri/src/commands/terminal.rs`：daemon list/shutdown Tauri command 返回语义。
- [x] `src-tauri/src/daemon/server.rs`：确认 shutdown 在存在 alive session 时返回 `sessions active`。
- [x] `src/App.tsx`：运行任务判定、真实退出、后台继续、快照与 session 丢弃顺序。
- [x] `src/terminal/core/TerminalProcessManager.ts` / `src/terminal/transport/PtyHostSocket.ts`：确认 close/close_all 的 WebSocket 边界与 tombstone 语义；本次不修改。
- [x] `src/stores/terminalStore.ts`、`src/components/TerminalTabs.tsx`、`src/components/BackgroundTasksPanel.tsx`、`src/hooks/useDesktopPetCoordinator.ts`：确认 `pty_daemon_sessions` 调用者已有 catch/fallback。
- [x] `src/lib/terminalExitTask.ts`：任务分类规则保持不变。
- [x] 数据库、配置 schema、用户可见文案、`docs/功能清单.md`：确认无关。

## Validation

- Rust 单测覆盖环境键大小写、最新环境覆盖旧进程环境、显式项目环境最终覆盖。
- 前端测试覆盖正常退出调用 close_all、后台继续不调用 close_all。
- 手动场景：PowerShell/CMD/Pwsh/Git Bash 新终端、后台任务继续、无任务正常退出。

## Verification Result

- `node scripts/terminalExitCleanup.test.mjs`：6/6 通过。
- `node scripts/terminalExitTask.test.mjs`：7/7 通过。
- `node scripts/ptyHostSocket.test.mjs`：8/8 通过。
- `node scripts/terminalProcessManager.test.mjs`：3/3 通过。
- `git diff --check`：通过，仅有既有 CRLF 转换提示。
- 编译/类型检查：按用户明确要求跳过。
- `cargo fmt --check`：当前 toolchain 未安装 `rustfmt`，无法执行；已手工按现有 Rust 格式核对。

## Impact Result

- Windows 环境刷新仅作用于新建本地 PTY；已运行 PTY、Unix 和 SSH launch plan 不变。
- `pty_daemon_sessions` 的所有调用者均已有 catch/fallback；启动恢复降级重建，后台列表降级为空，手动 attach 向调用者返回失败。
- 真实退出失败时不再无条件终止应用；转入后台仍不调用 close/close_all/shutdown。
