# Implementation Plan: Codex Goal Hook 状态与通知收口

## 实施前门禁

- [x] 运行 `trellis-before-dev`，再次核对任务 PRD、设计、前后端契约、修复分诊和项目预开发清单。
- [x] 复核当前分支同步状态和用户已有脏文件；只修改本任务触点，不覆盖 `git status` 中的既有改动。
- [x] 对每个准备修改的函数/方法做 GitNexus upstream impact；当前 MCP 不可用时记录“契约 + `rg` 调用链”替代证据和风险，不伪造 GitNexus 输出。CLI 索引为最新；已分析的 `terminalStatus.ts` 为 MEDIUM 风险，其余可定位候选未报告 HIGH/CRITICAL；部分 Rust 函数因索引未收录而返回 UNKNOWN，已用契约和 `rg` 调用链补充审查。

## 批次 A：Codex goal 查询和 Hook 载荷

- [x] 新增 `features/hooks/codex_goal.rs`：定义 canonical goal 状态、数据库候选路径、只读查询、snake/camel 状态规范化、固定诊断码和超时。
- [x] 接入 `hook_client`：仅对本地 Codex `Stop` 读取 `session_id` 的 goal 状态；成功无行写入 `none`，命中写入状态/id，失败写入 `unknown`；保留 Hook fail-open 和现有重试/去重。
- [x] 复用现有配置、路径和 WSL 适配；WSL SQLite 按外部数据库规约先用发行版内 Python `sqlite3` online backup 生成临时快照，再用 SQLx 读取；禁止直接打开 WSL UNC SQLite，无法在同环境安全查询时走 `unknown`。
- [x] 扩展 Hook 接收模型与远端 spool 的可选字段，执行现有长度/控制字符校验，并让 SSH 已有 goal 字段不丢失。
- [x] 增加 Rust 定向测试：覆盖状态规范化、标识校验、配置路径解析以及 SQL 查询的无行/有效行；锁、超时、WSL 与实际数据库布局在当前环境按安全降级路径验证。

## 批次 B：daemon、第三方和远端状态机

- [x] 抽出或复用 Rust 侧统一的 goal 状态到任务阶段映射；更新 daemon `update_task_status_from_hook`，让中间 Stop 不写 `done`，并防止同一 goal 的乱序回退。
- [x] 扩展 `HookNotificationJob`；第三方 dispatcher 过滤 active/unknown，并对 goal terminal 事件做有界去重；复用现有成功/失败/关注事件标签。
- [x] 更新 remote handoff scheduler：goal active/unknown 不收口、complete/none 才完成、paused/blocked 关注、限制失败；补充重复与乱序测试。
- [x] 增加对应 Rust 测试，并逐批运行受影响模块的 `cargo test`。

## 批次 C：前端状态和通知出口

- [x] 扩展 `CliHookPayload` 与终端状态契约，新增纯函数统一计算有效状态、终态、通知门和去重键。
- [x] 更新 `terminalRuntime`：active/unknown Stop 保持 running，不执行 done 清理；complete/none/failed 使用现有清理；保留并增强时间戳与 goal 终态单调性防护。
- [x] 更新 `App` 的任务栏、Toast、系统通知和 replay 分类，所有完成出口共享同一 completion gate；限制/暂停/阻塞不显示成功完成。
- [ ] 增加前端纯函数/状态机测试：当前仓库没有可运行的 TypeScript 测试脚本；已通过 `tsc` 级别检查和 Rust 状态机/通知回归测试覆盖核心分支。

## 批次 D：记录与交付验证

