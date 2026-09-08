# 第三方 Hook 通知设计

## Scope

在现有已校验 Hook payload 的下游增加第三方通知 fan-out，内置：DingTalk、Feishu、WeCom、Bark、PushPlus、WxPusher、ServerChan、Telegram、ntfy、Gotify，以及 Custom HTTP。

第三方通知是附加能力，不得替代或影响终端状态、应用内 toast、系统通知、daemon 状态更新和 Hook 204 响应。不得新增或重复安装 Claude/Codex Hook。

MVP 不做持久化重试、富文本卡片设计器、脚本/表达式执行、双向机器人交互和外部平台回跳。

## Data Flow And Dispatch Ownership

```text
CLI __hook
  -> localhost bridge 鉴权与校验
      -> 实际接收进程唯一 try_send
          ├─ 进程内：ClaudeHookBridge sink
          └─ daemon：DaemonServer hook_sink
      -> 原有本地链路
          ├─ 主进程 emit 到前端
          └─ daemon 更新状态并 cache/broadcast 到前端

后台 worker
  -> 读取 settings.json
  -> 筛选 enabled + event
  -> Provider Adapter 构造请求
  -> HttpExecutor 受限并发发送
  -> Adapter 解析平台业务结果
```

- `src/App.tsx` 收到 `claude-hook-notification` 后不得发送第三方通知。
- daemon 模式的 PTY 只注入 daemon 的 port/token；单个 Hook 进程只会命中一个 listener。
- daemon cache replay 只补发前端事件，不再次入队。
- 不增加额外去重缓存；“最多一次”由单一接收入口保证，避免没有稳定幂等键时误吞合法事件。
- sink 内只执行 `try_send`。入队失败只能记录脱敏 warning，不能阻止原有 emit、状态更新或广播。

## Module Boundary

Rust：

```text
src-tauri/src/third_party_notification/
  mod.rs          # 对外 DispatcherHandle、测试发送入口
  model.rs        # 配置、公共消息、请求/响应、错误模型
  adapters.rs     # 静态 Adapter enum、10 个平台和 Custom HTTP 映射
  http.rs         # reqwest client、超时、响应限长、日志脱敏
  dispatcher.rs   # 有界队列、配置读取、事件筛选、受限并发
src-tauri/src/commands/third_party_notification.rs
```

不为每个平台拆独立文件。平台逻辑只负责“配置校验、构造请求、解析业务响应”，HTTP 统一由执行器完成。

前端：

```text
src/lib/thirdPartyNotifications.ts
src/components/settings/ThirdPartyNotificationSection.tsx
src/stores/settingsStore.ts
src/components/settings/pages/HookSettingsPage.tsx
src/lib/i18n.ts
```

`HookSettingsPage` 只挂载独立 section，避免继续膨胀。

## Persisted Configuration

`settingsStore` 新增 `thirdPartyHookTargets: ThirdPartyNotificationTarget[]`，默认空数组。使用 `provider` 判别联合类型；公共字段为：

- `id`
- `name`
- `provider`
- `enabled`
- `events: Record<HookEventType, boolean>`
- `config`

新目标默认启用 `Notification`、`Stop`、`StopFailure`、`PermissionRequest`，关闭 `SessionStart`、`UserPromptSubmit`。最多保存 20 个目标。

前端 migration 逐项校验，过滤未知 provider、坏记录和重复 id，不修改 `useSettingsStore.update()` 公共契约。Rust worker 仍做第二层容错：单个坏目标只跳过该项，不让整组配置失效。

worker 每个 Hook job 从 `~/.cli-manager/settings.json` 读取一次目标配置。Hook 频率低，小文件读取比 mtime cache 更简单，也能立即看到 UI 修改。文件缺失或瞬时解析失败时本次按空配置处理，不写回、不清空配置。

凭证沿用现有 settings store 明文持久化方式；UI 遮罩不等于加密，文案必须明确。MVP 不额外引入密钥数据库。

## Minimal Remote Message

Hook sink 只把最小种子放进队列：`source/event/cwd/timestamp`。仅接受现有六类用户通知事件，Subagent/Tool 生命周期事件直接忽略。

worker 构建统一消息：

- `id`：每个 Hook job 新 UUID，所有目标共享。
- `title`：`CLI-Manager`。
- `body`：CLI 来源、项目名、事件、时间的纯文本摘要。
- `event`
- `source`
- `project`：只取 cwd basename，不发送绝对路径。
- `time`：合法 Hook 时间或当前时间。

MVP 不进入远程消息：`payload.message`、Prompt、终端输出、绝对 cwd、session/tab id、transcript、tool args、环境变量。

远程默认文案允许加入少量 emoji，例如完成、失败、待处理等事件图标，用于提高移动端通知可读性；emoji 只来自事件枚举，不来自 Hook 原文。

## Adapter Contract

不引入 `async_trait` 或动态插件系统。Adapter 只做同步转换和解析，使用 enum 静态分派：

```rust
trait NotificationAdapter {
    fn validate(&self) -> Result<(), NotificationError>;
    fn build_request(
        &self,
        message: &HookNotificationMessage,
        now: chrono::DateTime<chrono::Utc>,
    ) -> Result<HttpRequestSpec, NotificationError>;
    fn parse_response(
        &self,
        response: &HttpResponseSnapshot,
    ) -> Result<ProviderAccepted, NotificationError>;
}
```

