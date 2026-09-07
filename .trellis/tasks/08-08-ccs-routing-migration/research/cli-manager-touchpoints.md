# CLI-Manager 路由迁移触点清单

## 1. 分诊与发现方法

本任务是跨前端、Tauri command、独立 daemon、provider DB、Live CLI 文件和外部 HTTP 的新功能，按 `.trellis/spec/guides/fix-triage-guide.md` §5 走完整场景枚举与触点发现，不存在“只改设置页”的最小路径。

2026-08-08 已在当前分支刷新 GitNexus 索引，并分别查询以下执行域：

- provider DB、global apply、active key 与 apply journal；
- daemon protocol、server/client、capability 与 idle watchdog；
- `SettingsModal`、`SidebarFooter`、活动终端与 i18n；
- 全仓 `reqwest::Client` / `Client::builder` / 静态 client；
- Home、WSL、SSH、Project/Worktree scope。

本文件只记录规划触点，没有修改代码 symbol。真正实施前仍需对每个将编辑的函数、方法或组件执行 GitNexus upstream impact；若结果为 HIGH/CRITICAL，必须先向用户报告 blast radius 再编辑。

## 2. Provider DB、Live Writer 与 Scope

| 触点 | 当前职责 | 路由迁移计划 |
| --- | --- | --- |
| `src-tauri/src/provider/database.rs`：`PROVIDER_SCHEMA_VERSION`、`PROVIDER_SCHEMA_SQL`、`initialize_at` | `providers.db` schema v1；WAL、busy timeout、foreign key、升级前 checkpoint/backup；已有 `providers.in_failover_queue`、`sort_index`、`settings`、`provider_apply_journal` | 升至 schema v2；只增 routing settings seed 与 `routing_request_logs`，不改变 provider 复合主键和现有表语义；迁移失败不得让主应用无法启动 |
| `src-tauri/src/provider/global.rs`：`build_plan`、`plan_preview`、`preview`、`current`、`apply`、journal/recovery helpers | 按 Home 与 provider 生成 direct projection；执行 stage、parse、backup、replace、verify、compensation、journal recovery；已支持 WSL UNC 同目录 stage/replace/verify，非 Windows 使用同目录 `fs::rename` | 抽取最小 `ProjectionMode::Direct | LocalRoute`；Windows local、WSL、macOS local 的 takeover、全局切换、active key reapply 与 failover hot switch 共用同一 writer/journal |
| `src-tauri/src/provider/repository/keys.rs`：`activate_key_in_transaction`、`activate_key` | 在一个 SQLite transaction 中切换 active key 并同步 provider credential projection | 当前 provider 且 takeover 开启时，激活后的 reapply 必须生成 route projection；不得把 direct 上游 URL 写回 Live |
| `src-tauri/src/commands/provider.rs` | 暴露 catalog/key/Home/global apply Tauri commands | 现有 command 名尽量不变；路由新增独立 command 组，避免前端直接 SQL；provider 保存后的 current reapply 通过 route-aware writer |
| `src-tauri/src/provider/home.rs`：`HomeIdentity`、Home select/get/reset | 支持 `local` 与 `wsl` Home identity；`provider_home_preferences` 可同时保存 local 与多个 distro；派生 Claude/Codex/Grok roots | Takeover key 固定为 `(appType, HomeIdentity)`。Windows/macOS local 使用 `local:host`；Windows WSL 使用 `wsl:<distro>`。routing command 必须重新加载 preference 并校验 identity/path/environment |
| `src-tauri/src/provider/repository/support.rs`、`catalog.rs`：`normalize_settings_config`、provider create/update | 校验 `settings_config` 为 JSON object，并写入现有 advanced/Claude 字段；当前不校验 generic model mapping duplicate source | 增加 route mapping normalize：trim、空值、case-sensitive duplicate source；前后端使用同一稳定错误语义 |
| `src-tauri/src/provider/scope.rs`：`scope_override`、snapshot/materialize | `Worktree > project > global`；scope override 生成隔离的 direct provider 配置；SSH 丢弃本地 provider launch config | 首版保持 direct/bypass，不把 loopback endpoint 注入 Project/Worktree/SSH；路由 UI 明示 scope override 不进入全局 failover 队列 |
| `src-tauri/src/credential_store.rs`：`set/get/delete` | OS credential store 的统一封装 | 保存全局出站代理密码；DB 与普通 DTO 仅持有稳定 account ref/`hasPassword`，不存或返回明文密码 |
| `src-tauri/src/lib.rs`：startup 与 invoke registration | GUI setup 时初始化 provider domain，注册 provider/terminal commands | 注册 routing commands/events；daemon 入口初始化 route supervisor；provider DB v2 初始化失败只降级 routing 能力并显示错误 |

