# 原生供应商模型获取与协议标记调整

## Changelog Target

`[TEMP]`

## Goal

让原生 Claude、Codex、Grok 供应商表单提供统一的“从供应商接口获取模型”能力，明确 API 格式/上游格式只是协议标记，并修正完整 URL语义，减少手工填写模型映射和请求模型的错误。

## Confirmed Facts

- 当前 Claude 新增/编辑表单在 `NativeClaudeConfigSection` 展示 API 格式、认证字段、完整 URL和模型映射；Codex/Grok 在共享高级配置中展示上游格式、模型映射和两个尚未接入运行时的开关。
- `isFullUrl` 已进入 Claude 配置模型并持久化，但当前任务需要明确其运行时语义：启用后使用用户填写的完整 endpoint，不再追加 `/v1`、`/messages` 等固定路径。
- 当前代码没有原生供应商模型列表 IPC；模型价格同步接口不能直接复用，因为它读取公共价格源，不读取供应商 endpoint，也不应暴露供应商密钥。
- `NativeProviderFormModal` 的模型映射由 Claude/共享高级配置组件管理，映射保存到 provider `settings_config`。

## Requirements

1. API 格式字段继续展示并保存为协议标记，作为后续本地统一网关/自动转换的扩展位；当前版本不根据该标记执行路由或格式转换，已有值不得丢失。
2. Codex/Grok 的上游格式同样只是协议标记；当前版本不因该字段改变请求链路。
3. 完整 URL开关语义明确并本地化：开启时按用户提供的完整 URL 请求，不拼接固定 API 路径；关闭时沿用当前 CLI/协议的标准路径拼接规则。
4. Claude、Codex、Grok 三类模型映射区域均增加“获取模型”操作：使用当前供应商 endpoint 和当前活动 Key 请求模型列表，按各类型认证/协议构造请求，解析常见 OpenAI-compatible `data[].id` 及兼容响应形状，去重排序后供映射目标选择。
5. 获取模型失败、无 Key、无 endpoint、HTTP 非成功、响应格式不支持时，显示中英文错误，不泄漏 URL 中的密钥或响应中的敏感字段。
6. 获取结果只进入当前表单草稿，不自动保存 provider；用户明确选择后再写入模型映射。
7. 新增文案、按钮、加载态、错误态和无结果态同时支持 `zh-CN` 与 `en-US`。
8. Goal mode/远程压缩在没有对应运行时协议前不再作为“已支持功能”展示；旧配置仍兼容读取，后续协议落地时可恢复控件。

## Current Behavior Audit

- `goalMode` 和 `remoteCompression` 目前只在前端高级配置中读写，并随 `settings_config.advanced` 持久化；仓库没有任何运行时消费者，因此打开后不会改变请求、启动参数或全局 writer 行为。
- 外部资料核查受当前网络工具 500/超时影响，未能取得 cc-switch/Grok 官方源码页面；本地代码也未发现 Grok 对 Goal mode 或远程压缩的协议字段。当前生成的 Grok TOML 只包含 `api_backend`、`context_window`、model 和 `base_url`，因此不能宣称这两个开关对 Grok 已生效。
- 在没有明确 Grok 协议字段和运行时消费者前，Goal mode/远程压缩不应作为本次修复的功能承诺；应移除误导性开关或标记为未实现，保留数据兼容读取。

## Acceptance Criteria

- [ ] Claude、Codex、Grok 表单保留 API 格式/上游格式标记；编辑旧供应商后保存，标记值仍保持兼容。
- [ ] 完整 URL开关的帮助文案明确说明“是否追加标准路径”，并覆盖开/关两种请求行为。
- [ ] 三类供应商点击获取模型后显示加载态；成功时可将返回模型选择到映射目标；重复模型不会重复显示。
- [ ] 覆盖无活动 Key、endpoint 为空、401/403、非 JSON、空列表和网络超时错误。
- [ ] 模型获取不会持久化草稿外的任何数据，不在日志/toast 中显示密钥。
- [ ] `npx tsc --noEmit`、Rust 格式/检查/相关测试和 i18n parity 通过。

## Out of Scope

- 不实现模型健康检查、价格同步、自动选择或自动保存。
- 不实现 Goal mode 或远程压缩的运行时协议，仅处理误导性 UI 和旧配置兼容。

## Scenario Matrix

- 供应商类型：Claude / Codex / Grok。
- 表单状态：新增草稿 / 编辑已有供应商 / 切换供应商 / 关闭后重新打开。
- Key 状态：有活动 Key / 无 Key / 活动 Key 被禁用。
- Endpoint 状态：标准 Base URL / 已包含完整路径 / 空值 / 非法 URL。
- 请求结果：成功 / 401-403 / 4xx-5xx / 超时 / 非 JSON / 空列表 / 重复模型。
- 交互状态：首次获取 / 重复获取 / 获取中切换 CLI 类型 / 获取后未保存直接关闭。
