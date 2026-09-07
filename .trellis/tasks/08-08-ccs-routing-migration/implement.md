# CCS 路由板块迁移 — 分阶段实施计划

## 1. 交付规则

1. A-01/A-02/A-03 已获批准；任务激活前只更新规划文档，进入实施后仍按 Phase 0 先做影响分析，不直接改生产 symbol。
2. 实施顺序固定：本地路由 -> 自动故障转移 -> 全局出站代理 -> 整流器 -> 集成验收。
3. 每个将修改的函数、方法、组件先执行 GitNexus upstream impact；HIGH/CRITICAL 先报告 blast radius。
4. 每阶段开始前读取 `prd.md`、`design.md`、全部 research 和对应 `.trellis/spec/`。
   A-03 只是在 route daemon 层的明确例外；不得把自动 key 选择扩散到 direct provider domain、Project/Worktree snapshot 或 CLI Live writer，实施完成后在 Phase 3.3 更新对应 contract。
5. 复用 provider DB、Home resolver、global writer、daemon、credential store、`reqwest` 和现有供应商页面；禁止复制第二套 catalog、writer、queue、Home 或 Settings 顶级 tab。
6. 固定 CCS `v3.19.2`/commit `43eaf07355af145aebfee301801779e824d4c221`。复制 substantial MIT 源码时同步更新 `NOTICE` 与 `third-party/cc-switch-LICENSE`。
7. Windows 本地、WSL、macOS 本地是同一 Phase 1 的完成条件，不允许先仅交付 Windows 再把其余平台静默延期。
8. Changelog target 暂设为 `[TEMP]`；版本确定后再更新，不阻塞当前实现规划。
9. 每个 Case 实现与验证后至少进行两轮独立 Review；发现问题后修复并重新计数，只有连续两轮零未解决发现时才允许把代码、测试与进度状态作为该 Case 的独立提交。

## 2. Phase 0 — 影响分析、Schema 与 Fixture 基线

### 2.1 影响分析

- 核对 branch/upstream、CCS pin、安装包 SHA-256、截图与 WSL 官方文档。
- 对首批 symbols 执行 upstream impact：
  - provider DB initialize/schema；
  - `normalize_settings_config`、provider create/update；
  - global `build_plan/preview/current/apply/recover`；
  - active key activation/reapply；
  - enabled key pool loader、route snapshot 与 selected-key auth injection；
  - Home resolver/select/get；
  - daemon protocol/server/client/discovery/idle/shutdown；
  - GUI exit cleanup；
  - `NativeProviderSettingsPage`；
  - `NativeClaudeConfigSection`；
  - `NativeProviderAdvancedConfigSection`；
  - Sidebar active-session derivation；
  - 每个纳入的 HTTP client constructor。
- HIGH/CRITICAL 结果写入阶段记录，用户确认后才改对应 symbol。

### 2.2 Schema v2

- `providers.db` additive migration：
  - versioned routing settings；
  - `routing_request_logs` 与 indexes；
  - v1 -> v2 backup/checksum；
  - future version reject；
  - migration failure 降级 routing，不阻断主应用。
- Seed service/app/rectifier/optimizer/global proxy 默认值。
- 不改变 provider composite key、key 表、Home preferences 与 apply journal 语义。

### 2.3 Sanitized fixtures

协议：

- Claude 四种 `apiFormat`；
- Codex/Grok 三种 `wireApi`；
- JSON/SSE tool call、reasoning/thinking、image/file、usage；
- stream commit：普通 SSE、Responses SSE keepalive、提交后错误；
- rectifier signature/budget/media/Bedrock 错误样本。

模型：

- route off 不执行 generic mapping；
- `a -> b` 精确匹配；
- `a`/`A` 大小写敏感；
- duplicate source 前后端拒绝；
- no match 保持原始模型；
- Body Override 指定其他 `model` 时，最终仍为 mapping target；
- failover A/B 从原始 `a` 分别得到 `targetA`/`targetB`；
- Claude sonnet/opus/fable/haiku/subagent/default；
- Codex catalog model 与 provider upstream fallback。

