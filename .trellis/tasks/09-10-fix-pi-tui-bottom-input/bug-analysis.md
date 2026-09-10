# Bug Analysis: Pi 全屏 TUI 底部输入框被外部 advisory 覆盖

## 1. Root Cause Category

- **Category**: B / E — Cross-Layer Contract / Implicit Assumption。
- **Specific Cause**: Pi 全屏渲染器与 `pi-mcp-adapter` 的 `console.warn` 都把内容写入同一个 PTY。CLI-Manager 的后端按字节转发，前端将合并后的 stderr 当作普通 xterm 输出写入；外部 advisory 因此从当前光标位置进入 Pi composer，破坏底部输入框。

## 2. Why Fixes Failed

本次没有提交过症状补丁。早期可行但未采用的方向包括触发 resize 重绘、修改 Pi 配置关闭 direct tools，以及在 PTY 层拆分 stderr；这些方向分别会引入布局时序副作用、改变用户能力或破坏现有跨平台传输契约，不能解决“外部文本绕过 fullscreen renderer”的根因。

## 3. Prevention Mechanisms

| Priority | Mechanism | Specific Action | Status |
|---|---|---|---|
| P0 | Documentation | 在终端组件、跨层和跨平台规范中记录 merged PTY + fullscreen TUI 的边界。 | DONE |
| P0 | Test Coverage | 对已确认 advisory 做全切点分帧测试，并覆盖重复、相邻普通文本、非匹配文本、非 Pi 和 reset。 | DONE |
| P1 | Architecture | 将诊断处理放在已有 Pi 共享输出转换边界，保持 PTY manager 与 ACK 契约不变。 | DONE |
| P1 | Code Review | 检查匹配器是否有界、是否只匹配完整 advisory、是否误伤普通 `MCP:` 文本。 | DONE |

## 4. Systematic Expansion

- **Similar Issues**: 其他 CLI 或扩展也可能通过 stdout/stderr 输出启动诊断；排查 fullscreen、alternate-buffer 和 inline renderer 是否共享 xterm 光标时，应先确认输出来源。
- **Design Improvement**: CLI-specific output compatibility 应继续作为处理外部终端协议和显示兼容行为的边界；PTY 层维持透明传输。
- **Process Improvement**: 终端 bug 需要同时检查 PTY 合流、帧切分、实时批处理、回放/恢复和 Windows/WSL 换行，而不是只检查可见组件布局。

## 5. Knowledge Capture

- [x] 更新 `.trellis/spec/frontend/component-guidelines.md`。
- [x] 更新 `.trellis/spec/guides/cross-layer-thinking-guide.md`。
- [x] 新增并更新 `.trellis/spec/guides/cross-platform-thinking-guide.md` 及索引。
- [ ] 同步到 `src/templates/markdown/spec/`：仓库当前不存在该模板目录，因此没有可同步的副本。
