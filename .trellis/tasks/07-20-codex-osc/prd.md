# 修复 Codex OSC 颜色响应泄漏

## Goal

将终端 OSC 10/11 默认前景色、背景色查询的响应职责从 React 前端异步链路下沉到 Rust PTY 层，避免响应超过 Codex 启动探测窗口后被当作用户输入，同时保留终端主题探测能力。

## Changelog Target

`[TEMP]`

## What I already know

- 当前 Codex 为 `codex-cli 0.144.6`，Windows 启动探测会发送 OSC 10/11 查询并使用约 100ms 的固定等待窗口。
- 泄漏文本中的 `D3D3/D7D7/CFCF` 与 `0000/0000/0000` 精确对应 CLI-Manager 的 Tango Dark 前景色 `#D3D7CF` 和背景色 `#000000`。
- 当前 `useTerminalOsc` 在收到实时查询后通过前端 WebSocket/daemon 链路异步写回 PTY；Replay 已禁止回复，但实时链路仍存在迟到竞态。
- 现有 `terminalOsc.test.mjs` 只验证回复合并与 Replay 无副作用，没有覆盖 Codex 100ms 探测窗口。
- GitNexus 影响分析：`useTerminalOsc` 风险 LOW；`PtyManager` 风险 LOW。实际变更仍跨前端、daemon 协议与 PTY 边界，按中等工程风险处理。
- 当前分支相对 `origin/master` 为本地领先 4、远端领先 0；工作区存在用户未提交改动，实施时必须避开无关文件并保留 `CHANGELOG.md` 现有内容。

## Requirements

- Rust PTY 实时输出路径必须支持跨数据块识别完整的 OSC 10/11 查询。
- 同一批实时查询应生成一次有序 PTY 回复，不能经过 React 前端回写。
- 前端继续从显示流移除 OSC 10/11 查询，但不再产生 PTY 输入副作用。
- 终端颜色在会话创建时传给 daemon；主题变化后应能更新 daemon 中的会话颜色，避免后续查询得到陈旧颜色。
- Replay、恢复快照和历史输出不得触发任何 OSC 回复。
- 不影响 OSC 7/8/133/633/777、CSI/DA、普通输出、UTF-8 边界与 PTY ACK 语义。
- 不新增依赖。

## Acceptance Criteria

- [ ] 本地 Windows Codex 启动时输入框不再出现 `]10;rgb...` / `]11;rgb...`。
- [x] 本地实时 OSC 10/11 查询在 Rust PTY 层完成回复，前端不调用 `terminalProcessManager.write`。
- [x] 查询被拆分到任意 PTY 数据块时仍能正确识别，普通 OSC 序列原样保留。
- [x] Replay 和恢复路径不会写入 PTY。
- [ ] 主题切换后的新查询使用最新前景色、背景色。
- [x] 本地 Windows 与 WSL 会话在 Rust PTY 层回复；SSH 会话过滤查询但不回复。
- [x] Rust 单元测试、Node 终端测试、TypeScript 类型检查和 `cargo check` 通过。

## Definition of Done

- 根因修复和回归测试完成。
- GitNexus `detect_changes` 仅显示预期终端流程受影响。
- `[TEMP]` 变更记录已更新，未覆盖用户现有改动。
- 手动验证清单覆盖 PowerShell、Git Bash、CMD、WSL、SSH、恢复/Replay。

## Technical Approach

- daemon 会话保存标准化后的前景色、背景色。
- PTY reader 使用流式状态机识别 OSC 10/11 查询，并通过共享、串行化的 PTY writer 立即回复。
- 创建协议携带初始颜色；新增轻量更新帧同步运行时主题变化。
- 前端 OSC hook 降为纯过滤/集成事件处理，不再负责终端能力回复。

## Decision (ADR-lite)

**Context**: 前端异步回复无法满足 Codex 短时启动探测窗口，迟到回复进入正常输入事件流。

**Decision**: 将 OSC 10/11 终端能力响应放到最接近 PTY 的 Rust 层，并保持前端无输入副作用。

**Consequences**: 需要调整 daemon 协议和 PTY writer 所有权；本地 Windows/WSL 保留主题探测，SSH 为避免不可控网络 RTT 导致迟到输入而不回复颜色查询。

## Out of Scope

- 修改 Codex 本身或用户 `~/.codex/config.toml`。
- 升级、降级 Codex 或项目依赖。
- 重构其他 ANSI/OSC 功能。

## Research References

- [`research/osc-color-probe.md`](research/osc-color-probe.md) — Codex 探测时序、同类问题与适合本项目的响应层结论。

## Technical Notes

- 主要触点：`src/hooks/useTerminalOsc.ts`、`src/hooks/useTerminalDisplay.ts`、`src/terminal/core/TerminalProcessManager.ts`、`src/terminal/transport/PtyHostSocket.ts`、`src-tauri/src/daemon/protocol.rs`、`src-tauri/src/daemon/server.rs`、`src-tauri/src/pty/manager.rs`。
- 现有 PTY writer 由 `PtySession` 独占；后端即时回复需要共享串行 writer 或等价的单写入通道，禁止并发无序写入。