多密钥：

- 一个 active key + 多个 enabled candidates；
- active key 作为 daemon generation 初始首选，后续请求按 `sort_index` 轮询；
- `401/403/429` 未提交前只尝试本请求尚未使用的下一个 key；
- key pool 耗尽后进入 provider B，B 使用自己的 key pool；
- network/TLS/5xx、400 类能力错误与已提交 SSE 不遍历 key pool；
- concurrent cursor、reload generation、内存 cooldown、restart reset；
- route log 仅含脱敏 key identity，无明文 secret。

Live writer：

- Claude 单文件；
- Codex `auth.json` + `config.toml`；
- Grok model entry；
- local、WSL UNC、macOS local target；
- owned/non-owned drift；
- route sentinel；
- crash recovery；
- 多 Home 批量 projection。

端口/网络：

- last actual、preferred、固定范围去重顺序；
- preferred 占用后回退；
- 完整 listener set 任一地址 bind 失败；
- `15721-15799` 全耗尽；
- daemon restart 复用 last actual；
- WSL mirrored localhost；
- WSL NAT route/CIDR/gateway/local-address 校验；
- WSL probe 失败/工具缺失/防火墙阻断；
- 多 distro 共享/不同 gateway 去重。

### 2.4 主要触点

- `src-tauri/src/provider/database.rs`
- `src-tauri/src/provider/repository/{support,catalog,dto}.rs`
- `src-tauri/src/provider/{home,global}.rs`
- `src-tauri/src/provider/repository/keys.rs`
- `src-tauri/src/daemon/{protocol,server,client,discovery}.rs`
- `src/App.tsx`
- `src/lib/terminalExitCleanup.ts`
- `src/lib/types.ts`
- 新 routing fixture/test 目录

### 2.5 Exit Criteria

- schema、fixture、平台 probe 测试设计可独立运行；
- fixtures 不含真实 token/password/body 隐私；
- HIGH/CRITICAL impact 已报告；
- 未注册可达 routing command/listener；
- 没有新增 Settings 顶级 tab。

## 3. Phase 1 — 本地路由

### 3.1 Routing domain 与 Commands

- 新建最小 routing backend module：
  - versioned DTO；
  - settings repository；
  - `TakeoverKey(appType, HomeIdentity)`；
  - stable error DTO；
  - runtime state DTO；
  - route log repository/cleanup。
- 实现并注册：
  - `routing_get_state`；
  - `routing_set_service_enabled`；
  - `routing_set_quick_controls`；
  - `routing_set_takeover`。
- Rust 边界校验 app、HomeIdentity、provider ready/active key、listen address、preferred port、schemaVersion。
- DTO 不返回 key/password/raw provider document。

### 3.2 PortAllocator 与 ListenerLease

- 实现候选顺序：last actual -> preferred -> `15721-15799`，去重。
- 直接 bind 并持有 socket，不做 check-then-bind。
- 一个 candidate 必须一次满足完整 required listener set。
- running rebind：
  - 复用未变化 socket；
  - 预绑定 listener delta/新端口；
  - 新旧 listener 在 projection 期间并存；
  - 全部 Home verify 后 swap/persist；
  - 失败补偿回旧 endpoint。
- 范围耗尽返回 `routing_port_range_exhausted`，不写新 Live。
- actual port 只在 bind + projection 成功后持久化。

### 3.3 Windows local 与 WSL

- Windows local advertised endpoint 使用规范化 loopback。
- WSL resolver：
  - 从 HomeIdentity 取得 distro；
  - 目标 distro 主动探测 `127.0.0.1:candidate`；
  - 失败时解析 default route、device、CIDR；
  - 用 Windows IpHelper `GetAdaptersAddresses` 校验 gateway 是本机精确 unicast；
  - gateway 必须处于该 WSL interface CIDR；
  - 精确 bind gateway，同 distro 再探测；
  - 成功后才允许 projection。