### 2.1 明确保持不变

- 历史 `cli-manager.db` 的 provider 兼容 migration 不扩展、不作为 routing SSOT。
- CCS 数据库只保留只读导入来源；路由运行时不读取 `.cc-switch/cc-switch.db`。
- `providers.in_failover_queue` 与 `sort_index` 已满足队列成员和顺序，不新增 failover queue 表。
- `provider_apply_journal` 继续保存短期恢复材料；不新增长期含 token 的 Live backup。
- `provider/scope.rs` 的 Project/Worktree snapshot 首版继续 direct；该行为不是遗漏，而是明确的安全边界。

### 2.2 多密钥当前边界与可选扩展

- `src-tauri/src/provider/database.rs` 的 partial unique index 保证同一 provider/type 最多一个 active key；现有表已有 `enabled`、`sort_index`，没有 quota、health、cooldown 或 last-used 字段。
- `src-tauri/src/provider/runtime.rs::load_codex_runtime_config` 与 `provider/scope.rs::load_provider` 默认只读取 enabled active key；scope manifest 也只固化一个 `active_key_id` 与密钥。
- `.trellis/spec/backend/ccs-provider-domain-contracts.md` 当前明确把 multi-key 定义为 manual-only，并排除 rotation、round-robin、failover、KeyRing 与 proxy runtime。
- 原始路由设计的 immutable provider snapshot 只有 `active key (memory only)`，provider queue identity 为 `(provider_id, app_type)`；A-03 已批准后，snapshot 扩展为 active preference + route key candidates，provider queue identity 不变。
- PRD A-03 已批准：基础 route-only key pool 复用现有表，不要求 schema v2 额外增加 key 状态列；routing loader/snapshot 改为 enabled key candidates，并在 forwarder 中增加 key attempt 层与 daemon 内存 cursor/cooldown。
- direct projection、Project/Worktree snapshot、模型发现和手动 active key 语义保持不变，避免把路由期的自动选择扩散到现有 CLI 文件与会话快照。

## 3. PTY Daemon、协议与退出生命周期

| 触点 | 当前职责 | 路由迁移计划 |
| --- | --- | --- |
| `src-tauri/src/daemon/protocol.rs`：feature constants、`supported_features`、`ClientFrame`、`DaemonFrame` | 定义控制协议、capability handshake、8 MiB frame 上限和未知字段兼容 | 新增 `local_routing_v1` capability 与最小 routing reload/status/start/stop/reset 帧；frame 不传 API key、proxy password 或完整 provider document |
| `src-tauri/src/daemon/discovery.rs`：`DaemonInfo` | 持久化 daemon version、protocol version、ports、token、features | route port 不复用控制/WS/hook port；发现信息暴露 capability/runtime summary，不暴露上游凭据。WSL advertised endpoint 由 routing state 返回，不把 gateway 当 control endpoint |
| `src-tauri/src/daemon/server.rs`：`DaemonServer::run` | 绑定随机 loopback control/WS/hook ports，创建 host 并 accept | 初始化 route supervisor；Windows bind loopback + 经校验的 WSL gateway listener set，macOS 只 bind loopback；外部 CLI 不能访问 daemon control token 通道 |
| `src-tauri/src/daemon/server.rs`：`spawn_idle_watchdog` | 仅以 `client_count > 0 || alive_session_count > 0` 判定 busy | 把 route listener/恢复任务计入 busy；无 GUI、无 alive PTY 但 route active 时 daemon 不退出 |
| `src-tauri/src/daemon/server.rs`：`handle_frame(ClientFrame::Shutdown)` | 无 alive PTY 时退出 daemon | route active 时不得退出；返回稳定 busy reason，供 GUI 区分“控制链路失败”和“因后台路由保留” |
| `src-tauri/src/daemon/client.rs`：`connect_or_spawn`、`shutdown_if_idle` | 发现/拉起 daemon；版本不匹配且无 alive PTY 时尝试关闭旧 daemon | 版本判断同时考虑 route busy；有 route 时保留旧 daemon并提示兼容状态，禁止只因 PTY 为空就强杀 |
| `src-tauri/src/commands/terminal.rs`：`pty_host_get_endpoint`、`pty_daemon_shutdown_if_idle` | 向前端暴露 daemon endpoint/feature；退出时请求 shutdown | endpoint feature 用于 gate routing 控制；退出 command 不能把 `routing_active` 当不可信错误 |
| `src/terminal/transport/PtyHostSocket.ts` | WebSocket capability 判断、request/attach/reconnect | 路由不经过 PTY WebSocket 数据通道；仅在需要展示 daemon feature 时复用 endpoint 信息，避免把 HTTP payload 混入终端协议 |

