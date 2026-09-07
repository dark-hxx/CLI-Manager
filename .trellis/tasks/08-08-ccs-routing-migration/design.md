# CCS 路由板块迁移设计

## 1. 设计结论

### 1.1 首版边界

- 平台：Windows 本地 CLI、Windows 下 WSL CLI、macOS 本地 CLI。
- 应用：Claude Code、Codex、Grok Build。
- 供应商：enabled、ready、存在 enabled active API key 的普通 API-key provider；路由运行时可加载同 provider 的其他 enabled keys。
- 明确不接管：SSH、官方 Claude/Codex/xAI OAuth、Gemini、Project/Worktree provider override。
- WSL 只由 Windows daemon 提供路由，不在 WSL 内再启动第二个 Linux daemon。
- Windows/macOS 本地客户端只使用 loopback；WSL NAT 只增加经过校验的精确 Windows host-gateway listener。
- 禁止 wildcard/LAN listener、自动防火墙规则和 `netsh portproxy`。

路由入口固定复用现有供应商设置页：`设置 -> 供应商 -> 供应商目录 / CLI Home / 路由`。不新增独立 `SettingsModal` tab。

### 1.2 复用与依赖原则

1. 复用 `providers.db`、`providers.in_failover_queue`、`sort_index`、active/enabled keys 和 native provider effective config；
2. 复用 `provider/global.rs` 的 plan、stage、parse、backup、replace、verify、compensation、journal 与 recovery；
3. 复用 PTY daemon 的发现、capability、控制连接、idle/shutdown 与跨 GUI 生命周期；
4. 复用 `provider_home_preferences`、`HomeIdentity`、WSL UNC writer 和 macOS 同目录 rename；
5. 复用 OS credential store 与现有 `reqwest` socks 能力；
6. HTTP 服务仅显式声明当前 lockfile 已存在的 `hyper`/`hyper-util`/`http-body-util`/`bytes`，并给 `tokio` 增加 `net` feature；不引入 axum/tower；
7. 协议转换只移植 CCS v3.19.2 必需模块，不复制 OAuth、catalog、billing、MCP、marketplace 等无关运行域。

## 2. 运行时边界

```text
NativeProviderSettingsPage / Sidebar quick controls
        │ Tauri commands + routing events
        ▼
Tauri command boundary ── providers.db / credential store
        │                         │
        │ routing reload          │ provider snapshots + route key pools
        ▼                         ▼
PTY daemon control socket ── RoutingSupervisor
                                  │
                                  ├─ ListenerLease / PortAllocator
                                  ├─ Windows local + WSL EndpointResolver
                                  ├─ macOS local EndpointResolver
                                  ├─ HTTP router / protocol adapters
                                  ├─ provider selector / circuit breakers
                                  ├─ model mapping / request overrides
                                  ├─ rectifier / Bedrock optimizer
                                  ├─ global outbound proxy client
                                  └─ redacted route usage logger
```

### 2.1 Tauri 主进程

- 负责配置校验、provider DB 写入、Live projection、恢复操作和用户确认。
- 前端不得直接打开 provider DB，也不得直接写 CLI Home 文件。
- provider/current/key 变化统一调用 route-aware global writer。
- WSL gateway 解析调用 daemon/runtime helper，但最终 takeover 状态只在 Live verify 成功后提交。

### 2.2 PTY daemon

- listener、forwarder、circuit、rectifier、metrics 驻留 daemon。
- `serviceEnabled || active takeovers || recovery_required` 时 route 被视为 daemon busy。
- route HTTP port 与 daemon control/WS/hook ports 分离。
- Windows daemon 可同时持有 local loopback 与多个去重后的 WSL gateway socket；macOS daemon 只持有 loopback。
- 所有 listener 共享同一个 `actualPort`、router、provider runtime 和 request metrics。
- route provider runtime 为每个 `(app_type, provider_id)` 维护内存 key cursor/cooldown；key pool 不写回 provider active 标志。

### 2.3 GUI 退出

现有真正退出流程把任何 `shutdown_if_idle` 错误视为不能退出。路由 active 时不能简单让 daemon 返回 busy，否则 GUI 会被永久阻塞。

