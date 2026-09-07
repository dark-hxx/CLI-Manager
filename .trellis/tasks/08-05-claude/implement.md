# 实施清单

1. [x] 读取 frontend/backend provider contracts，确认 command 注册和错误码规范。
2. [x] 设计并实现 Rust `provider_fetch_models` command：URL、认证、超时、响应解析、错误码和单元测试。
3. [x] 接入 Tauri command 注册与前端类型/调用封装。
4. [x] 扩展 Claude、Codex、Grok 模型映射组件，统一获取模型交互和草稿写入。
5. [x] 修正完整 URL帮助文案及实际 endpoint 构造；保持 API 格式/上游格式为标记。
6. [x] 处理 Goal mode/远程压缩无运行时实现的 UI 表达，保留旧配置兼容。
7. [x] 补齐 zh-CN/en-US 文案、错误态、加载态、空态和可访问性标签。
8. [x] 运行定向 Node/Rust 测试、`npx tsc --noEmit`、格式检查和 i18n parity。
9. [ ] 手动验证三类供应商、完整 URL、无 Key、失败响应和未保存关闭场景。