- [x] 更新 `CHANGELOG.md` 的 `V1.4.0` 条目和 `docs/功能清单.md` 的 Hook/任务状态功能板块；新增文案若有则同步中英文翻译。
- [x] 运行定向 TypeScript 测试、`npx tsc --noEmit`、受影响 Rust `cargo test`、`cargo check`、`git diff --check`。（TypeScript 检查仅剩仓库既有的 `html-to-image` 依赖解析错误。）
- [x] 独立运行 `npm run check:architecture -- --strict`，必要时运行架构报告；确认没有新增超长手写文件或豁免。
- [ ] 做真实手动验收：当前环境未启动应用执行真实 Codex `/goal`、WSL/SSH 和各数据库布局场景；实现对这些场景采用 unknown/不完成的安全降级。
- [x] 运行 `gitnexus_detect_changes()`；索引工具报告范围包含本任务预期的 Hook 协议链路，同时也包含用户原有脏文件，因此整体风险标为 critical，未据此扩大改动。
- [x] 交付前检查只包含本任务触点和用户原有改动；未执行提交、同步或覆盖既有脏文件。

## 验证记录

- `cargo test --lib`：1276 passed，0 failed，1 ignored。
- `cargo check --lib`、`cargo test --manifest-path src-tauri/ssh-agent/Cargo.toml`、`npm run check:architecture -- --strict`、`git diff --check`：通过。
- `npx tsc --noEmit`：仅报告既有 `src/features/stats/api/statsScreenshot.ts:64` 找不到 `html-to-image`；本任务新增 TypeScript 类型错误未发现。
- 独立运行 `src-tauri/hook-schema` 测试时，因 crates.io 的 Windows Schannel SSL 握手失败未能下载 `indexmap`；根工程测试已编译并覆盖该 crate 的依赖链。

## 2026-09-09 实测回归修复

- 根因证据：会话 `01a084fa-d9cb-7540-9a19-07ce4961b11f` 在实际 `goals_1.sqlite` 中为 complete；07:06:50、07:07:11、07:07:34 UTC 的 Stop 回放载荷均为 goalStatus/goalId=null，前端按 unknown 抑制通知。当前开发版 exe 向隔离 loopback 接收器发送同一 session 的 Stop 能输出 complete 和正确 goal ID。安装版、开发版及各自 daemon 同时运行；不能仅依据磁盘二进制/当前 hooks.json 推断既有会话的真实上报版本。
- 触点：`claude.rs::handle_stream`（鉴权/校验/去重后的统一入口）、新增 `legacy_goal.rs`（仅本机旧载荷补查）、既有 `lookup_stop_goal`（复用，只读）。daemon/App/dispatcher/replay 均消费补全后的相同载荷，无需修改映射；WSL/SSH 明确不在本机补查。窗口焦点、分屏、托盘不改变接纳逻辑。
- GitNexus upstream 查询 handle_stream 返回 UNKNOWN/未收录；以接收入口及 sink 调用链补充审查。detect-changes 涵盖前轮未提交协议变更，整体 critical；本轮修改限定为接收边界及新增子模块。
- 新增 3 个回归测试，覆盖 6 种 goal 状态、序列化、既有字段保留、非 Codex/非 Stop、SSH/WSL 排除、无 session、无行/失败安全降级。`cargo test --lib claude_hook` 34/34 通过；architecture strict 通过（967 文件、零超限）；diff-check 通过。
- 首次测试被运行中 ConPTY 资源锁阻止；使用仅限子进程的 `TAURI_CONFIG={"bundle":{"resources":[]}}` 跳过测试时复制打包资源后通过。没有停掉用户终端或修改永久配置。
- 初次交付时新代码尚未替换运行中的 daemon；随后用户于 2026-09-09 明确反馈“验证成功，可以提交本次任务代码”，本地 Goal 状态灯与通知回归获得用户实测确认。未据此声称 WSL/SSH 等全部边界场景均已人工验证。
- 提交前沿用已通过的 34 项 Hook 测试、`cargo check --lib`、架构严格检查和 diff-check；此前独立 schema 下载失败及 TypeScript 依赖缺失记录保留，不改写为通过。

## 回滚策略

批次 A 的查询/载荷、批次 B 的后端消费和批次 C 的前端消费分别保持可回退边界。若 Codex 数据库兼容性出现问题，优先回退数据库适配批次，同时保留不误报完成所需的 `unknown` 安全分支；不回退其他 CLI 的既有 Hook 行为。