退出清理增加显式 `retainDaemon`：

- route inactive：保持现有 close_all -> shutdown -> app_exit；
- route active：按用户选择关闭 PTY，跳过 daemon shutdown，允许 GUI app_exit；
- daemon/routing 状态查询失败：继续阻止静默退出；
- 最小化、托盘、转入后台：不 close PTY、不 shutdown；
- 旧 daemon 有 alive PTY 或 active route：版本升级不得强杀。

### 2.4 前端

- `NativeProviderSettingsSurface` 扩为 `catalog | home | routing`。
- SegmentedControl 顺序固定为 `供应商目录 / CLI Home / 路由`。
- `SettingsModal` 仍只保留现有 `native-providers` tab；搜索只作用于 catalog surface。
- routing surface 复用现有 app type tabs，四个 accordion 顺序固定为本地路由、自动故障转移、全局出站代理、整流器。
- 状态采用 daemon event + 页面打开时 `routing_get_state` 校准；不让整个 SettingsModal 常驻订阅 route runtime。

## 3. provider DB schema v2

### 3.1 迁移

`providers.db` 从 schema v1 升到 v2：

- 保持 provider、key、Home、apply journal 表语义不变；
- 继续复用 `settings(key, value)`；
- 新增最小 `routing_request_logs`；
- 迁移遵守 WAL checkpoint、升级 backup、future-version reject；
- provider DB routing migration 失败只降级 routing，不阻断项目/session 主数据库启动。

### 3.2 `routing.service.v1`

```json
{
  "schemaVersion": 1,
  "serviceEnabled": false,
  "listenAddress": "127.0.0.1",
  "preferredPort": 15721,
  "actualPort": null,
  "showLocalQuickControl": false,
  "showFailoverQuickControl": false,
  "usageLoggingEnabled": true
}
```

约束：

- `listenAddress` 只接受 `127.0.0.1`、`::1`、`localhost`；`localhost` 持久化前规范化；
- Windows 存在 WSL takeover 时 listener set 必须包含 IPv4 `127.0.0.1`，即使本地 UI 选择 `::1`；
- `preferredPort` 合法范围 `1024-65535`；
- `actualPort` 是最近一次成功绑定并完成 projection 的端口，停止服务后保留，作为下次启动首选；
- service off 且无 takeover 时可只保存 preferred port；service active 时 preferred/actual 必须随 listener/projection 事务一起提交。

### 3.3 `routing.takeovers.v1`

单个 app 可同时接管 local 与多个 WSL Home，因此不再把 takeover 放进单一 `routing.app.<app>.v1`：

```json
{
  "schemaVersion": 1,
  "items": [
    {
      "appType": "codex",
      "homeIdentity": {
        "environmentKind": "local",
        "environmentId": "host",
        "identity": "local:host"
      },
      "endpointMode": "loopback",
      "advertisedHost": "127.0.0.1",
      "appliedPort": 15721
    },
    {
      "appType": "claude",
      "homeIdentity": {
        "environmentKind": "wsl",
        "environmentId": "Ubuntu",
        "identity": "wsl:Ubuntu"
      },
      "endpointMode": "wsl_gateway",
      "advertisedHost": "172.28.224.1",
      "appliedPort": 15721
    }
  ]
}
```

约束：

- 唯一键为 `(appType, homeIdentity.identity)`；
- items 只保存已提交 takeover；恢复失败的 item 不删除；
- `advertisedHost` 是上次验证成功的 endpoint hint，重启时必须重新解析、校验和主动探测；
- 同 app 的 current provider、failover queue 和 circuit 仍按 app 共享，不按 Home 复制；
- `HomeIdentity` 必须由现有 resolver 规范化，禁止前端提交任意路径伪造 identity。

### 3.4 `routing.app.<app>.v1`