公共执行顺序：`validate -> build_request -> execute -> parse_response`。

| Provider | 关键配置 | 业务成功 |
| --- | --- | --- |
| DingTalk | webhook URL、可选 signing secret | `errcode == 0` |
| Feishu | webhook URL、可选 signing secret | `code == 0` |
| WeCom | webhook URL | `errcode == 0` |
| Bark | base URL、device key、可选 Basic/group/sound/level | `code == 200` |
| PushPlus | token、可选 channel/template/topic/option | `code == 200`，结果只标记 accepted |
| WxPusher | SPT；或 appToken + uids/topicIds | `code == 1000` |
| ServerChan | sendKey，自动识别 SC3/Turbo | `code == 0` |
| Telegram | bot token、chat id、可选 thread id | `ok == true` |
| ntfy | server URL、topic、可选 Basic/Bearer/priority/tags | 2xx 且响应存在 `id` |
| Gotify | server URL、app token、可选 priority | HTTP 200 且响应存在数值 `id` |
| Custom HTTP | method、URL、query、headers、body | 任意 2xx |

DingTalk/Feishu 签名以传入的固定 `now` 生成，便于确定性测试。完整签名直接使用 `hmac = "0.12.1"`，不手写 HMAC。

## Custom HTTP Boundary

- method 仅允许 GET/POST；GET 禁止 body。
- 支持 query、headers、JSON/form/text body。
- 固定变量仅为 `{{title}}`、`{{body}}`、`{{event}}`、`{{source}}`、`{{project}}`、`{{time}}`、`{{id}}`。
- URL、query、header、form、text 支持变量替换。
- JSON 先解析为 `serde_json::Value`，只递归替换字符串叶子，再由 serde 序列化，避免 JSON 注入。
- 禁止条件、循环、函数、JavaScript、Shell、任意表达式和动态 HMAC。
- 禁止覆盖 `Host`、`Content-Length`、`Transfer-Encoding`、`Connection` 等受控 header。
- 最终 URL 只允许 http/https、非空 host，拒绝内嵌 username/password；不跟随重定向。

## Async Dispatch

不把 daemon 改成 async，也不为 daemon main 添加 `#[tokio::main]`。

- 每个接收进程启动一个显式 `DispatcherHandle`。
- 使用 `std::sync::mpsc::sync_channel(64)`；sink 调用 `try_send`，不等待。
- 独立 OS worker 线程外层阻塞读取 job，线程内创建一个 current-thread Tokio runtime。
- 每个 job 最多取 20 个匹配目标。
- job 内使用 rolling `JoinSet`：先启动最多 4 个请求，每完成一个再补一个，始终保持并发不超过 4。
- 单目标失败不取消其他请求。
- 队列满时丢弃整个 Hook job 并记录脱敏 warning。
- MVP 不自动重试；Telegram/平台返回的 retry 信息只用于测试结果展示。
- 进程退出时不等待远程请求 flush，避免退出流程被第三方网络阻塞；daemon 托管任务时由 daemon 自己继续发送。

## HTTP And Security Policy

- 复用现有 `reqwest 0.12`，client 在 worker 内创建一次并复用。
- connect timeout 3 秒；total timeout 5 秒。
- redirect policy 为 none。
- 响应体最多 64 KiB。
- 公共摘要最多 2 KiB，并进一步满足各平台更小限制。
- 内置平台必须解析业务码，不能只看 HTTP 2xx。
- 日志只记录 provider、target id、去掉 userinfo/query/fragment 的 host、错误类别和业务码。
- 禁止记录完整 URL、headers、请求 body、token、secret、device key 和远端原始响应。
- Bark、ntfy、Gotify、Custom 允许用户配置 HTTP 以支持 localhost/内网，但 UI 必须提示明文风险。

## Test Send

新增 async Tauri command，接收当前编辑中的单个 target，使用固定安全摘要直接调用同一 Adapter + HttpExecutor，不进入生产队列，也不读取 Prompt/终端内容。

返回：accepted、provider、耗时、HTTP 状态、业务码、脱敏业务消息、delivery id、稳定错误码。配置、网络和业务失败优先返回 `accepted=false` 的结构化结果，只有内部不可恢复错误返回 command error。

## Compatibility And Risk

- `useSettingsStore` GitNexus 影响为 CRITICAL：159 个符号、42 个直接调用者、44 条流程、13 个模块。只允许新增兼容字段、独立 migration 和 selector，不改公共调用方式。
- `HookSettingsPage` 影响为 LOW：1 个直接上游。
- `ClaudeHookBridge` 图索引显示 LOW，但 Rust daemon 复用关系识别不完整，必须以源码回归测试补足。
- 设置文件中的凭证为明文；本期只做遮罩和日志防泄漏，不宣称加密。
- 10 个外部 API 的主要维护风险是业务码、限流和接口变化，因此所有平台逻辑集中在 Adapter 并有确定性单元测试。

## Approval

- 已确认：只发送摘要，MVP 不提供完整 Hook 原文外发开关。
- 已确认：新增直接依赖 `hmac = "0.12.1"`，用于钉钉/飞书可选签名。
