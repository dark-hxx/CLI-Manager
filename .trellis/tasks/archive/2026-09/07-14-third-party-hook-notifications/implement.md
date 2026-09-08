# 第三方 Hook 通知实施计划

## Step 1：确认范围与影响分析

- 用户确认 design.md 的两个待批准项。
- 更新 `prd.md`，清空 Open Decisions。
- 实现前重新对 `useSettingsStore`、`HookSettingsPage`、`ClaudeHookBridge`、daemon hook sink 运行 GitNexus upstream impact。
- 若 HIGH/CRITICAL 风险变化，先告警再继续。

## Step 2：Rust 模型、Adapter 和 HTTP Executor

- 新增 `third_party_notification` 模块及公共 DTO。
- 完成 10 个内置 Adapter、Custom HTTP、URL/header/模板限制和业务响应解析。
- 完成共享 reqwest client、超时、响应限长、错误分类和日志脱敏。
- Cargo 直接声明 `hmac = "0.12.1"`，不新增其他运行时依赖。
- 先补 Adapter、签名、变量替换、业务码和本地 fake HTTP server 测试。

## Step 3：Dispatcher 与设置读取

- 建立 `sync_channel(64)`、单 OS worker、current-thread Tokio runtime。
- worker 按 job 读取 settings，逐项容错解析并筛选 enabled/event。
- 每个 job 最多 20 个目标，rolling `JoinSet` 最大并发 4。
- 验证队列满、坏配置、runtime/client 初始化失败、单目标超时均不阻塞、不 panic、不重试。

## Step 4：唯一派发接线

- 进程内 `ClaudeHookBridge` sink 非阻塞入队。
- daemon `hook_sink` 非阻塞入队。
- `src/App.tsx` 不增加第三方派发逻辑。
- 回归 daemon broadcast/cache replay 不产生二次发送。

## Step 5：测试发送 command

- 新增 `commands/third_party_notification.rs` 并在 `commands/mod.rs`、`lib.rs` 注册。
- 复用同一 Adapter/HttpExecutor。
- 返回结构化、脱敏测试结果；测试草稿不要求 enabled/events 命中。

## Step 6：前端持久化与 UI

- 新增 TS 判别联合类型、默认事件和 sanitizer。
- `settingsStore` 新增默认字段与 migration，最多保留 20 个合法目标。
- 新增独立 `ThirdPartyNotificationSection`：新增、编辑、启停、删除、事件筛选、测试发送。
- 支持同平台多实例和跨平台多目标。
- 敏感字段使用密码输入；普通列表不展示凭证；明确“遮罩不等于加密”。
- `HookSettingsPage` 只挂载 section。
- 所有文案同步加入 zh-CN/en-US，保持 24 小时制。

## Step 7：文档与交付验证

- 更新 `.trellis/spec/backend/cli-hook-contracts.md`。
- 更新 `CHANGELOG.md` 的 V1.2.8。
- 更新 `docs/功能清单.md`。
- 运行 `npx tsc --noEmit`。
- 运行 `cd src-tauri && cargo check`。
- 运行 focused `cargo test third_party_notification --lib`，并回归 Hook/daemon 相关测试。
- 提交前运行 `gitnexus detect-changes`，核对只影响预期符号和流程。

## Completion Notes

- 2026-07-14：Issue #134 实现完成。
- 验证通过：`npx tsc --noEmit`。
- 验证通过：`cd src-tauri && cargo check`。
- 验证通过：`cd src-tauri && cargo test third_party_notification --lib`。
- 三方通知时间使用用户电脑本地时区，保持 24 小时制。

## Risky Files

- `src/stores/settingsStore.ts`
- `src/components/settings/pages/HookSettingsPage.tsx`
- `src/lib/i18n.ts`
- `src-tauri/src/claude_hook.rs`
- `src-tauri/src/daemon/server.rs`
- `src-tauri/src/lib.rs`
- `src-tauri/Cargo.toml`

## Test Matrix

| Layer | Cases |
| --- | --- |
| 消息最小化 | 六类事件可转换；Subagent/Tool 忽略；不含 message、绝对 cwd、tab/session id、transcript |
| Settings | 缺字段、坏 JSON、未知 provider、单条坏 target、重复 id、超过 20 条、禁用/事件关闭 |
| Queue | `try_send` 立即返回；容量满丢弃；单 job 最大并发 4 |
| 隔离 | 单目标超时/业务失败不影响其他目标；请求次数恒为 1，无自动 retry |
| 唯一派发 | 进程内 1 次；daemon 1 次；cache replay/前端重连新增派发 0 次 |
| DingTalk/Feishu | 固定时间签名、无签名、正确与错误业务码 |
| WeCom/Bark/PushPlus | 请求体、长度边界、业务码、accepted 语义 |
| WxPusher | SPT/标准模式、UID/Topic、`code == 1000` |
| ServerChan | `sctp`/Turbo URL、JSON 编码、`code == 0` |
| Telegram | token 脱敏、chat/thread、`ok=true`、429 retry_after 仅展示 |
| ntfy/Gotify | 自定义 server、认证、id 成功判定、401/429 |
| Custom GET | URL/query/header 变量替换、禁止 body、2xx accepted |
| Custom POST | JSON 叶子安全替换、form/text、中文/引号/换行、无 JSON 注入 |
| Security | 拒绝非 http(s)、空 host、URL credentials、受控 header；302 不跟随；日志无凭证 |
| HTTP | connect/total timeout、64 KiB 响应限制、非 UTF-8、非 2xx |
| Test command | 固定摘要、草稿可测、结构化脱敏结果、不进入队列 |
| Frontend | 增删改启停、多实例、事件开关、敏感字段遮罩、中英文切换、24 小时制 |
| Regression | Tab 状态、toast、系统通知、Hook 204、CLI exit code 不受第三方失败影响 |

自动测试统一使用本地 `TcpListener` fake server，不依赖真实平台凭证。真实平台通过设置页“测试发送”做人工烟测。