```json
{
  "schemaVersion": 1,
  "autoFailoverEnabled": false,
  "maxRetries": 3,
  "streamingFirstByteTimeout": 60,
  "streamingIdleTimeout": 120,
  "nonStreamingTimeout": 600,
  "circuitFailureThreshold": 4,
  "circuitSuccessThreshold": 2,
  "circuitTimeoutSeconds": 60,
  "circuitErrorRateThreshold": 0.6,
  "circuitMinRequests": 10
}
```

只 seed `claude`、`codex`、`grokbuild`，默认值以 PRD 的 CCS v3.19.2 表为准：Claude 使用 `6/90/180/600/8/3/90/0.7/15`，Codex 与 Grok Build 使用 `3/60/120/600/4/2/60/0.6/10`（字段顺序同上），不 seed Gemini。

### 3.5 Rectifier、optimizer 与 global proxy

`routing.rectifier.v1`：

```json
{
  "schemaVersion": 1,
  "enabled": true,
  "requestThinkingSignature": true,
  "requestThinkingBudget": true,
  "requestMediaFallback": true,
  "requestMediaHeuristic": true
}
```

`routing.optimizer.v1`：

```json
{
  "schemaVersion": 1,
  "enabled": false,
  "thinkingOptimizer": true,
  "cacheInjection": true
}
```

`routing.global_proxy.v1`：

```json
{
  "schemaVersion": 1,
  "url": null,
  "username": null,
  "passwordCredentialAccount": "routing-global-proxy-password"
}
```

密码只存 Windows Credential Manager/macOS Keychain；DB 只保存 opaque account ref。

### 3.6 `routing_request_logs`

```sql
CREATE TABLE routing_request_logs (
  request_id             TEXT PRIMARY KEY,
  app_type               TEXT NOT NULL,
  provider_id            TEXT NOT NULL,
  provider_name          TEXT NOT NULL,
  requested_model        TEXT,
  upstream_model         TEXT,
  started_at_ms          INTEGER NOT NULL,
  duration_ms            INTEGER NOT NULL,
  status_code            INTEGER,
  outcome                TEXT NOT NULL,
  degraded               INTEGER NOT NULL DEFAULT 0,
  attempt_count          INTEGER NOT NULL DEFAULT 1,
  input_tokens           INTEGER NOT NULL DEFAULT 0,
  output_tokens          INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens  INTEGER NOT NULL DEFAULT 0,
  rectifier_flags        TEXT NOT NULL DEFAULT '[]',
  error_code             TEXT,
  created_at_ms          INTEGER NOT NULL
);
```

- 不存 request/response body、headers、auth、完整 URL、原始 upstream error body；
- provider name、requested/upstream model 是历史快照；
- 默认保留 30 天且最多 100,000 行；
- 不自动并入现有 history stats，避免同一 CLI 请求双计数。

## 4. Listener、端口与平台解析

### 4.1 候选端口

固定候选顺序：

```text
last successful actualPort
  -> user preferredPort
  -> 15721..15799 ascending
  -> deduplicate
```

实现必须直接尝试 bind 并持有 socket lease，禁止“先探测空闲、稍后再 bind”的 TOCTOU。

每个候选只有在完整 required listener set 均成功时才可成为 actual port。全部失败返回 `routing_port_range_exhausted`，不得写任何新 Live projection。

### 4.2 Required listener set

```text
Windows:
  configured local loopback
  + 127.0.0.1 when any WSL takeover exists
  + exact validated gateway addresses for NAT-mode distros

macOS:
  configured local loopback only
```

地址去重后共享同一 port。禁止 `0.0.0.0`、`::`、普通 LAN 地址和任意用户输入 gateway。

### 4.3 WSL endpoint resolution

对每个 `wsl:<distro>`：

1. 复用现有 bounded `wsl.exe -d <distro> --exec ...` runner；
2. 在 candidate loopback listener 已持有时，从目标 distro 主动探测 `127.0.0.1:port`；
3. 成功则 endpointMode=`wsl_mirrored`，advertisedHost=`127.0.0.1`；
4. 失败则在目标 distro 读取 IPv4 default route、route device 与该 device 的 CIDR；
5. gateway 必须位于该 WSL interface CIDR，并且必须与 Windows `GetAdaptersAddresses` 返回的本机 unicast 地址精确匹配；
6. 只 bind 该精确 gateway 地址，再从同一 distro 主动探测；
7. 探测成功才允许写 WSL Live；失败返回稳定错误并保持原配置。

