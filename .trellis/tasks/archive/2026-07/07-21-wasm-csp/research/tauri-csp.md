# Tauri CSP 与 WebAssembly

## 结论

Tauri 2 官方文档说明：前端使用 WebAssembly 时，应在 CSP 的 `script-src` 中加入 `'wasm-unsafe-eval'`。

## 约束映射

- 当前配置只有 `script-src 'self'`，会拒绝 `WebAssembly.instantiate()`。
- 使用 `'wasm-unsafe-eval'` 比通用 `'unsafe-eval'` 权限更小，符合项目安全边界。
- Tauri release 构建会自动向 CSP 注入资源 hash；不应关闭该行为。

## 来源

- Tauri 2 CSP：https://v2.tauri.app/security/csp
- Tauri 2 配置参考：https://v2.tauri.app/reference/config
