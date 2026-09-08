# Universal Notification Solutions

调研日期：2026-07-14。

## WebSearch Findings

### Apprise

- Python 项目，BSD-2-Clause。
- 2026-07-04 发布 v1.12.0，GitHub 约 16.9k stars。
- 通过统一的服务 URL 表示目标，例如 `bark://`、`dingtalk://`、`feishu://`、`wecombot://`、`pushplus://`。
- 已直接支持本 issue 的五个平台，也支持 Telegram、Discord、Slack、Gotify、ntfy、Pushover、Mattermost、Teams Workflows 等大量服务。
- 自定义目标支持 JSON、form、HTTP method、query、headers、Basic Auth、超时、重试和字段重映射。

Apprise API 是独立 HTTP 网关，2026-07-04 发布 v1.5.1。它提供 `/notify/` 统一入口，接收 `title`、`body`、`type`、`format` 和一个或多个 Apprise URLs，可转发到 130+ 服务。

### Shoutrrr

- Go 项目，MIT，稳定版 v0.8.0。
- 同样使用服务 URL，例如 `bark://devicekey@host`、`telegram://`、`slack://`、`ntfy://`。
- Generic Webhook 支持 POST、JSON、字段名映射、额外 JSON 字段、headers 和转发 query。
- 官方文档明确指出：通用 POST 只有接收端理解 payload 时才有效，不能自动兼容所有第三方 API。

### Rust Ecosystem

- crates.io 存在 `shoutrrr 0.1.0` Rust 移植版，但截至 2026-07 仅约 38 次下载，只实现 Slack、Discord 和 Generic Webhook。
- 尚未覆盖钉钉、飞书、企业微信、Bark、PushPlus，成熟度不足，不应作为生产依赖。

### CloudEvents

CloudEvents 提供厂商无关事件信封，核心字段包括 `specversion`、`id`、`source`、`type`、`time` 和 `data`。它适合 Custom Webhook 的标准输出格式，但钉钉、飞书等平台不能直接接收 CloudEvents，仍需要转换 Adapter。

## Answer To “Is It Just URL + Parameters?”

传输层基本都是 HTTP 调用，但协议并不相同：

- method：GET、POST、PUT。
- credential：URL path、query、header、Basic/Bearer、JSON body。
- content type：JSON、form-urlencoded、text/plain。
- signature：钉钉和飞书算法、时间单位、参数位置不同。
- payload：`msgtype`、`msg_type`、`content`、`body` 等字段结构不同。
- success：HTTP 2xx、`errcode == 0`、`code == 0/200` 或异步受理。

所以通用方案不是“只存一个 URL”，而是“统一 HTTP 请求描述 + 平台 Preset + 少量特殊签名/响应插件”。

## Recommended Native Design

### 1. Common Message

- `title`
- `body`
- `event`
- `source`
- `project`
- `time`
- `id`

### 2. HTTP Profile

- `method`: MVP 建议 `POST | GET`。
- `url`: 支持固定 URL 和受控变量替换。
- `query`: key/value 列表。
- `headers`: key/value 列表，敏感值单独标记。
- `bodyType`: `json | form | text | cloudevents`。
- `bodyTemplate`: 结构化 JSON/form 字段，不是可执行脚本。
- `successRule`: HTTP 状态范围 + 可选 JSON path/value 判断。
- `signer`: `none | dingtalk | feishu`，后续按需扩展。

允许的模板变量固定为：

- `{{title}}`
- `{{body}}`
- `{{event}}`
- `{{source}}`
- `{{project}}`
- `{{time}}`
- `{{id}}`

不支持条件、循环、函数、JavaScript、Shell 或任意表达式。

### 3. Provider Presets

内置平台本质上是预填并锁定关键规则的 HTTP Profile：

- DingTalk：JSON body + query token + DingTalk signer + `errcode == 0`。
- Feishu：JSON body + Feishu signer + `code == 0`。
- WeCom：JSON body + query key + `errcode == 0`。
- Bark：JSON body + device key + `code == 200`。
- PushPlus：JSON body + token + `code == 200`，标记为异步 accepted。

后续增加 Slack、Discord、Telegram、ntfy 等，优先新增数据化 Preset；只有签名或复杂响应才写少量代码。

## Apprise API Gateway Assessment

接入 `Apprise API` 需要：

- 用户通过 Docker 或 Python 独立部署并持续运行 Apprise API。
- 配置持久化目录、端口、升级、日志、健康检查和备份。
- 如果跨机器访问，还需要 TLS、访问认证、防火墙或反向代理。
- Webhook/token 等凭证改由 Apprise 存储和保护。
- CLI-Manager 仍需增加网关地址、认证、测试连接和错误处理 UI。

优点：平台覆盖极广，CLI-Manager 维护成本低。

缺点：需要额外服务；凭证交由 Apprise 管理；离线桌面用户使用门槛较高。

结论：它没有消除复杂度，只是把复杂度移到 CLI-Manager 之外。V1.2.8 不内置、不捆绑，也不要求用户部署 Apprise API。

若高级用户已经自行运行 Apprise API，可将它视为普通 Custom HTTP 目标；CLI-Manager 不为其增加专用功能。

## Rejected Options

- 直接嵌入 Apprise：需要 Python 运行时和大量依赖，不适合 Tauri 桌面包。
- 捆绑 Shoutrrr CLI：引入额外 Go 二进制，且不覆盖本 issue 的主要国内平台。
- 使用当前 Rust `shoutrrr` crate：功能和成熟度不足。
- 完全开放脚本模板：安全、调试和兼容成本不可控。
- 为每个平台复制一套完整 HTTP 逻辑：重复代码多，新增平台成本高。

## Sources

- Apprise: https://github.com/caronc/apprise
- Apprise services: https://appriseit.com/services/
- Apprise JSON custom notification: https://appriseit.com/services/json/
- Apprise form custom notification: https://appriseit.com/services/form/
- Apprise API: https://github.com/caronc/apprise-api
- Shoutrrr: https://github.com/containrrr/shoutrrr
- Shoutrrr services: https://containrrr.dev/shoutrrr/v0.8/services/overview/
- Shoutrrr Generic Webhook: https://containrrr.dev/shoutrrr/v0.8/services/generic/
- Rust shoutrrr port: https://github.com/connyay/shoutrrr-rs
- CloudEvents specification: https://github.com/cloudevents/spec
