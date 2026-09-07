# Codex 审批通知仲裁根因修复设计

## Root-cause statement

故障位于 Codex Hook 事件生产与共享通知仲裁的进程边界：子代理的无文案 `PermissionRequest` 会被暂存，但安装器未上报可证明工具已经开始或结束的生命周期事件，导致仲裁超时后把已经失效或本就非交互的请求重新送入所有通知通道；修复必须补齐上游事件并在共享 Rust 仲裁层完成有作用域的双向关联。

## State dependency

- Agent：主代理 / 单个子代理 / 多个并行子代理。
- 环境：本地 / WSL / SSH。
- Hook：新安装 / 旧安装 / 部分安装 / 未安装。
- 时序：审批先到 / ToolStart 先到 / ToolStop 先到 / 无进度证据。
- 工具身份：有 tool ID / 只有精确 tool name。
- 会话：单会话 / 多 tab / 不同 parent session。

## Discovery list

### Must change

- [x] `src-tauri/src/claude_hook.rs`：共享审批仲裁、短期工具进度 tombstone、可信 transcript 候选和回归测试。
- [x] `src-tauri/src/commands/hook_settings.rs`：Codex `PreToolUse`/`PostToolUse` 生命周期 Hook、状态/安装/卸载/升级测试。
- [x] `.trellis/spec/backend/cli-hook-contracts.md`：固化内部事件与通知边界契约。
- [x] `CHANGELOG.md`、`docs/功能清单.md`：记录用户可见修复。

### Inspect before deciding

- [x] `src/stores/terminalStore.ts`：确认仲裁后事件的前端状态消费，不承担主修复。
- [x] 前端 Hook 通知消费：确认只接收 daemon 仲裁后的广播，不需要症状层过滤。
- [x] 远程托管和第三方通知 sink：确认统一位于 `approval_aware_hook_sink` 的 delivery 之后，没有绕过共享仲裁。

### Confirmed unrelated

- [x] cc-connect 源码与消息平台 SDK：不修改。
- [x] 数据库与 IPC schema：不需要迁移。

## Risk

风险等级 HIGH：`ApprovalArbiterState` 位于所有 Hook 通知通道之前，错误抑制会漏掉真实审批。使用精确作用域、短期 tombstone、有界兜底和乱序测试控制风险。

## Tool fallback

当前 GitNexus 无可用仓库索引，codebase-memory MCP transport 关闭。按规范降级到 Hook 契约、`rg`、源码阅读、专项测试、完整 Git diff 和 `detect_changes` 的本地等价检查。