- 扩展现有 `windows-sys` features，不新增第三方网络枚举依赖。
- 禁止 wildcard、防火墙自动修改、`netsh portproxy`。
- 同 app local + 多个 WSL Home 可同时 takeover。

### 3.4 macOS local

- daemon route host 编译并运行于 macOS；
- local Home 使用现有 Home resolver；
- writer 复用同目录 stage + rename + verify；
- Keychain 用于 global proxy password；
- daemon GUI 退出后仍存活；
- 补齐 `cfg(target_os = "macos")` focused tests；
- 在真实 macOS runner/设备执行 listener、projection、restore、GUI exit 验收。

### 3.5 唯一 Projection Writer

- 在 `provider/global.rs` 增加内部 `ProjectionMode::Direct | LocalRoute`。
- `build_plan`、preview、current、apply、recovery 共用 mode。
- LocalRoute 只覆盖 provider-owned endpoint/auth/model target 与 `CLI_MANAGER_ROUTED` sentinel。
- Takeover enable/disable、service stop、port/listener change、global apply、active key reapply、failover hot switch 全部走同一 apply lock/journal。
- 每 `(app, HomeIdentity)` 独立 journal，批量操作返回 partial result。
- 保持 Project/Worktree direct 与 SSH secret rejection。

### 3.6 Daemon Route Host

- `tokio` 增加 `net` feature；显式声明最小 Hyper 依赖。
- daemon startup 初始化 provider DB、credential store、RoutingSupervisor。
- protocol/discovery 增加 `local_routing_v1` 与 routing frames。
- route active/recovery 计入 busy。
- GUI exit 增加 `retainDaemon` 明确分支。
- 旧 daemon capability/version mismatch 返回可操作状态，不强杀 alive route/PTY。
- 健康探测 endpoint 不返回 provider、key、配置或请求数据。

### 3.7 HTTP Router 与 Provider Adapter

- 注册固定 path/method，拒绝 CONNECT/任意 URL。
- body/header 上限、hop-by-hop 过滤、client disconnect handling。
- 每逻辑请求/attempt 加载完整 immutable provider snapshot。
- 选择性移植 pinned CCS transform/streaming helpers。
- JSON/SSE reverse conversion 覆盖 tool/reasoning/media/usage。
- 活跃连接使用 RAII；逻辑请求与 upstream attempt 分开计数。

### 3.7.1 Route-only 多密钥池

- routing loader 为每个 provider 查询全部 enabled keys，按 `sort_index, id` 排序；active key 仅作为初始 cursor/direct default。
- daemon runtime 使用 per-provider generation + atomic cursor/mutex；reload 原子替换 candidates/cooldown，不修改 DB `is_active`。
- 请求上下文记录已尝试 key IDs；`401/403/429` 未提交前选择下一个 candidate，禁止同一逻辑请求重复使用同一 key。
- key attempts 共用 immutable provider config、原始 body、模型映射和 commit boundary；只替换 auth credential。
- `401/403` unavailable 与 bounded `Retry-After` cooldown 驻留内存；不自动 disable key、不后台探测余额或有效性。
- 全部 eligible keys 耗尽后返回 provider-level classifier，由 Phase 2 决定是否切 provider。
- route state/log 只暴露 key label/masked identity、candidate count、cooldown 状态和 attempt 数，不暴露 secret。

### 3.8 模型映射与 Request Override

- provider save path 解析 `advanced.modelMappings`：
  - trim；
  - 空值拒绝；
  - exact case-sensitive source；
  - duplicate source 拒绝。
- 路由解析：
  - Claude role mapping；
  - Codex/Grok generic source -> target；
  - provider catalog/upstream fallback。
- 每 attempt 从原始 body/requested model 重新解析。
- 请求顺序固定：
  - resolve mapping；
  - media/Bedrock；
  - protocol conversion；
  - header/body overrides；
  - final model pin。