探测 helper 采用有界能力链，不假设单一发行版一定安装 curl：优先现有可用 HTTP client，降级到 bash TCP probe；全部不可用返回 `routing_wsl_probe_tool_unavailable`，不猜测“应该可达”。

不自动修改 `.wslconfig`、Windows Defender/Hyper-V firewall、NAT 或 portproxy。防火墙阻断时 UI 提供官方 WSL networking 文档和手工排查提示。

### 4.4 macOS

- daemon 使用独立 process group，GUI 退出后 route 可继续；
- local Home 复用 `environmentKind=local, environmentId=host`；
- Live writer 使用同目录 stage + `fs::rename`，保留 owner-aware merge 与 journal；
- proxy password 使用 Keychain；
- 真实 macOS runner/设备是 Phase 1 exit criterion，不以 Windows 单元测试替代。

### 4.5 运行中 listener 变更

```text
build desired endpoints
  -> allocate candidate ListenerLease
  -> keep old listener serving
  -> project every active (app, HomeIdentity) to candidate endpoint
  -> verify all Live targets
  -> atomically swap runtime listener set
  -> persist preferredPort + actualPort + takeover endpoints
  -> close old listener set
```

若 candidate port 等于当前 actual port，复用未变化 socket，只预绑定 listener delta；不能重复 bind 已持有地址。

任一 projection 失败时补偿已切换 Home 回旧 endpoint。补偿全部成功则释放 candidate，保留旧 listener/actual/Live；补偿不完整则同时保留仍被 Live 引用的 listener set并进入 `routing_recovery_required`，不得关闭任一仍被引用的端口。

## 5. Daemon 与 IPC

### 5.1 capability

新增：

```text
FEATURE_LOCAL_ROUTING_V1 = "local_routing_v1"
```

旧 daemon 未返回 capability 时，GUI 不发送 routing frame，提示重启或先关闭旧 route。协议继续遵守未知字段忽略、未知 type 返回错误、单帧 8 MiB 上限。

### 5.2 控制帧

```text
RoutingReload { id }
RoutingStatus { id }
RoutingStart { id }
RoutingStop { id }
RoutingResetCircuit { id, app_type, provider_id }
RoutingEvent { event }
```

配置、queue、takeover intent 由 Tauri command 写 provider DB；frame 不传 API key、proxy password 或完整 provider document。

Routing control frame 仅允许 Tauri 主进程持有的 NDJSON daemon client 发送。WebView WebSocket 与兼容入口 `pty_legacy_request` 必须返回 `routing_protocol_unsupported`，不能绕过 Tauri 配置校验和用户确认直接 start/stop/reload/reset。旧 daemon 的 feature 列表缺少 `local_routing_v1` 时，调用方必须先返回 `routing_feature_not_supported`，不得发送控制帧。

### 5.3 Tauri commands

```text
routing_get_state
routing_set_service_enabled
routing_set_quick_controls
routing_set_takeover
routing_get_failover_queue
routing_set_failover_enabled
routing_update_failover_config
routing_reset_circuit
routing_get_rectifier_config
routing_set_rectifier_config
routing_get_optimizer_config
routing_set_optimizer_config
routing_get_global_proxy
routing_set_global_proxy
routing_test_global_proxy
routing_scan_global_proxy
```

`routing_set_takeover` 输入必须包含 app type 与完整 HomeIdentity。Rust 边界重新加载 Home preference 并确认 identity/path/environment 一致。

## 6. Takeover 与唯一 Projection Writer

### 6.1 Projection mode

在现有 global writer 内增加内部参数：

```text
ProjectionMode::Direct
ProjectionMode::LocalRoute {
  endpoint,
  sentinel,
  app_type,
  home_identity
}
```

`build_plan`、preview、current、apply、journal recovery 共享该 mode；不新增第二套 Live writer。

### 6.2 开启单个 `(appType, HomeIdentity)`

