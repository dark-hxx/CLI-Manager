# Generic Webhook Contract Proposal

## Decision

采用三层结构：

1. `HookNotificationMessage`：平台无关的通知摘要。
2. `ProviderAdapter`：平台配置校验、签名、请求体映射、业务响应解析。
3. `HttpExecutor`：统一的 reqwest client、超时、响应限长和错误分类。

不要用一个任意 JSON 模板强行兼容所有平台。动态签名、响应业务码和异步送达语义仍然必须由 Adapter 处理。

## Common Message

建议字段：

- `event`: 现有 `HookEventType`。
- `source`: `claude | codex`。
- `projectName`: tab title 或 cwd basename，不发送绝对路径。
- `title`: 稳定标题，例如 `CLI-Manager`。
- `body`: 本地化后的摘要。
- `occurredAt`: RFC 3339 时间。
- `targetUrl`: 可选，未来用于 Bark 或通用 webhook 点击跳转；MVP 可不提供。

禁止默认包含：

- Prompt 原文。
- 完整 `payload.message`。
- 终端输出、transcript、tool arguments。
- session token、API key、环境变量。
- 完整 cwd 绝对路径。

## Persisted Target Model

使用带 `provider` 判别字段的联合类型，避免一个巨型对象里堆积大量 nullable 字段。

公共字段：

- `id`
- `name`
- `provider`
- `enabled`
- `events: Record<HookEventType, boolean>`

Provider 配置：

- DingTalk：`webhookUrl`、可选 `signingSecret`。
- Feishu：`webhookUrl`、可选 `signingSecret`。
- WeCom：`webhookUrl`。
- Bark：`baseUrl`、`deviceKey`、可选 Basic Auth、group/sound/level。
- PushPlus：`token`、channel/template/topic/option。
- WxPusher：`mode` + SPT，或 appToken + uids/topicIds。
- Server酱：`sendKey`，按 `sctp` 前缀自动识别 SC3/Turbo。
- Telegram：`botToken`、`chatId`、可选 `messageThreadId`。
- ntfy：`serverUrl`、`topic`、可选 Basic/Bearer、priority/tags。
- Gotify：`serverUrl`、`appToken`、可选 priority。
- Custom：method、URL、query、headers 和 body 配置。

Custom HTTP MVP 约束：

- 只允许 `GET`、`POST`。
- 支持 query、headers、JSON/form/text body；GET 禁止 body。
- 固定变量为 `title/body/event/source/project/time/id`。
- JSON 必须先解析为结构，再只替换字符串叶子，不能直接拼接 JSON 字符串。
- 不提供条件、循环、函数、脚本、表达式或任意代码执行。
- 自定义 header 禁止覆盖 `Host`、`Content-Length`、`Transfer-Encoding`、`Connection`。
- 不支持动态 HMAC；需要签名的平台必须使用内置 Adapter。
- Custom HTTP 仅以任意 2xx 判定 accepted，不开放可执行响应规则。

## Dispatch Result

统一结果至少包含：

- `status: accepted | failed`
- `provider`
- `targetId`
- `providerCode?`
- `providerMessage?`
- `deliveryId?`

`accepted` 只表示平台已接受请求。MVP 不声称消息已在群聊或设备上展示。

## Dispatch Policy

- 进程内 bridge sink 与 daemon sink 各自持有 dispatcher；只有实际收到 Hook 的 sink 执行 enqueue。
- daemon 广播到前端后，前端不得再次派发第三方通知。
- sink enqueue 必须非阻塞；远程 HTTP 在有界后台 worker 中执行。
- worker 从现有 `settings.json` 读取已启用且命中事件筛选的目标，解析失败时跳过本次，不 panic、不清空配置。
- 多目标可并发发送，但应限制单次目标数量，建议最多 20 个。
- 单个 Hook job 的网络并发建议固定为 4。
- 单目标失败不取消其他目标。
- 自动触发不弹失败 toast，避免网络故障刷屏；仅记录脱敏 warning。
- “测试发送”返回详细、脱敏的 Provider 结果并由 UI 展示。

## Why Rust Owns HTTP

- 已有 reqwest/rustls 和响应限长范式。
- 避免 WebView CORS、浏览器网络策略和前端日志泄漏。
- 签名与业务响应解析可以单元测试。
- 保持所有远程请求在一个模块内，便于统一超时和脱敏。

配置仍由现有 `settingsStore` 持久化到 `settings.json`。daemon 与主进程 worker 按事件读取或按 mtime 缓存该字段，无需新增后端配置数据库。

测试发送由前端 invoke 独立 command，但必须复用相同的 Adapter 和 HttpExecutor，不能另写第二套请求逻辑。