- Body Override 的 `model` 不能覆盖 mapping target。
- route log 分别写 requested/upstream model。

### 3.9 前端

- `NativeProviderSettingsSurface` 扩为 `catalog | home | routing`。
- SegmentedControl 顺序 `供应商目录 / CLI Home / 路由`。
- 不改 `SettingsModal` tab 列表；routing surface 不显示/使用 catalog 搜索。
- routing surface 先完成本地路由 accordion：
  - actual runtime status；
  - service switch；
  - preferred/actual port；
  - listener/advertised endpoints；
  - 按 `(app, Home)` takeover；
  - copy；
  - usage logging；
  - current target/metrics；
  - recovery action。
- `NativeClaudeConfigSection` 与 `NativeProviderAdvancedConfigSection` 增加 route-only 双语提示。
- Codex/Grok 映射列明确“显示/请求名称 -> 实际请求名称”。
- duplicate source、Body Override model precedence 显示明确错误/说明。
- active PTY session 固化 routing Home snapshot；Sidebar quick control 按 `cliTool + HomeIdentity`。
- 完整 `zh-CN`/`en-US`、toast、aria、keyboard、danger dialog。

### 3.10 Focused Verification

Rust：

- schema/settings；
- mapping normalize/duplicate/final pin；
- writer direct/route/multi-Home；
- journal recovery；
- candidate port/listener lease/rebind compensation；
- Windows local/WSL resolver；
- macOS conditional writer/daemon；
- path/method/size；
- JSON/SSE；
- route log redaction。

Frontend：

- provider surface navigation；
- route-only mapping hints；
- duplicate mapping validation；
- routing Home list；
- active session app/Home mapping；
- quick-control disable reason；
- retain-daemon exit helper；
- i18n parity。

人工：

- Windows local Claude/Codex/Grok；
- WSL mirrored；
- WSL NAT gateway；
- local + 多 WSL Home 同时接管；
- macOS local；
- preferred port occupied/range exhausted/port change；
- GUI minimize/tray/true exit/reopen；
- Live drift；
- Codex 双文件失败。

### 3.11 Exit Criteria

- Windows local、WSL、macOS local 三平台均可 takeover/restore；
- preferred 占用可自动落到范围内 actual port；
- 范围耗尽不留下新 route Live；
- provider/key/global apply 在 takeover active 时不写回 direct endpoint；
- 同 provider enabled keys 可轮询，route off/direct/scope 仍只使用 active key；
- `401/403/429` key exhaustion 后才进入 provider failover，network/5xx/400/commit 后不全池遍历；
- mapping/failover-ready request pipeline 已通过 fixtures；
- GUI 生命周期不使 route 失联，也不阻止正常退出；
- unsupported scope/auth/app 无半启用状态。

## 4. Phase 2 — 自动故障转移

### 4.1 Queue 与配置

- 实现：
  - `routing_get_failover_queue`；
  - `routing_set_failover_enabled`；
  - `routing_update_failover_config`；
  - `routing_reset_circuit`。
- 复用 `in_failover_queue` 与 `sort_index`。
- Seed Claude/Codex/Grok CCS 默认值。
- 开启事务：require takeover -> empty queue add current -> switch P1 -> persist enabled；失败补偿自动入队。

### 4.2 Circuit 与 classifier

- per `(app_type, provider_id)` Closed/Open/HalfOpen；
- HalfOpen single permit；
- 单一 classifier 服务 health/retry/UI；
- classifier 先区分 key-level `401/403/429` 与 provider-level network/TLS/5xx；key pool 未耗尽时不污染 provider circuit；
- `max_attempts=max_retries+1`；
- config reload 不 reset；
- cancel/client error neutral release。

### 4.3 Stream commit 与 Hot Switch

- 非流式完整验证后 commit；
- 普通 SSE/Responses SSE 分别定义首包；
- commit 后禁止 failover；
- app mutex 串行 current/hot-switch；
- fallback B 成功后对该 app 所有 active Home route-aware reproject，再提交 DB current/daemon target；
- P1 HalfOpen 达恢复阈值后自动回切。