```text
validate app + Home + current provider + active key
  -> resolve/ensure listener endpoint
  -> acquire provider apply lock(app, Home)
  -> read direct Live + owner fingerprint
  -> reject unexplained owned drift
  -> build route projection
  -> stage + parse + backup + replace + verify
  -> journal commit operation=route_takeover
  -> insert takeover item
  -> notify daemon/UI
```

- bind/probe 必须先于 Live 写入；
- local/WSL/macOS 均使用同一 writer contract；
- 已存在同 key item 时幂等校准 endpoint，而不是重复 backup；
- 不把包含 sentinel 的当前 Live 长期保存为“原始配置”。

### 6.3 关闭单个 takeover

```text
acquire lock
  -> verify route-owned fingerprint
  -> resolve current provider
  -> build Direct projection
  -> stage + replace + verify
  -> journal commit operation=route_restore
  -> remove takeover item
  -> shrink listener set when safe
```

如果 failover 已从 A 切到 B，Direct restore 必须恢复 B。恢复失败时保留 item 与仍被引用 listener。

### 6.4 总开关关闭

逐 takeover item 执行独立 journal。成功项可恢复并删除，失败项保持 route；返回 partial result。只有不存在 active/recovery takeover 后才停止 listener。

### 6.5 route-aware provider 变化

- takeover 关闭：global apply 写 Direct；
- 任一该 app takeover 开启：global apply 更新 current provider，并对该 app 的所有 active Home 写 LocalRoute；
- active key 激活、provider 保存后的 current reapply 走同一逻辑；
- `provider_global_current` 比较对应 projection mode；
- Project/Worktree snapshot 保持 direct；SSH 继续丢弃本地 provider launch config。

## 7. HTTP 请求与模型映射

### 7.1 入口

- 仅注册 Claude `/v1/messages`、Codex `/v1/responses`/`/v1/chat/completions`、Grok `/grokbuild/v1/*`；
- 固定健康探测路径只返回无敏感信息的 readiness；
- body/header 有上限；
- 拒绝 CONNECT、任意 URL forwarding 和客户端 header 指定 provider；
- app type 由 route path 决定。

### 7.2 Immutable provider snapshot

每个逻辑请求/attempt snapshot 包含：

```text
provider id/name/app type
effective settings_config
active key (direct/default preference)
enabled key candidates (route memory only)
key cursor/cooldown generation
base URL / apiFormat / wireApi
Claude role models
advanced.modelMappings
header/body overrides
Bedrock capability
queue order / circuit permit
```

配置 reload 只影响新 attempt；不能组合 old key + new URL。

### 7.2.1 同 provider 多密钥池

- loader 读取同一 `(provider_id, app_type)` 下的 enabled keys，按 `sort_index, id` 稳定排序；active key 作为 daemon generation 的初始 cursor。
- 每个新的 route logical request 选择一个 key；并发请求通过原子 cursor 分散到 candidates，不改变 DB 的 `is_active`。
- 当前 key 在响应提交前返回 `401/403/429` 时，按本次请求尚未尝试的顺序选择下一个 key；key candidates 全部失败后才把控制权交给 provider failover。
- network/TLS/5xx、请求/能力错误和已提交响应后的错误不触发同 provider 全池遍历；避免把 endpoint 级故障伪装成 key 故障或拼接 SSE。
- `401/403` 与 bounded `Retry-After` cooldown 只驻留 daemon 内存；reload/restart 清理并重新从 enabled DB rows 构建池，不自动 disable 用户 key。
- provider snapshot 只在 key pool generation 变更时重载；单个请求始终持有 immutable provider config 与 selected key，禁止混合不同 generation 的 URL/model/key。

### 7.3 模型映射契约

#### Codex/Grok generic mapping

读取现有：

```json
{
  "advanced": {
    "modelMappings": [
      { "source": "a", "target": "b" }
    ]
  }
}
```

