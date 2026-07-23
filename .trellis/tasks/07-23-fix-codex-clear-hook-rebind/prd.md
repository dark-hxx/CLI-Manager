# 修复 Codex clear 后实时监控失效

## Goal

修复 Codex 执行 `/clear` 创建新会话后，CLI-Manager 仍绑定旧 `cliSessionId`，导致实时统计、Tab 状态和通知弹窗同时失效的问题；保持同项目多 Tab、分屏、WSL 与 SSH 场景不串绑。

## What I already know

- Codex 0.145.0 在 `/clear` 后会创建新线程，并应在下一次输入前触发携带新 `session_id` 的 `SessionStart(source=clear)`。
- 前端收到任何携带新 `sessionId` 的有效 Hook 后，现有 `handleCliHookEvent` 已能替换终端的 `cliSessionId`。
- 实时统计、Tab 状态和弹窗共用同一条 Hook 事件链；Hook 未送达会导致三者同时失效。
- Hook 客户端当前对环境缺失、输入解析失败和 HTTP 上报失败静默退出。
- Codex Hook 安装状态当前主要检查配置条目和脚本存在，不验证有效信任及实际可执行性。
- Changelog Target: `[TEMP]`。

## Requirements

- 修复 `/clear` 后新会话 ID 的重新绑定，不在统计面板、Tab 状态和弹窗分别打补丁。
- 保持 `SessionStart` 为明确的会话身份切换信号。
- Hook 上报失败必须产生脱敏、可定位的诊断信息，不记录 token、完整 prompt 或敏感环境变量。
- Hook 安装状态不得在配置存在但不可实际执行时误报为完整安装。
- 同项目多 Tab 和分屏场景必须继续按稳定 PTY Tab ID 绑定，禁止使用“项目最新会话”猜测。
- 不新增依赖，不改数据库 schema。

## Acceptance Criteria

- [x] 旧会话绑定后收到 `SessionStart(clear, new_session_id)`，终端立即改绑新 ID。
- [x] 随后的 `UserPromptSubmit`、`Stop` 正确更新同一 Tab 的状态与实时统计刷新序号。
- [x] Hook 环境缺失、stdin 解析失败或 bridge 请求失败时有脱敏诊断。
- [x] Hook 安装状态能区分配置存在与有效可执行状态，或明确暴露无法验证的状态，不能误报。
- [x] 同项目多 Tab、分屏、WSL、SSH 不发生跨 Tab 会话 ID 串绑。
- [x] 相关 Rust/TypeScript 测试和静态检查通过。
- [x] `CHANGELOG.md` 的 `[TEMP]` 记录本次行为修复。

## Definition of Done

- 补充会话切换与 Hook 失败路径回归测试。
- 完成 Rust 检查、目标测试和前端类型检查；不主动运行开发服务或完整 Tauri 构建。
- 使用 GitNexus 检查修改影响范围与最终变更范围。
- 不覆盖当前工作区中与本任务无关的未提交改动。

## Out of Scope

- 不修改 Codex CLI 上游源码。
- 不通过轮询“最新项目会话”替代 Hook 身份绑定。
- 不重构整个 Hook/通知架构。
- 不处理与 `/clear` 无关的统计 UI 或 SSH 历史功能。

## Technical Notes

- 主要触点：`src-tauri/src/commands/hook_settings.rs`、`src-tauri/src/hook_client.rs`、`src/stores/terminalStore.ts` 及相应测试。
- 下游消费者：`src/App.tsx`、`src/components/terminal/TerminalStatsPanel.tsx`，当前证据显示无需分别修改。
- Git 归因：严格会话绑定主要来自 `a2054ede`；`SessionStart` 支持来自 `fcf7de25`；`39290916` 仅增强刷新时机。
- 最终实现没有改变稳定 PTY Tab ID 路由；仅把既有会话 ID 覆盖逻辑提取为纯函数并增加 `/clear` 回归测试。
- 全量 `hook_settings` 测试发现 HEAD 已存在的 Pi 卸载断言失败：`install_then_uninstall_pi_extension` 期望 `notInstalled`，但 `hooks_feature_installed: true` 会得到 `partialInstalled`；与本任务改动无关，目标 Codex/Hook 测试均通过。

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