### 4.4 Mapping 验收

- A/B 相同 source、不同 target；
- A first attempt outbound=`targetA`；
- B fallback outbound=`targetB`；
- A 的 mapped body/Bedrock/media/override 不泄漏给 B；
- route log requested model 始终是原始 `a`，upstream model 记录实际 target。

### 4.5 UI 与 Exit Criteria

- failover accordion：app、queue、health、enabled、参数、save/reset、reset circuit。
- 每个 provider 行显示 route key candidate 数、当前 cooldown 数和“active key 仅为 direct/初始首选”提示；不增加额度/权重 UI。
- Sidebar failover quick control跟随 active app/Home；同 app 任一 Home takeover 时可用。
- Exit：
  - 不在 commit 后切 provider；
  - 不在 commit 后切 key；
  - key pool 耗尽前不推进 provider queue；
  - current/Live/daemon target 并发一致；
  - 关闭 failover 不清 queue/current；
  - daemon restart health 从 Closed 开始。

## 5. Phase 3 — 全局出站代理

### 5.1 Shared network client

- 最小 `network_client`：normalized config、generation、client clone、builder configurator、reload。
- 复用 `reqwest` socks feature。
- 不新增第二套 parser/client framework。

### 5.2 Persistence/Credential/Commands

- 实现 `routing_get/set/test/scan_global_proxy`。
- URL scheme/host/port/self-loop 校验。
- password 仅 credential store。
- candidate client 成功后 DB/credential compensation write，最后 swap。
- scan bounded TCP；test 使用临时 candidate，不保存。

### 5.3 Client cutover

- 纳入：
  - `provider/models.rs`；
  - `model_pricing.rs`；
  - `command_suggestion.rs`；
  - `desktop_pet.rs`；
  - `ssh_agent_supply_chain.rs`；
  - `webdav/mod.rs`；
  - `third_party_notification/http.rs`；
  - route upstream。
- 删除/替换不可热更新 `OnceLock<Client>`，保留各调用点 timeout/redirect/header/auth/size。
- 不改 CC Connect profile/update proxy、SSH transport、Tauri updater、WebView fetch。

### 5.4 UI、Verification、Exit

- proxy accordion：URL、username、password state/clear、scan/test/save、system/direct、exceptions。
- 测试四 scheme、Basic auth、credential compensation、自环、system proxy route-loop、generation hot reload、Windows Credential Manager/macOS Keychain。
- Exit：
  - 纳入触点无需重启；
  - 明确例外不变；
  - DB/DTO/log/event 无 password。

## 6. Phase 4 — 整流器与 Bedrock 优化器

### 6.1 Config 与 Retry Context

- rectifier/optimizer get/set commands、versioned settings、daemon hot reload。
- 每逻辑请求 immutable original body + signature/budget/media bits。

### 6.2 规则移植

- 只移植 pinned CCS：
  - Thinking signature；
  - Thinking budget；
  - media fallback/heuristic；
  - Bedrock thinking/cache。
- 精确 matcher，禁止任意 400 改写。
- Media traversal 覆盖 Claude/Codex/tool/MCP nested blocks。
- Bedrock 只按 effective env。
- 保持 final model pin，不让 rectifier 改回 source/其他 target。

### 6.3 UI、Verification、Exit

- rectifier accordion：总开关、四子开关、Bedrock 总开关、两个子开关。
- golden fixtures 验证一次重试、body diff、failover handoff、非 Bedrock 无泄漏。
- 更新 NOTICE/license。
- Exit：
  - CCS 同等触发条件；
  - 关闭总开关立即无整流；
  - 与 failover 共用 classifier/commit boundary。

## 7. Phase 5 — 集成验收

### 7.1 自动检查

从 focused tests 扩大：