- `source` 是 CLI 客户端显示/请求的模型标识；
- `target` 是该 provider 真正收到的上游模型；
- 保存时 trim，空值拒绝；
- source 大小写敏感精确匹配；
- 同 provider 重复 source 拒绝；`a` 与 `A` 可分别存在；
- 无匹配保持原请求模型，再执行 provider 协议所需的已知 catalog/upstream fallback；
- `modelCatalog.displayName` 仅负责 CLI 展示；只有客户端实际请求值进入 source 匹配。

#### Claude role mapping

按 CCS `model_mapper.rs` 读取 `ANTHROPIC_DEFAULT_*_MODEL`、`ANTHROPIC_MODEL` 与 `CLAUDE_CODE_SUBAGENT_MODEL`：

- fable -> fable，缺失时回退 opus；
- haiku/opus/sonnet 按角色匹配；
- subagent exact model 在 default fallback 前保留；
- 未命中角色时才使用 default model；
- display-name 字段只用于 CLI 菜单，不作为 outbound model。

#### Route-only 生效提示

供应商维护弹框的 Claude mapping 与 Codex/Grok mapping 区域均显示双语说明：

> 模型映射只由本地路由在请求转发时执行；关闭路由后 CLI-Manager 不会在请求层重写模型。

Direct projection 仍可包含 CLI 自身的普通默认模型配置，但不得调用 route mapper 或伪造“映射已执行”状态。

### 7.4 每个 attempt 的固定顺序

```text
clone immutable original client body
  -> select provider attempt
  -> select provider key attempt
  -> capture requested_model
  -> resolve this provider's upstream model
  -> apply media/Bedrock pre-processing
  -> protocol conversion
  -> auth/header construction with selected key
  -> apply header/body overrides
  -> re-assert resolved upstream model as final model pin
  -> validate outbound body
  -> send
```

模型映射结果优先于 Body Override 的 `model`。CCS v3.19.2 当前在最终 body override 后允许 `model` 被覆盖；CLI-Manager 按产品要求有意改为 final model pin。

Failover A -> B 时，B 必须从原始 `requested_model=a` 重新计算 B 的 mapping，禁止以 A 的 `targetA` 作为 B 的 source。

同 provider rectifier retry 继承本 attempt 的 resolved model；换 provider 时重新从原始 body 构造。

Key retry 只替换 credential，不重新执行 provider selection；每次 key attempt 仍从同一 immutable original body 构造。一个逻辑请求的 key attempts、provider attempts、rectifier retries 共用 response commit boundary，响应提交后全部禁止切换。

### 7.5 协议与提交点

- Claude 覆盖四种 `apiFormat`；
- Codex/Grok 覆盖 `responses`、`chat_completions`、`anthropic_messages`；
- 非流式完整 body 验证后提交；
- 普通 SSE 等首个可解析事件；
- Responses SSE 等首个语义 output/error，keepalive 不算；
- 响应提交后禁止 rectifier retry/failover，避免拼接两家 provider。

## 8. 自动故障转移

### 8.1 Queue

```text
if autoFailover=false:
  [native current]
else:
  providers where in_failover_queue=1
  order by sort_index, id
  filter enabled + ready + app type + API-key auth
```

- 成员 identity 为 `(provider_id, app_type)`；
- provider attempt 内先执行 route key pool：enabled key candidates 按 cursor/本次未尝试集合选择，key pool 耗尽后才推进 provider queue；
- key-level `401/403/429` 只计入 key cooldown/attempt 结果，不直接打开 provider circuit；同 provider 所有 eligible keys 都失败后才计 provider-level failure；
- 空队列启用时自动把 current 加为 P1；
- 先成功 route-aware switch 到 P1，再保存 enabled；
- 关闭不清 queue、不改变 current。

### 8.2 Circuit

```text
Closed --threshold/rate--> Open
Open --timeout--> HalfOpen
HalfOpen --single permit--> probe
HalfOpen --success threshold--> Closed
HalfOpen --counted failure--> Open
```

- 客户端错误/取消 neutral release；
- config 热更新不 reset；
- daemon 重启从 Closed 开始；
- 手动 reset 不改 queue/current。

### 8.3 Hot switch

fallback B 成功后：

