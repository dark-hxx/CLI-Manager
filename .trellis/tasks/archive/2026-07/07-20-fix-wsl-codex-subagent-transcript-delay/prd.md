# 修复 WSL Codex 子任务分屏文字延迟

## Goal

修复 Windows 宿主运行 WSL Codex 时，子任务分屏已创建但执行期间长期无文字、接近结束时才一次性显示 transcript 的问题。

## Changelog Target

`[TEMP]`

## Requirements

- `SubagentStart` 后只要能获得 `agentId` 和父会话关联信息，就应持续发现子 rollout，不能在固定 15 秒后放弃。
- `SubagentStop` 仍可补充最终 transcript，但不能作为正常显示文字的主要触发点。
- WSL 路径统一兼容 Linux 原生路径、`\\wsl.localhost\\...`、`\\wsl$\\...` 和 `\\?\\UNC\\wsl*\\...`。
- Codex 配置目录与 sessions 根必须区分，避免把已包含 `sessions` 的路径再次拼成 `sessions/sessions`。
- Windows 原生 Codex、Claude 子 Agent、分屏生命周期和 transcript 安全范围校验保持现有行为。
- 不新增依赖，不重构分屏状态机。

## Acceptance Criteria

- [ ] WSL Codex 启动三个并行子任务时，每个分屏在任务执行期间持续显示新增文字，而不是结束前一次性出现。
- [ ] 超过 15 秒的子任务仍会继续发现 rollout，直到成功订阅、子任务结束或分屏被关闭。
- [x] 三种 WSL UNC 前缀和 Linux 路径均能解析到正确的发行版与 sessions 根。
- [x] 配置目录传入 `.codex` 或 `.codex/sessions` 时均不会产生重复 `sessions`。
- [x] Windows 原生 Codex 和 Claude 子 Agent 相关测试保持通过。
- [x] `npx tsc --noEmit`、Rust 定向测试和 `cargo check` 通过；若环境锁文件阻塞，记录具体错误。

## Root Cause

问题位于 Hook 事件到 Codex rollout discovery 的 WSL 跨平台边界：开始事件创建了分屏，但 rollout 发现依赖不完整的 WSL/session 上下文且仅重试 15 秒；结束事件会重新执行发现，因此最终文件可见后才一次性加载累计内容。

## Technical Approach

- 在共享 WSL 路径工具中统一归一化 verbatim UNC，再由前后端发现逻辑复用。
- 调整 Codex rollout discovery 的 sessions 根解析，兼容配置目录和 sessions 根输入。
- 将 Codex 子 transcript 的发现重试生命周期改为持续到成功、结束或 pane 关闭；前 15 秒每秒发现一次，之后降频为每 5 秒一次，并保持单请求串行。
- 补充路径解析、sessions 根和长任务发现生命周期回归测试。

## Out of Scope

- 修改 Codex CLI 的 Hook 字段定义或 rollout 写入策略。
- 展示父会话输出冒充子任务 transcript。
- 修改分屏布局、标题或关闭动画。

## Verification

- `npx tsc --noEmit`：通过。
- `cargo test subagent_transcript --lib`：17 passed。
- `cargo test wsl --lib`：45 passed，1 ignored（需要真实 WSL SQLite 环境）。
- `cargo check`：通过。
- 默认 `target/debug` 被正在运行的 OpenConsole.exe 锁定，Rust 验证改用 `%TEMP%/cli-manager-codex-check` 独立目标目录完成。
- 待人工桌面验证：WSL Codex 启动 3 个持续超过 15 秒的子任务，确认执行期间持续增量显示。

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
