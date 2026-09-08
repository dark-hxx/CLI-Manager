# Additional Platform Candidates

调研日期：2026-07-14。

## Confirmed V1.2.8 Scope

用户已确认 V1.2.8 一次性内置以下 10 个平台，并提供受限的 Custom HTTP：

- 钉钉、飞书、企业微信、Bark、PushPlus。
- WxPusher、Server酱、Telegram、ntfy、Gotify。
- Custom HTTP：GET/POST、query、headers、JSON/form/text body、固定变量替换。

这个范围已经覆盖国内协作、国内个人微信、海外个人/群组、自托管和隐私场景。首版不再继续扩平台，优先保证 daemon 后台派发、敏感信息保护和失败隔离。

## Additional Candidates After V1.2.8

| Platform | Audience | Integration Shape | Recommendation |
| --- | --- | --- | --- |
| Slack Incoming Webhooks | 企业协作 | Webhook + Slack JSON | 有明确用户需求时新增轻量 Adapter |
| Discord Webhooks | 开发者社区 | Webhook + `content`/embeds | 有明确用户需求时新增轻量 Adapter |
| Pushover | 商业个人推送 | app token + user/group key | 稳定但收费，需求优先级低于现有平台 |
| PushDeer | 国内个人/自托管 | push key + message API | 与 Bark/WxPusher 重叠，按 issue 驱动 |
| Mattermost / Rocket.Chat | 自托管协作 | Incoming Webhook | 可由 Custom HTTP 先覆盖常见场景 |

## Not Recommended For Initial Built-Ins

- Microsoft Teams：Incoming Webhook/Connector 正在向 Workflows 迁移，接口生命周期不够稳定。
- SMTP 邮件：不是 Webhook，涉及账号、TLS、认证和垃圾邮件策略，应作为独立功能。
- 短信、语音：通常收费且需要供应商账号，不属于 Hook 通知首版范围。
- Matrix/Web Push：用户需求未知，先由 issue 驱动。

Slack、Discord、Mattermost、Rocket.Chat 应按实际用户需求逐个增加轻量 Adapter，不引入任意模板引擎。

## Sources

- WxPusher: https://wxpusher.zjiecode.com/docs/
- Telegram Bot API: https://core.telegram.org/bots/api#sendmessage
- ntfy publish API: https://docs.ntfy.sh/publish/
- Gotify push messages: https://gotify.net/docs/pushmsg
- Slack incoming webhooks: https://api.slack.com/messaging/webhooks
- Discord execute webhook: https://discord.com/developers/docs/resources/webhook#execute-webhook
- Pushover Message API: https://pushover.net/api
- Server酱: https://sct.ftqq.com/sendkey