1. app request mutex 内确认 B 仍 ready；
2. 对该 app 所有 active Home 使用 LocalRoute projection 更新 provider-owned target；
3. provider DB transaction 更新 `is_current`；
4. daemon 更新 active target 并发 event；
5. 任一步失败记录 `routing_hot_switch_failed`，当前成功响应可返回，但不得伪造 current 已提交。

## 9. 全局出站代理

### 9.1 共享 client

最小 `network_client`：

```text
NetworkConfig { normalized_proxy, credential_ref, generation }
current_client() -> reqwest::Client
configure_builder(builder) -> Builder
reload(candidate) -> generation
```

使用 `RwLock` 保存当前 config/client；`reqwest::Client` clone。普通 client 与特殊 timeout/redirect builder 均通过同一 configurator。

### 9.2 保存事务

```text
normalize URL
  -> validate scheme/host/port/self-loop
  -> build candidate clients
  -> DB + credential store compensation write
  -> atomically swap generation
```

支持 HTTP/HTTPS/SOCKS5/SOCKS5H。未配置显式 proxy 时遵循系统 proxy；系统 proxy 指向任一 current route listener 时禁用以防自环。

### 9.3 范围

纳入 provider model discovery、model pricing、command suggestion、desktop pet、SSH agent supply-chain download、WebDAV/sync、third-party notification 与 route upstream。

明确例外：CC Connect profile/update proxy、SSH transport、Tauri updater、WebView fetch。

## 10. 整流器

### 10.1 Retry context

每个逻辑请求保存 immutable original body 与 bitset：

```text
signature_retried
budget_retried
media_fallback_retried
```

每条规则每请求最多一次；同 provider retry。仍为 network/5xx 才交给 failover。

### 10.2 规则

- Thinking signature：仅 Anthropic 类明确 signature 错误；
- Thinking budget：仅明确 thinking/budget/max token 约束；
- media fallback：显式 text-only、可选 heuristic、上游明确不支持图片；
- Bedrock：只以 effective `CLAUDE_CODE_USE_BEDROCK=1` 判定；
- failover 到非 Bedrock 从原始 body 重建。

## 11. UI 设计

### 11.1 Routing surface

- 本地路由：service status、preferred/actual port、listener/endpoint、Home takeover 列表、usage logging、metrics；
- 自动故障转移：app queue、health、参数、保存/reset circuit；
- 全局出站代理：URL、username、password state、scan/test/clear/save、例外说明；
- 整流器：总开关、四个 rectifier 子开关、Bedrock 总开关和两个子开关。

本地路由 Home 列表读取现有 `provider_home_preferences`，按 app + Home 展示独立 takeover。local、每个 WSL distro 与 macOS local 均显示实际 advertised endpoint。

### 11.2 Sidebar quick controls

- active session 必须是 `kind=pty`；
- app 由 `cliTool` 解析；
- HomeIdentity 使用会话启动时固化的 routing Home snapshot；旧会话缺失时只在可无歧义推导时回退；
- Windows local、WSL、macOS local 可用；
- SSH、Project/Worktree override、非 PTY、unsupported app 显示原因；
- collapsed/expanded 均有 keyboard、title、aria 和 loading/error 状态。

### 11.3 供应商维护弹框

- `NativeClaudeConfigSection` 与 `NativeProviderAdvancedConfigSection` 增加 route-only 双语提示；
- Codex/Grok mapping 列名明确为“显示/请求名称 -> 实际请求名称”；
- 前端保存前 trim、空值、duplicate source 校验；
- Rust `normalize_settings_config`/provider create/update 再次校验，不能只依赖前端；
- Body Override 说明明确 `model` 会被最终模型映射覆盖。

## 12. 恢复、并发与回滚

