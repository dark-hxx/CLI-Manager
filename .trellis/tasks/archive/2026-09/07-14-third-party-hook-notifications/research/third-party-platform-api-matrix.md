# Third-Party Platform API Matrix

调研日期：2026-07-14。

`PP` 已由用户确认指 PushPlus。

## Matrix

| Provider | Credential / Signature | Minimal Request | Business Success | Important Limits |
| --- | --- | --- | --- | --- |
| DingTalk | Webhook query `access_token`；可选关键词、IP、签名。签名使用毫秒时间戳，`HMAC-SHA256(secret, timestamp + "\n" + secret)`，Base64 后放入 URL query | `POST` JSON：`msgtype=text` + `text.content` | `errcode == 0` | 每机器人 20 条/分钟；超限后限流 10 分钟；签名时间误差不超过 1 小时 |
| Feishu | Webhook URL 本身是凭证；可选关键词、IP、签名。签名使用秒时间戳，把 `timestamp + "\n" + secret` 作为 HMAC key，对空字节串签名，Base64 后放 JSON body | `POST` JSON：`msg_type=text` + `content.text` | `code == 0` | 单租户单机器人 100 次/分钟、5 次/秒；请求体不超过 20 KB；签名时间误差不超过 1 小时 |
| WeCom | Webhook query `key`，完整 URL 即凭证 | `POST` JSON：`msgtype=text` + `text.content` | `errcode == 0` | 每机器人 20 条/分钟；text 2048 字节；markdown 4096 字节 |
| Bark | `device_key`；可使用官方或自建 server；自建 server 可另加 Basic Auth | 推荐 `POST {baseUrl}/push` JSON：`device_key`、`title`、`body` | HTTP 成功且 Bark `code == 200` | 官方文档未承诺统一频率；必须允许自定义 base URL，不能写死 `api.day.app` |
| PushPlus | `token`；可选 channel/template/topic/option | 推荐 HTTPS `POST /send` JSON：`token`、`title`、`content`、`template`、`channel` | `code == 200` 仅表示异步受理，`data` 为流水号 | 普通实名用户 5 次/分钟；相同内容 1 小时最多 3 条；具体日额度随 channel/会员变化 |
| WxPusher | SPT；或标准模式 `appToken + UID/Topic` | SPT：`POST /api/send/message/simple-push`；标准模式：`POST /api/send/message` | HTTP 200 且 `code == 1000` | 正文最多 40000 字符；约 2 QPS；单次最多 10 个 SPT |
| Server酱 | SendKey；`sctp` 前缀为 SC3，其余为 Turbo | SC3：`POST https://{sendKey}.push.ft07.com/send`；Turbo：`POST https://sctapi.ftqq.com/{sendKey}.send`；JSON `title/desp` | `code == 0` | Turbo 标题 32 字符、正文 32 KB；IP 每日 API 上限 1000 次 |
| Telegram | Bot Token 位于 URL，另配 `chat_id`，可选 `message_thread_id` | `POST https://api.telegram.org/bot{token}/sendMessage` JSON：`chat_id/text` | `ok == true`，可取 `result.message_id` | text 1–4096 字符；单聊天通常约 1 条/秒；429 返回 `retry_after` |
| ntfy | topic；可匿名、Basic 或 Bearer；必须允许自定义 server | `POST {baseUrl}/` JSON：`topic/message/title` | HTTP 2xx 且响应存在 `id` | 消息 4096 字节；ntfy.sh 免费额度当前为每日 250 条 |
| Gotify | 自建 server + application token，推荐 `X-Gotify-Key` header | `POST {baseUrl}/message` JSON：`message/title/priority` | HTTP 200 且响应存在数值 `id` | 没有官方公共云；官方未定义统一消息长度或频率 |

## Non-Unifiable Differences

- 钉钉签名在 query，毫秒时间戳；飞书签名在 body，秒时间戳，HMAC 输入也不同。
- 群机器人、Bark 设备和 PushPlus 聚合账户不是同一种收件人模型。
- WxPusher 同时存在个人 SPT 与 appToken + UID/Topic 两种模式。
- Server酱会根据 SendKey 前缀切换 SC3/Turbo 域名和路径。
- ntfy 的 JSON 发布请求发送到 server 根路径，topic 位于 JSON；Gotify 必须由用户自行部署服务。
- HTTP 2xx 不代表业务成功；所有内置 Provider 必须解析业务码。
- PushPlus 的成功是 `ACCEPTED`，不是最终 `DELIVERED`。
- Bark 自建服务可能使用 HTTP、局域网地址或 Basic Auth。
- 平台富文本、卡片、@ 人和跳转能力差异过大，不应进入统一 MVP 模型。

## Recommended MVP Payloads

- DingTalk：使用 `text`，后续再考虑 markdown。
- Feishu：使用 `text`。
- WeCom：使用 `text`。
- Bark：使用 `/push` JSON，支持可选 `group`、`sound`、`level`。
- PushPlus：使用 `template=txt` 或 `markdown`，默认 channel 由用户选择。
- WxPusher：同时支持 SPT 与标准模式，内容使用纯文本。
- Server酱：自动识别 SC3/Turbo，使用 JSON `title/desp`。
- Telegram：使用纯文本，不启用 Markdown，避免转义歧义。
- ntfy：使用 JSON publish，支持自定义 server、topic 和可选认证。
- Gotify：使用 application token header 和 JSON message。

统一先保证纯文本摘要稳定送达，避免 V1 同时维护十套富文本渲染。

## Official Sources

- Issue #134: https://github.com/dark-hxx/CLI-Manager/issues/134
- DingTalk send API: https://open.dingtalk.com/document/development/custom-robots-send-group-messages.md
- DingTalk security: https://open.dingtalk.com/document/dingstart/customize-robot-security-settings.md
- DingTalk webhook: https://open.dingtalk.com/document/dingstart/obtain-the-webhook-address-of-a-custom-robot.md
- Feishu custom bot: https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot.md
- WeCom group robot: https://developer.work.weixin.qq.com/document/path/91770
- Bark client usage: https://github.com/Finb/Bark
- Bark server API V2: https://github.com/Finb/bark-server/blob/master/docs/API_V2.md
- PushPlus API V1.14: https://www.pushplus.plus/doc/guide/api.html
- PushPlus limits: https://www.pushplus.plus/doc/help/limit.html
- WxPusher API: https://wxpusher.zjiecode.com/docs/api-reference.html
- WxPusher SPT: https://wxpusher.zjiecode.com/docs/spt.html
- Server酱 SDK: https://github.com/easychen/serverchan-sdk
- Server酱 SC3: https://sc3.ft07.com/doc
- Telegram Bot API: https://core.telegram.org/bots/api#sendmessage
- Telegram limits: https://core.telegram.org/bots/faq#my-bot-is-hitting-limits-how-do-i-avoid-this
- ntfy publish API: https://docs.ntfy.sh/publish/
- Gotify push messages: https://gotify.net/docs/pushmsg
- Gotify API: https://gotify.net/api-docs
