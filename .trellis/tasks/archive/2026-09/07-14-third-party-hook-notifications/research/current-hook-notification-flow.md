# Current Hook Notification Flow

## Existing Flow

1. Claude Code / Codex 执行 CLI-Manager 安装的 `__hook` 命令。
2. `src-tauri/src/hook_client.rs` 从 stdin 和环境变量标准化 Hook 负载，通过本地 TCP HTTP POST 到 `/api/claude-hook`。
3. `src-tauri/src/claude_hook.rs` 校验 loopback 请求、Bearer token、请求大小和事件字段，然后通过 `claude-hook-notification` 事件发送到前端。
4. `src/App.tsx` 的统一监听器处理子 Agent 事件、终端状态、应用内 toast 和系统通知。
5. `sendSystemNotification()` 读取 `settingsStore`，按全局开关、事件开关和窗口聚焦状态决定是否发送 OS 通知。

## Relevant Symbols

- `src-tauri/src/hook_client.rs:129`：构造 camelCase Hook payload。
- `src-tauri/src/hook_client.rs:155`：本地 bridge POST，读写超时均为 2 秒；失败静默，不影响 CLI。
- `src-tauri/src/claude_hook.rs:21`：`ClaudeHookBridge`。
- `src-tauri/src/claude_hook.rs:124`：本地 Hook listener。
- `src-tauri/src/claude_hook.rs:139`：鉴权、解析、校验和 sink 分发。
- `src/App.tsx:223`：系统通知事件过滤。
- `src/App.tsx:239`：系统通知正文生成。
- `src/App.tsx:287`：`sendSystemNotification()`。
- `src/App.tsx:704`：前端 Hook 统一消费入口。
- `src/stores/settingsStore.ts:135`：六类 `HookEventType`。
- `src/stores/settingsStore.ts:323`：现有系统通知设置。
- `src/stores/settingsStore.ts:547`：系统通知事件迁移。
- `src/components/settings/pages/HookSettingsPage.tsx:802`：系统通知设置区域。
- `.trellis/spec/backend/cli-hook-contracts.md:139`：现有系统级 Hook 通知契约。

## Existing HTTP Building Blocks

- `reqwest 0.12` 已启用 `json`、`rustls-tls`、`http2`，无需新增 HTTP 客户端依赖。
- `src-tauri/src/commands/command_suggestion.rs:497` 已有共享 client、请求超时、URL 日志脱敏、响应体限长和错误映射模式，可复用设计。
- `base64 0.22`、`sha2 0.10` 已存在。
- 钉钉和飞书签名建议直接声明已在 `Cargo.lock` 中存在的成熟 `hmac 0.12.1`，不要手写 HMAC。

## Recommended Extension Point

第三方通知应作为“已校验 Hook payload”的下游 fan-out，由实际接收 Hook 的进程唯一入队：

- 进程内模式：`ClaudeHookBridge::start()` 创建的 sink 入队，然后 emit 给前端。
- daemon 模式：`daemon/server.rs` 的 `hook_sink` 入队，然后更新状态并广播给前端。

前端 `App.tsx` 只继续负责 app toast 和 OS notification，不得在收到 daemon 广播后再次发送第三方通知。

原因：

- daemon 使用稳定 Hook 端口，CLI-Manager 窗口退出后仍会接收后台任务的 Stop/Failure 等事件。
- 若只在 `App.tsx` invoke，前端未连接时事件只进入 daemon cache，第三方通知不会实时送达。
- sink 归属清晰，可保证每个 payload 只由实际入口派发一次。
- 不需要修改 Hook 安装模块 `hook_settings.rs`，也不需要再安装一套 Hook。

同步 sink 内禁止直接访问远程网络。新模块应提供有界队列，sink 只做非阻塞 enqueue；后台 worker 读取配置并使用 reqwest 发送。队列满时丢弃并记录脱敏 warning，不能反压 Hook 的 204 响应或 CLI 退出。

## Expected File Boundary

- `src/stores/settingsStore.ts`：持久化目标列表及迁移。
- `src/components/settings/pages/HookSettingsPage.tsx`：挂载第三方通知设置区域。
- 建议新增独立设置组件，避免继续扩大现有 1200+ 行页面。
- 建议新增前端类型模块，维护与 Rust serde 模型一致的目标配置。
- 建议新增 `src-tauri/src/third_party_notification.rs`：有界队列、配置读取、摘要生成、Provider Adapter 和 HTTP 执行。
- `src-tauri/src/claude_hook.rs`：进程内 bridge sink 入队，并为 dispatcher 暴露必要的只读 payload 字段。
- `src-tauri/src/daemon/server.rs`：daemon sink 入队，确保前端退出后仍实时发送。
- 建议新增测试发送 command，复用同一 adapter/executor。
- `src-tauri/src/commands/mod.rs`、`src-tauri/src/lib.rs`：command 注册。
- `src/lib/i18n.ts`：中英文文案。
- `.trellis/spec/backend/cli-hook-contracts.md`：实现后扩展通知契约。

## Constraints

- 第三方通知是 additive，不能替代 app toast、tab 状态或 OS 通知。
- 子 Agent transcript/tool 生命周期事件继续排除在远程通知外。
- 默认事件应沿用系统通知默认值，避免 `SessionStart` 和 `UserPromptSubmit` 噪声。
- 后台任务模式是否绕过第三方目标开关必须单独决定；建议不绕过，远程外发必须始终服从用户配置。
- daemon 无前端 tab title，项目名应稳定回退到 cwd basename；不能为了显示名依赖前端在线。

## GitNexus Impact Snapshot

- `HookSettingsPage`: LOW，1 个直接上游（`SettingsModal`）。
- `ClaudeHookBridge`: LOW，但 Rust 关系索引未完整识别 daemon 复用，必须以源码调用链补充判断。
- `broadcast_hook`: LOW，索引未识别调用者，源码确认由 daemon hook sink 调用。
- `useSettingsStore`: CRITICAL，159 个受影响符号、42 个直接调用者、44 条流程、13 个模块。

因此实现时不得改动 `useSettingsStore` 的公共调用方式。只允许新增向后兼容字段、严格 migration 和独立 selector，并补充设置加载/迁移回归测试。进入实现前需再次运行影响分析；若仍为 CRITICAL，必须先向用户明确告警。
