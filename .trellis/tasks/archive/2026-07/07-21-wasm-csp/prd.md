# 修复终端图片插件 WASM CSP 崩溃

## Goal

修复 Windows WebView2 中创建终端时，`@xterm/addon-image` 初始化 WebAssembly 解码器被 CSP 拒绝，导致终端初始化产生未处理 Promise 拒绝的问题。

## Requirements

- 在 Tauri CSP 的 `script-src` 中仅增加 `'wasm-unsafe-eval'`，不得放开通用 `'unsafe-eval'`。
- `ImageAddon` 加载失败时必须安全降级，终端继续使用基础渲染能力。
- 降级必须记录告警，便于区分 CSP、WebAssembly 或图片插件兼容性问题。
- 不修改 PTY、Claude 会话恢复、WebGL 渲染策略或图片协议的正常行为。
- Changelog Target: `[TEMP]`。

## Acceptance Criteria

- [x] CSP 包含 `'wasm-unsafe-eval'`，其余安全策略保持不变。
- [x] `terminal.loadAddon(imageAddon)` 的同步异常不会逃逸为未处理异常。
- [x] 图片插件加载失败后，终端仍完成初始化。
- [x] 图片插件成功加载时，现有 SIXEL/IIP/Kitty 图片能力保持不变。
- [x] 针对性测试和 TypeScript 类型检查通过。

## Technical Approach

- 在 `src-tauri/tauri.conf.json` 精确增加 Tauri 官方建议的 `'wasm-unsafe-eval'`。
- 在 `XTermTerminal` 的图片插件加载点增加局部异常降级和结构化告警，不扩大 WebGL 的异常处理范围。
- 增加静态回归测试，防止 CSP 权限或图片插件降级保护被误删。

## Decision (ADR-lite)

**Context**：图片插件内部使用 WebAssembly；当前 CSP 禁止编译，且图片插件加载点不在 WebGL 的 `try/catch` 内。

**Decision**：同时修复 CSP 能力声明和图片插件失败降级。CSP 恢复正常图片能力，局部降级覆盖旧 WebView2 或其他运行时兼容异常。

**Consequences**：允许应用自身加载的 WebAssembly，但不允许任意 JavaScript eval；图片插件异常时仅损失终端图片显示，不影响基础终端。

## Out of Scope

- 不升级 xterm、Tauri 或 WebView2 依赖。
- 不修改硬件加速和主题策略。
- 不处理与本次日志无关的终端问题。

## Technical Notes

- Tauri 2 官方 CSP 文档明确要求使用 WebAssembly 的前端在 `script-src` 中加入 `'wasm-unsafe-eval'`。
- 日志中的两次错误均发生在 `terminal.session_create`，且启动不同 Claude 会话，排除具体会话内容和 PTY 命令为直接根因。
- `@xterm/addon-image` 的 IIP 解码器构造阶段创建 WASM 解码器；`ImageAddon.activate()` 由 `terminal.loadAddon(imageAddon)` 触发。
