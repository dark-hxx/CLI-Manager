# 修复 Codex Goal Hook 状态灯提前完成

## Goal

修复 Codex `/goal` 长任务中的 Hook 状态误判：单个自动 continuation turn 结束时，不应让 CLI-Manager 把整个目标任务显示为已完成、发送完成通知或点亮绿色完成指示灯；只有目标进入真正的终态时才报告完成。

## Background / Confirmed Facts

- 用户观察到：执行 Codex goal 任务后，Tab 状态指示灯保持绿色；任务仍在分阶段执行，并且每个阶段都会重复触发完成 Hook 通知。
- 本项目当前在 `src/features/terminal/lib/terminalStatus.ts:173-185` 将所有 `Stop` 映射为 `done`。
- `src/features/terminal/store/terminalRuntime.ts:444-490` 收到 `Stop` 后更新 Tab 状态、清理运行中输出活动，并触发统计刷新；`src/app/App.tsx:868-890` 对 `Stop` 继续触发应用内 Toast、任务栏提醒和系统通知。
- 本项目的 Hook 客户端 `src-tauri/src/features/hooks/client.rs:84-160` 当前只透传通用会话字段和事件名，没有透传 Codex Hook 的 `turn_id`、`stop_hook_active`、goal 状态或 goal 标识。
- 官方 OpenAI Codex Hook 文档说明：`Stop` 属于 turn-scope 事件；其输入包含 `turn_id`、`stop_hook_active` 和 `last_assistant_message`。`Stop` 返回成功并不等价于整个 thread/goal 完成，Hook 也可以通过 `decision: "block"` 让 Codex 自动创建新的 continuation prompt。
- 官方 app-server 文档公开了 `thread/goal/updated` 以及 goal 状态 `active`、`blocked`、`usageLimited`、`budgetLimited`、`complete` 等生命周期信息，但当前 Hook 文档没有承诺将 goal 状态放入 Hook 输入。
- 进一步核查官方 `openai/codex` 源码与 issue：较新 Codex 已将 `thread_goals` 从 `state_5.sqlite` 拆到 `goals_1.sqlite`，并可能由 `CODEX_SQLITE_HOME` 或配置中的 SQLite 根目录控制；旧版本仍可能使用 `state_5.sqlite`。因此不能把单一路径视为稳定协议。
- 上游 `openai/codex` Issue [#22115](https://github.com/openai/codex/issues/22115) 记录了相同需求：`/goal` 的中间 autonomous turn 会产生噪声完成通知，外部消费者无法区分 goal 仍 active 与 goal complete；该 issue 已关闭为 [#22117](https://github.com/openai/codex/issues/22117) 的重复项。报告提到的临时方案是读取 Codex 内部 `state_5.sqlite` 的 `thread_goals` 表，但同时明确该内部 schema 不是稳定集成契约。

## Root-Cause Triage

这是跨进程 Hook 输入、Codex turn/goal 生命周期、前端状态机和通知 sink 的行为性根因修复。根因陈述：Codex 产生的是“每个 turn 的 Stop”，而 CLI-Manager 在 Hook 边界丢失了 goal 终态信息，并在前端把每个 Stop 当成整个 goal/对话完成，因此完成状态和通知在中间阶段提前产生。

## Discovery List

- [x] Codex 官方 Hook 事件语义与 `/goal` 多 turn 行为：官方 Hooks 文档、app-server 文档。
- [x] 上游同类问题：`openai/codex#22115` / `#22117`。
- [x] Hook 输入规范化与 payload 生成：`src-tauri/hook-schema/src/lib.rs`、`src-tauri/src/features/hooks/client.rs`。
- [x] 本地 Hook HTTP 接收与事件广播：`src-tauri/src/features/hooks/claude.rs`。
- [x] Codex Hook 安装事件集合：`src-tauri/src/features/hooks/settings/mod.rs`、`src-tauri/src/features/hooks/settings/codex.rs`。
- [x] 前端 Hook 状态映射与乱序处理：`src/features/terminal/lib/terminalStatus.ts`、`src/features/terminal/store/terminalRuntime.ts`。
- [x] 应用内 Toast、任务栏和系统通知分发：`src/app/App.tsx`。
- [x] 已决定并需在实现中验证：goal 状态来源为 Codex 数据库的只读 `thread_goals` 查询；优先使用 `CODEX_SQLITE_HOME`/当前配置指向的 `goals_1.sqlite`，兼容旧版 `state_5.sqlite`，不修改数据库。`paused`/`blocked` 映射为 attention，`budgetLimited`/`usageLimited` 映射为 failed 或其他明确的非成功终态，只有 `complete` 映射为绿色 done。

## Requirements

- 保持普通 Codex turn、非 goal 会话，以及 Claude/Pi/Kimi/Grok/OpenCode 的既有状态与通知行为。
- Codex goal 仍处于 active/running 时，任意中间 `Stop` 不得显示为 `done`，不得触发完成型 Toast、任务栏完成提醒或系统完成通知。
- Codex goal 达到 `complete` 时才显示完成状态并触发一次完成通知；非 goal 的单 turn `Stop` 仍按现有行为处理。
- goal 被暂停、阻塞或预算/用量限制时，不得误报为成功完成；应保留可区分的等待/失败/非完成语义，并避免重复通知。
- Hook 输入缺少 goal 元数据、Codex 版本不支持 goal 查询、数据库不可读或字段异常时，不得把不确定状态当作完成；需要维持安全的运行中/未知策略并记录脱敏诊断。
- 不修改 Codex 原生配置格式；保留现有 Hook 投递失败时对 CLI fail-open 的行为。
- 新增覆盖普通 turn、goal 中间 turn、goal 完成、暂停/阻塞/限制、无 goal 元数据、重复/乱序事件的定向测试。
- 代码变更记录归入 `V1.4.0`，交付前同步更新 `CHANGELOG.md` 与 `docs/功能清单.md`。

## Decisions

- 收到 Codex `Stop` Hook 后，使用 Hook 的 `session_id` 在 Codex 数据库的 `thread_goals` 中只读查询 goal 状态；查询适配隔离在 Codex 专用边界内，不修改数据库。优先查询 `CODEX_SQLITE_HOME`/配置 SQLite 根目录下的 `goals_1.sqlite`，再兼容旧版 `state_5.sqlite`。非 goal 会话只有在成功查询确认无对应 goal 行时才沿用 `Stop -> done`；查询失败或状态不确定时采用安全的非完成策略。该方案是当前官方 Hook 未暴露 goal 字段时的兼容实现，不把内部 schema 作为长期公共契约。
- Tab 指示灯和通知按以下规则处理：`active` 不完成、不发送完成通知；`complete` 显示绿色 done 并只发送一次完成通知；`paused`/`blocked` 显示 attention，不视为成功；`budgetLimited`/`usageLimited` 显示 failed 或其他明确的非成功终态，不视为成功。复用现有 `running`、`attention`、`failed`、`done` 状态，不新增持久化状态枚举。

## Scope Boundaries

- 本任务修改 CLI-Manager 的 Hook 载荷、Codex goal 查询、daemon/第三方/远端接管通知和 Tab 状态消费；不修改 Codex 原生 Hook 配置、Codex 数据库 schema 或 app-server 协议。
- WSL/SSH 场景必须保持“无法确认时不误报完成”的安全降级。SSH 不在 Windows 本地读取远端数据库；只有远端 Hook 已携带可信的 goal 状态时才消费该状态。WSL 不直接打开 Windows UNC 上的 SQLite WAL 文件。
- 不新增用户可见文案时复用现有状态、事件标签和中英文翻译；如验证发现必须增加文案，必须同步 `zh-CN` 与 `en-US`。

## Acceptance Criteria

- [ ] Codex 非 goal turn 的现有 `Stop -> done` 行为不回归。
- [ ] Codex goal 的中间 Stop 不再把 Tab 置为绿色 done，也不产生完成型通知。
- [ ] Codex goal `complete` 只产生一次完成状态/通知；重复或乱序事件不会重复升级或回退状态。
- [ ] Codex goal 的暂停、阻塞、预算/用量限制不会被误报为成功完成，并有明确测试覆盖。
- [ ] 无法读取/识别 goal 状态时不会误报完成，且有脱敏诊断或可验证的降级行为。
- [ ] 定向前后端测试、`npx tsc --noEmit`、`cd src-tauri && cargo test`、`cd src-tauri && cargo check`、`npm run check:architecture -- --strict` 和 `git diff --check` 通过。
- [ ] `CHANGELOG.md` 的 `V1.4.0` 与 `docs/功能清单.md` 相关功能板块已更新。

## Notes

- 研究来源：官方 [Codex Hooks 文档](https://learn.chatgpt.com/docs/hooks)、官方 [Codex Advanced Configuration / Notifications](https://learn.chatgpt.com/docs/config-file/config-advanced)、官方 [Codex app-server goal 与 turn 文档](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)。
- 当前仍处于规划阶段；复杂任务在 `task.py start` 前必须补齐 `design.md` 与 `implement.md`，并由用户确认规划结果。GitNexus MCP 工具在本会话不可用，实施前后将按项目要求使用契约、符号定位和 `rg` 做替代影响审查，并明确记录该限制。