### 3.1 已发现的退出流程冲突

当前 `src/App.tsx` 的真正退出流程会：

```text
close_all foreground/background PTY
  -> pty_daemon_shutdown_if_idle
  -> shutdown 抛错则取消 app_exit
```

`src/lib/terminalExitCleanup.ts` 也把任何 shutdown error 解释为 `canExit=false`。如果只让 daemon 的 `Shutdown` 因 route active 返回错误，GUI 将永远无法正常退出，这与“GUI 关闭后路由继续服务”冲突。

首版必须同时修改退出编排，而不是只改 idle watchdog：

1. 退出前读取可信 routing state；
2. 用户选择真正退出时仍按现有规则关闭 PTY；
3. route active 时显式跳过 daemon shutdown，但允许 GUI `app_exit`；
4. route inactive 时保持当前 close_all + shutdown 安全契约；
5. daemon 查询失败、状态不可信时仍禁止静默退出；
6. “转入后台”路径继续不 close PTY、不 shutdown daemon。

建议给 `cleanupTerminalProcessesForExit` 增加显式 `retainDaemon` 选项，而不是把现有 `pty_daemon_shutdown_if_idle: boolean` 的 `false` 偷换为第二种含义。该选项必须有前端回归测试。

### 3.2 平台 listener 与 endpoint

| 触点 | 当前职责 | 路由迁移计划 |
| --- | --- | --- |
| `src-tauri/src/wsl.rs`、`src-tauri/src/shell_resolver.rs` | WSL executable、UNC/path normalize、bounded command execution | 复用 bounded runner，在目标 distro 执行 localhost probe、default route/device/CIDR 读取；禁止无 timeout shell |
| `src-tauri/Cargo.toml` 的 `windows-sys` | 已用于 Windows Console/Job/Filesystem 等 native API | 只增加 IpHelper 所需 feature，用 `GetAdaptersAddresses` 校验 gateway 是本机精确 unicast；不加第三方网卡枚举依赖 |
| `src-tauri/src/daemon/client.rs`、`daemon/protocol.rs` | 已有 Unix/macOS daemon process group 与跨平台 process traits | macOS route daemon 复用现有 spawn/discovery；补齐 route busy、listener 和真实 runner 验收 |
| `src-tauri/src/credential_store.rs` | Windows Credential Manager 与 macOS Keychain | global proxy password 两平台共用；Linux native 不在本任务范围 |

## 4. 前端设置页与快捷入口

| 触点 | 当前职责 | 路由迁移计划 |
| --- | --- | --- |
| `src/components/SettingsModal.tsx` | 已有 `native-providers` 顶级 tab、搜索与页面路由 | 不新增 `routing` tab；只需保证 provider page 在 routing surface 时不使用 catalog 搜索 |
| `src/components/settings/pages/NativeProviderSettingsPage.tsx`：`NativeProviderSettingsSurface`、SegmentedControl、app tabs | 当前 surface 为 `catalog | home`，供应商目录和 CLI Home 共用 app type 状态 | 扩为 `catalog | home | routing`，顺序固定 `供应商目录 / CLI Home / 路由`；routing surface 渲染四个 accordion，复用 app tabs |
| `src/components/settings/providers/NativeClaudeConfigSection.tsx` | Claude 角色显示名与实际请求模型映射 UI | 增加 route-only 生效双语提示；明确 display name 不等于 outbound model |
| `src/components/settings/providers/NativeProviderAdvancedConfigSection.tsx`、`nativeProviderAdvancedConfig.ts` | Codex/Grok `modelMappings[{source,target}]`、Header/Body Override；当前只校验非空 | 增加 duplicate source 校验、route-only 提示、列名“显示/请求名称 -> 实际请求名称”，说明 mapping final model 优先于 Body Override |
| `src/components/sidebar/index.tsx` | 已订阅 `sessions`、`activeSessionId`，可得到 `activeSession?.cliTool` | 在父层把当前活动 PTY 的 app type 与 environment/scope 支持状态传给 `SidebarFooter`；不读取“上次打开的设置 tab”猜测应用 |
| `src/components/sidebar/SidebarFooter.tsx` | 同步、统计、Hook、设置快捷入口 | 按两个 UI preference 显示本地路由与故障转移快捷开关；collapsed/expanded 都需可操作、可聚焦、有 title/aria；不支持状态显示原因而不是静默隐藏 |
| `src/lib/types.ts`、`src/stores/terminalStore.ts`：`TerminalSession`、launch metadata | 已保存 `cliTool`、`environmentType`、provider snapshot；没有路由 Home 快照 | 会话启动时固化可选 routing HomeIdentity。`claude/codex/grok` + Windows local/WSL/macOS local PTY 可启用；SSH、Pi、Gemini、transcript/editor 不可启用 |
| `src/lib/i18n.ts`、`useI18n()`、`translateCurrent()` | `zh-CN`/`en-US` 用户文案 | 新 tab、四模块、状态、错误、toast、aria、危险恢复提示全部双语；不得在组件内新增硬编码文案 |