```powershell
rtk cargo test routing --manifest-path src-tauri/Cargo.toml
rtk cargo test provider --manifest-path src-tauri/Cargo.toml
rtk cargo check --manifest-path src-tauri/Cargo.toml
rtk npx tsc --noEmit
rtk git diff --check
```

若新增现有 Node test 体系内的 regression，运行对应 `rtk node --test <files>`。不主动运行 `npm run build/dev` 或 `tauri build/dev`；运行应用由用户明确要求。

### 7.2 平台矩阵

| 平台/环境 | Local endpoint | Home writer | 必测 |
| --- | --- | --- | --- |
| Windows local | loopback | native local files | takeover/restore、port fallback、GUI exit |
| Windows WSL mirrored | `127.0.0.1` | WSL UNC + WSL replace/verify | active probe、多 distro |
| Windows WSL NAT | exact host gateway | WSL UNC + WSL replace/verify | route/CIDR/local-IP validation、firewall failure |
| macOS local | loopback | same-dir rename | daemon detach、Keychain、restore |

### 7.3 功能矩阵

- 三 app、三 wire/API formats、JSON/SSE、tool/reasoning/media/usage；
- model mapping route off/on、duplicate、case、Body Override、A/B failover；
- multi-key route on/off、active-first cursor、concurrent round-robin、401/403/429 key retry、key exhaustion/provider handoff、cooldown reload/restart；
- last actual/preferred/range、range exhausted、rebind rollback；
- daemon crash/restart、GUI minimize/tray/exit/reopen；
- multi-pane、多 CLI、Workspan、非 PTY；
- no current/no key/disabled/draft；
- Project/Worktree bypass、SSH/OAuth/Gemini blocked；
- queue/circuit/reset/P1 recovery/client disconnect；
- four proxy schemes/auth/scan/test/self-loop/CC Connect exception；
- all rectifier switches、Bedrock/non-Bedrock；
- `zh-CN`/`en-US`、1024/1440、keyboard/aria。

### 7.4 文档与范围

- 按 `Changelog Target=[TEMP]` 保留 changelog 占位；版本确定后再更新 changelog，正式交付时同步 `docs/功能清单.md`。
- 更新 provider/daemon/network/routing contracts，只记录已验证事实。
- 运行 GitNexus `detect_changes(scope=all/compare)`。
- 未经用户确认不 commit、不 push、不 archive。

## 8. 回滚策略

| 阶段 | 回滚 |
| --- | --- |
| Schema v2 | additive 保留；旧代码忽略新 settings/log table |
| 本地路由 | journal 恢复 Direct；确认所有 Live 后停 listener |
| Port/listener | 保留旧 listener/actual；补偿新 endpoint projection |
| WSL | 删除失败 takeover intent，恢复 direct WSL Live；不改系统网络 |
| macOS | 恢复 direct local Live；停止 route daemon |
| Failover | 关闭 per-app enabled，保留 queue；重启 daemon 清 circuit |
| Route key pool | 关闭 route key-pool selection，恢复 active-key-only；不改用户 enabled/is_active 数据；重启 daemon 清 cursor/cooldown |
| Global proxy | swap 回旧 generation；补偿 DB/credential |
| Rectifier | 关闭总开关；保留子配置 |
| 协议转换 | 未通过 fixture 的 format 标记 unsupported，不错误 passthrough |

## 9. 开始实现前检查

- [x] 用户批准 PRD A-01 固定端口回退范围。
- [x] 用户批准 PRD A-02 WSL mirrored + NAT exact gateway 边界。
- [x] 用户批准 PRD A-03 route-only 多密钥池与 key exhaustion 后 provider failover。
- [ ] `prd.md`、`design.md`、`implement.md` 与 research 无冲突。
- [ ] CCS pin、安装包 hash、截图与官方 WSL 文档可复核。
- [ ] 当前 branch/upstream 与用户未跟踪文件已识别。
- [ ] 所有首批 symbols upstream impact 已运行；HIGH/CRITICAL 已报告。
- [ ] 用户明确要求开始实现后，才运行 `task.py start`。
