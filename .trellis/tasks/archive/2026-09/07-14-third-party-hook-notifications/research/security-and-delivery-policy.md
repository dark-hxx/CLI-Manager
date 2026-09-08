# Security And Delivery Policy

## Secret Handling

以下值都视为凭证：完整 webhook URL、access token、query key、device key、PushPlus token、signing secret、Authorization header。

- UI 使用密码输入或脱敏展示；编辑时允许替换，不在普通列表展示明文。
- 日志只记录 provider、target id、脱敏 host、错误类别和业务码。
- 禁止记录完整 URL、query、headers、请求 body 和响应中的潜在敏感字段。
- URL 日志脱敏复用 `command_suggestion.rs` 的做法：去除 username/password/query/fragment。
- 设置文件当前已有 API key 明文持久化先例。MVP 可保持一致，但 PRD/文案不得把“遮罩”描述成“加密存储”。

## Data Minimization

远程通知比本地 OS 通知风险更高。默认只发送摘要：

- CLI 来源。
- 项目显示名。
- 事件类型。
- 发生时间。

默认不发送完整 `payload.message`。`UserPromptSubmit` 默认关闭，避免把 Prompt 外发。未来若增加“包含详细内容”，必须单独显式 opt-in，并清楚提示隐私风险。

## URL And Network Validation

- 只接受 `http` 和 `https`，拒绝其他 scheme、空 host 和 URL 内嵌用户名/密码。
- DingTalk、Feishu、WeCom、PushPlus 默认要求 HTTPS。
- Bark、ntfy、Gotify 和 Custom 为兼容 localhost / 局域网自建服务，可允许 HTTP，但 UI 必须提示明文传输风险。
- 禁止自动跟随重定向，避免凭证或敏感 header 被转发到其他 host。
- 对 Custom headers 设置数量和长度上限，并过滤 hop-by-hop headers。

桌面应用的 Custom Webhook 本身就是用户授权访问目标网络，因此不应简单封禁 localhost 或私网地址；重点是明确提示、禁重定向和防日志泄漏。

## Timeouts And Limits

建议：

- connect timeout: 3 秒。
- total request timeout: 5 秒。
- response body: 最大 64 KiB。
- request message: 先按平台限制截断；统一摘要控制在 2 KiB 以内。
- targets per event: 最大 20 个。

第三方发送必须在有界后台 worker 中执行，不能阻塞 Hook bridge sink、daemon 状态更新、App listener 或窗口关闭流程。队列满时丢弃并记录脱敏 warning，不等待。

## Retry Policy

MVP 建议不自动重试。

原因：

- Hook 通知不是关键事务。
- 网络超时后平台可能已经收到了消息，盲重试会重复。
- DingTalk/WeCom 配额只有 20 条/分钟。
- PushPlus 相同内容存在重复限制，且成功响应只是异步受理。

后续若实现重试，只能处理明确的网络失败、429 和 5xx，使用有限指数退避和稳定幂等键；签名、关键词、配置和其他业务错误不得重试。

## Success Rules

- DingTalk: HTTP 成功且 `errcode == 0`。
- Feishu: HTTP 成功且 `code == 0`。
- WeCom: HTTP 成功且 `errcode == 0`。
- Bark: HTTP 成功，并在有标准 JSON 时要求 `code == 200`。
- PushPlus: HTTP 成功且 `code == 200`，结果标记为 `accepted`，保留流水号。
- WxPusher: HTTP 成功且 `code == 1000`。
- Server酱: HTTP 成功且 `code == 0`。
- Telegram: HTTP 成功且 `ok == true`。
- ntfy: HTTP 2xx 且响应存在 `id`。
- Gotify: HTTP 200 且响应存在数值 `id`。
- Custom: 任意 2xx 视为 `accepted`。

## Test Send

- 使用固定测试摘要，不读取当前 Prompt 或终端内容。
- 测试结果展示 provider、耗时、业务码和脱敏 message。
- 关键词校验、签名失败、时钟漂移和限流错误必须可见。
- 不显示或复制完整凭证。

## Failure Isolation

- 自动发送失败仅记脱敏 warning。
- 不修改 tab 状态。
- 不阻断 app toast。
- 不阻断 OS notification。
- 不改变 Hook CLI 的退出码。