## 5. 全局出站代理网络触点

`reqwest` 已启用 `json`、`rustls-tls`、`http2`、`socks`。首版先复用现有依赖和一个共享 builder/configurator；不能因为 `hyper` 是传递依赖就直接新增一套 HTTP 栈。只有 pinned CCS fixture 证明 `reqwest` 无法满足必须的 CONNECT/header 行为时，才评估显式 direct dependency。

### 5.1 纳入全局代理

| 文件/构造点 | 当前形态 | 计划 |
| --- | --- | --- |
| `src-tauri/src/provider/models.rs` | 每次 `Client::builder`，自带 default headers/timeout | 通过共享 builder 注入当前代理，保留 headers/timeout |
| `src-tauri/src/commands/model_pricing.rs` | 每次 builder，LiteLLM/OpenRouter 共用一次 client | 注入当前代理，保留 user-agent/timeout |
| `src-tauri/src/commands/command_suggestion.rs::shared_client` | `OnceLock<reqwest::Client>`，首次构造后无法热更新 | 移除静态不可替换 client；每次 clone 当前 generation 的共享 client |
| `src-tauri/src/commands/desktop_pet.rs` | catalog/download 各自 builder | 注入代理，保留 10s/30s timeout |
| `src-tauri/src/ssh_agent_supply_chain.rs::release_client` | 每次 builder，含严格 redirect 与 HTTP policy | 注入代理但保留 scheme/redirect/签名验证边界 |
| `src-tauri/src/webdav/mod.rs::SHARED_CLIENT` | 进程级 `OnceLock<Client>`，所有 WebDAV 操作复用 | 改为可热替换 shared client 或 generation cache；保留 WebDAV Basic auth、证书与 timeout |
| `src-tauri/src/third_party_notification/http.rs::build_client` | 每个 dispatcher/test 构造固定 client | 注入代理，保留 no-redirect、响应上限和受控 header |
| local routing upstream | 尚不存在 | 必须使用同一全局代理配置；显式/系统代理指向 route 自身时拒绝自环 |
| `src-tauri/src/sync/mod.rs` | 通过 `WebDavClient::new` 间接使用 WebDAV client | 随 WebDAV client 自动覆盖，不新增第二套代理逻辑 |

### 5.2 明确例外

| 触点 | 决策 |
| --- | --- |
| `src-tauri/src/commands/cc_connect.rs` | profile 显式代理继续独立且优先；不被 global proxy 静默覆盖 |
| `src-tauri/src/commands/cc_connect/update.rs` | 保留自己的 `proxy_enabled/proxy_url/no_proxy` 决策，首版不合并 |
| SSH host/jump/proxy transport | 不是 `reqwest` 全局代理范围，不改变 |
| Tauri updater、WebView/浏览器 fetch | 首版不宣称覆盖；帮助文案明确 |

## 6. Discovery List

- [x] Provider DB schema/version、settings、failover flags、request-log 落点已定位。
- [x] Global writer 的 plan/stage/verify/journal/rollback/recovery 链已定位。
- [x] Active key 事务与 current provider reapply 触点已定位。
- [x] Home identity、多个 Home preference、WSL UNC writer 与 macOS local writer 已定位。
- [x] WSL mirrored/NAT endpoint probe、Windows IpHelper gateway 校验与 listener set 新触点已定位。
- [x] Project/Worktree/SSH scope bypass 触点已定位。
- [x] Daemon protocol、discovery、server/client、idle/shutdown 已定位。
- [x] GUI 真退出与 daemon shutdown 冲突已定位，需作为 Phase 1 必做项。
- [x] 供应商页 surface、模型映射弹框、Sidebar active session/Home snapshot、快捷入口已定位。
- [x] `zh-CN`/`en-US` 与 aria/keyboard 触点已定位。
- [x] 全仓 Rust HTTP client 构造点与明确例外已定位。
- [x] `NOTICE`、`LICENSE`、`third-party/` 许可落点已定位。
- [x] 历史 request logs、CCS runtime DB、远端 SSH、Gemini 已确认不进入首版运行路径。
- [x] Windows local、WSL、macOS local 均已进入 Phase 1 验收范围，不再保留仅支持 Windows 的假设。
