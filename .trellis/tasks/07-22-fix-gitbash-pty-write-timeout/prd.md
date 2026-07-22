# 修复 Git Bash PTY 写入超时

## Goal

修复新建 Git Bash 项目时，PTY 写入已执行但确认响应被大块 Replay 发送饿死，最终触发 `PtyHost request timed out: write` 的误报。

## Changelog Target

`[TEMP]`

## Requirements

- 修复必须落在 PTY writer 竞争根因处，不在前端增加重试、延长超时或吞掉错误。
- Replay 发送过程中必须允许普通控制响应抢占，不能把整个 Replay 当作不可中断的单次发送。
- 保持 Replay 数据顺序、reset/attached 屏障以及实时输出衔接语义。
- 不新增依赖，不修改前端与 daemon 协议。
- 保留 PowerShell、CMD、Git Bash、WSL、SSH 的现有输入顺序语义。

## Acceptance Criteria

- [ ] Git Bash 新建会话后启动命令能够写入，不再等待 15 秒后超时（待开发版重启后手动验证）。
- [x] 大块 Replay 发送期间，`Write -> Ok` 控制响应可在 Replay 帧之间优先发送。
- [x] Replay reset、数据帧、最终 attached 屏障的相对顺序不变。
- [x] daemon writer 定向回归测试通过。
- [x] `cargo check` 通过。

## Root Cause

daemon 的 `ClientWriter` 虽有控制帧优先队列，但单个 `Attached` 项在 `ClientTransport::send_frame` 内同步发送全部 Replay；运行态存在 1.46 MiB 的单会话 Replay，期间新终端写入已经到达 PTY，`Ok` 却只能等待整个 Replay 发送完成，前端最终触发 15 秒超时。

## Technical Approach

- 将 `Attached` 展开为可独立调度的 Replay wire frames，并加入现有 output 队列。
- 最终 `attached` 屏障仍排在 Replay 数据之后；普通 `ok/err/pong` 继续走 control 队列，可在 Replay 帧之间抢占。
- 不修改 PTY writer、前端超时或协议字段。

## Risk

- 风险等级：中。GitNexus 对 `PtyManager` 的静态影响分析为 LOW，但变更处于 PTY/进程边界并影响输入时序。
- 重点验证：Git Bash 启动、Codex OSC 探测、快速连续输入、会话关闭。

## Out of Scope

- 修改 `PtyHostSocket` 的 15 秒超时。
- 在前端增加重试或错误兜底。
- 修改 OSC 回复、PTY writer、主题同步协议或 SSH 行为。

## Notes

- 主要触点：`src-tauri/src/daemon/server.rs` 的 `ClientWriter` / `ClientTransport`。
- 已确认无关：项目保存路径 `src/components/ConfigModal.tsx`、SQLite `createProject`。
- GitNexus 影响分析：`ClientWriter` upstream 风险 LOW，未识别直接受影响流程；按 daemon/WebSocket 边界风险人工上调为中。

## Verification

- `cargo test websocket_replay_allows_control_frames_to_preempt_between_entries --target-dir target\codex-check`：通过。
- `cargo test daemon::server::tests::websocket --target-dir target\codex-check`：2/2 通过。
- `cargo test attach_barrier_sends_replay_control_before_buffered_live_output --target-dir target\codex-check`：通过。
- `cargo test daemon::server::tests --target-dir target\codex-check`：11/11 通过。
- `cargo check --target-dir target\codex-check`：通过。
- `git diff --check`：通过（仅仓库既有 LF → CRLF 警告）。
- 默认 target 首次测试受运行中 daemon 占用 `OpenConsole.exe` 影响，返回 Windows `os error 32`；未停止用户进程，改用隔离 target 完成验证。
