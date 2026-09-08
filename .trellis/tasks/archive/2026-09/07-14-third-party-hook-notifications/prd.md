# 支持第三方 Hook 通知

## Status

- Phase: in_progress
- Issue: https://github.com/dark-hxx/CLI-Manager/issues/134
- Changelog Target: V1.2.8
- Requirement quality: approved

## Goal

在现有 Claude Code / Codex Hook 通知链路上增加第三方通知目标，让用户可以把任务完成、失败、待审批等事件发送到外部平台，同时不影响应用内通知、系统通知和终端状态更新。

## Requirements

### Confirmed From Issue

- 设置入口位于 Hook 模块。
- 内置支持钉钉、飞书、企业微信、Bark 和 PushPlus（issue 中的 `PP` 已由用户确认指 PushPlus）。
- 设计应尽量通用，避免每个平台形成一套互不相干的发送逻辑。
- 目标版本为 V1.2.8。

### Confirmed By User

- 使用适配器模式，在 Hook 模块增加独立的“三方 Hook 通知”配置区域。
- 用户可以配置多种通知方式，也可以为同一或不同平台配置多组通知目标。
- CLI-Manager 接收到并校验 Hook 事件后，再异步批量调用所有已启用且命中事件筛选的目标。
- 第三方网络请求不得阻断 Hook 处理、主程序、daemon 状态更新或本地通知。
- 除原五个平台外，首版同时内置 WxPusher、Server酱、Telegram、ntfy、Gotify。
- 增加自定义 HTTP 通知方式，按照用户配置的 URL、参数、headers 和 body 调用。

### Confirmed MVP

- 使用“统一 Hook 通知事件 + Provider Adapter + 通用 HTTP 执行器”。
- 支持多个独立通知目标，同一平台可配置多个实例。
- 每个目标可独立启用，并复用现有六类 `HookEventType` 进行事件筛选。
- 内置适配器：DingTalk、Feishu、WeCom、Bark、PushPlus、WxPusher、ServerChan、Telegram、ntfy、Gotify。
- 提供 Custom HTTP Adapter：支持 GET/POST、query、headers、JSON/form/text body 和固定变量替换，不引入脚本或任意表达式执行。
- 提供“测试发送”，展示脱敏后的平台业务错误。
- 默认只发送 CLI、项目名、事件和时间等摘要；不外发完整 Prompt、终端输出、绝对路径或转录内容。
- 远程通知文案可以适量使用 emoji 优化可读性，但仍只发送摘要，不扩大敏感信息范围。
- 第三方发送异步、失败隔离，不得阻塞或改变现有 Hook、本地 toast、系统通知和终端状态行为。
- 第三方派发由实际接收 Hook 的主进程 bridge 或 daemon 唯一负责；前端只显示本地通知，避免重复发送。
- 当 CLI-Manager 窗口已退出但后台 daemon 仍托管任务时，第三方通知仍应实时发送。
- 批量发送使用有界异步队列和受限并发；单个目标失败不取消其他目标。
- MVP 不自动重试，避免网络超时后的重复通知和平台限流。

### Out Of Scope For MVP

- 平台富文本卡片设计器。
- @ 指定成员、群成员查询或机器人双向交互。
- 任意 JavaScript、Shell 或表达式模板。
- 可靠消息队列、持久化重试和“设备已展示”级送达确认。
- 从外部平台回跳并精准激活 CLI-Manager 会话。
- 内置、捆绑或要求用户部署 Apprise API 等独立通知网关。

## Acceptance Criteria

- [x] 用户可在 Hook 设置页新增、编辑、启停、删除和测试第三方通知目标。
- [x] 用户可同时保存并启用多组目标，同一 Hook 事件会异步分发到所有匹配目标。
- [x] 内置平台能生成各自正确的鉴权、请求体和成功判定，不能把 HTTP 2xx 直接视为业务成功。
- [x] 每个目标可配置事件筛选；默认建议启用 `Notification`、`Stop`、`StopFailure`、`PermissionRequest`，关闭 `SessionStart`、`UserPromptSubmit`。
- [x] 任一第三方请求失败时，应用内 Hook 通知、系统通知和终端状态仍正常工作。
- [x] 同一个 Hook payload 最多派发一次；daemon 转发到前端时不得触发第二次第三方发送。
- [x] 后台任务由 daemon 托管且前端未连接时，命中配置的 Hook 事件仍能发送第三方通知。
- [x] 队列或单个远端请求异常时，不阻塞本地 Hook 204 响应；其他目标仍继续发送。
- [x] Custom HTTP 支持固定变量 `title/body/event/source/project/time/id`，不支持脚本、条件、循环和函数。
- [x] Webhook、token、device key、签名 secret 和自定义敏感请求头在 UI 与日志中脱敏。
- [x] 中英文 UI 文案同步完成，时间格式保持 24 小时制。
- [x] TypeScript 类型检查、Rust 编译检查和适配器单元测试通过。

## Open Decisions

- None.

## Dependency Note

- HTTP 继续复用现有 `reqwest 0.12`。
- DingTalk/Feishu 完整签名支持在 Cargo 直接声明 `hmac = "0.12.1"`；该版本已作为传递依赖存在于当前 `Cargo.lock`，用户已批准新增直接依赖。

## Notes

- 用户已确认方案，进入实现阶段。
- 详细依据见 `research/`。