| 风险 | 处理 |
| --- | --- |
| preferred/范围端口占用 | 按候选 bind 完整 listener set；范围耗尽不写新 Live |
| daemon 重启 actual port 改变 | 先 bind 新 port，再重投影所有 active Home，最后持久化 actual |
| WSL mirrored/NAT 不可达 | 目标 distro 主动探测失败即拒绝 takeover |
| WSL gateway 伪造/LAN 暴露 | distro route+CIDR 与 Windows local unicast 双重校验；精确 bind |
| listener rebind 中 projection 失败 | 补偿回旧 endpoint；补偿不完整时同时保留仍被引用 listener |
| 单 Live 文件失败 | journal recovery_required；不提交 takeover/current |
| Codex 双文件部分成功 | 两文件 compensation；全部 verify 后 commit |
| 外部修改 owned fields | route-owned fingerprint 冲突，阻止覆盖 |
| provider DB 与 daemon snapshot 不同 | generation reload；请求持有完整 snapshot |
| 多 key 并发 cursor/cooldown 竞争 | per-provider key pool mutex/atomic cursor；单请求去重 key attempts；reload 使用 generation swap |
| key failure 被错误计为 provider failure | 先耗尽 eligible key pool，再提交 provider-level classifier/circuit 结果 |
| 多请求同时 fallback | app mutex 串行 current/hot-switch；普通上游并发 |
| route crash | supervisor 标记 broken；保留 direct restore 入口 |
| GUI 真退出 | route active 显式 retain daemon |
| macOS replace/daemon 差异 | 真实 macOS runner 验证，失败不宣称平台完成 |

## 13. 稳定错误码

```text
routing_app_type_invalid
routing_feature_not_supported
routing_home_invalid
routing_home_identity_mismatch
routing_provider_not_ready
routing_provider_key_not_active
routing_provider_key_pool_empty
routing_provider_key_exhausted
routing_live_drift
routing_port_invalid
routing_port_range_exhausted
routing_listener_set_bind_failed
routing_bind_failed
routing_wsl_unavailable
routing_wsl_probe_tool_unavailable
routing_wsl_gateway_unresolved
routing_wsl_gateway_invalid
routing_wsl_probe_failed
routing_takeover_apply_failed
routing_restore_required
routing_recovery_required
routing_service_unavailable
routing_protocol_unsupported
routing_request_too_large
routing_model_mapping_invalid
routing_model_mapping_duplicate_source
routing_upstream_proxy_invalid
routing_upstream_proxy_self_loop
routing_upstream_proxy_credential_failed
routing_failover_requires_takeover
routing_failover_queue_empty
routing_hot_switch_failed
routing_rectifier_invalid_request
```

错误 DTO 只返回 code、脱敏参数和可操作提示，不返回 token、password、raw body、SQL error 或带 credential URL。

## 14. 设计取舍

| 取舍 | 选择 | 原因 |
| --- | --- | --- |
| route 宿主 | PTY daemon | GUI 退出后 endpoint 仍存活 |
| Settings 入口 | 供应商页第三 surface | 符合用户指定信息架构，避免重复顶级 tab |
| takeover identity | `(appType, HomeIdentity)` | 同 app 可同时覆盖 local 与多个 WSL Home |
| port | preferred + persisted actual + 固定回退范围 | 解决占用且不增加范围 UI |
| WSL | mirrored localhost + NAT exact gateway | 覆盖主流模式且不 wildcard 暴露 |
| config storage | provider DB versioned settings | 复用现有 SSOT，避免四套表 |
| Live writer | 扩展现有 global writer | 一处保证 stage/verify/journal/recovery |
| model mapping | 每 attempt 从原始请求重算，final model pin | failover provider 各用自身映射，Body Override 不破坏结果 |
| multi-key | route-only enabled key pool，active key 初始首选，key exhaustion 后 provider failover | 复用现有 key 表，不扩展 direct/scope 语义；不引入完整 KeyRing |
| proxy password | OS credential store | 跨 Windows/macOS 且不明文入 DB |
| circuit persistence | daemon memory | 避免陈旧 health 阻塞，匹配 CCS |
| project override | 首版 direct bypass | 没有安全 provider identity channel，不暗中注入 route |
| HTTP server | 最小 Hyper 直接依赖 | SSE/streaming 正确性优先，不引入完整 Web framework |
| 协议转换 | 选择性移植 pinned CCS MIT 模块 | 避免自研复杂 SSE/tool/reasoning 转换 |
