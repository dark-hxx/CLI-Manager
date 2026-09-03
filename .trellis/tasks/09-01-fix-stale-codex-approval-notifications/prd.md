# Fix stale Codex approval notifications

## Goal

修复 Codex 主代理或子代理已经继续执行、审批已处理后，CLI-Manager 仍延迟弹出待处理提醒的问题。修复必须位于共享 Hook 仲裁入口，使终端状态、桌面宠物、应用内提示、任务栏、系统通知、第三方通知和远程托管通知保持一致。

## Requirements

- Codex 内部工具开始/结束事件用于审批仲裁，但不得产生用户可见通知。
- 消息为空的子代理审批必须与同一 source、environment、tab、session、agent 和 tool 关联，不能跨会话或跨子代理相互消除。
- 工具事件先到或审批事件先到都必须正确处理。
- 缺少 tool ID 时只允许用同一作用域内的精确工具名关联。
- 真正且未解决的审批仍须在有界等待后恰好通知一次。
- SSH 审批继续即时传递；WSL 不得恢复原生 UNC 元数据轮询。
- 已安装的旧 Codex Hook 必须能被识别为需要升级，或由安全的托管 Hook 更新路径补齐生命周期事件。

## Acceptance Criteria

- [x] 非交互 `apply_patch` 子代理工具进度不会在 15 秒后产生旧审批提醒。
- [x] 主代理真实审批与未解决子代理审批不被吞掉。
- [x] 多子代理、事件乱序、缺失 tool ID、父子 transcript 候选均有回归覆盖。
- [x] 旧 Codex Hook 状态能提示或执行托管升级。
- [x] 所有共享通知通道只接收仲裁后的事件。
- [x] Rust 专项测试、`cargo check --lib`、TypeScript 检查与 NSIS 打包通过。
