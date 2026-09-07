# P0-01 影响分析与实现触点

## 1. Case 信息

| 字段 | 结果 |
| --- | --- |
| Case | P0-01 |
| 任务 | 08-08-ccs-routing-migration |
| 执行时间 | 2026-08-08 21:00 起 |
| 机器 | DESKTOP-Q49I074 |
| 分支 | feat/native-provider-management |
| HEAD / upstream | 1652111602cf0d4d5eb293026589161c21ad6336 / 同一提交 |
| 远端差异 | ahead 0，behind 0 |
| GitNexus 索引 | 当前工作树 HEAD 一致，633 files、20321 nodes、49852 edges、300 processes |
| 生产代码修改 | 无；本 Case 只产出分析证据 |

## 2. 执行前置

已读取：

- 任务 prd.md、design.md、implement.md 和全部 research 文档。
- backend、frontend spec index 及 CCS provider domain contracts。
- WSL path、app startup、cc-switch integration、frontend component/state/quality contracts。
- fix-triage、cross-layer、code-reuse、task-delivery guides。
- GitNexus repo context、query 和 upstream impact 结果。

本任务属于新功能，按 fix-triage 的新需求分支执行场景枚举；不采用最小修复路径。

## 3. 端到端数据流

本地路由的目标链路：

1. 路由页面或 Sidebar 快捷控件读取当前 appType、HomeIdentity、provider readiness 和 daemon 实际状态。
2. 前端通过 Tauri routing commands 请求保存 routing settings 或改变 takeover。
3. Rust command 在 provider domain 边界校验 app type、Home、provider、active key、端口、监听地址和配置版本。
   端口候选顺序固定为上次 actual port、用户 preferred port、15721-15799 升序去重；范围耗尽不得写入新的 Live projection。
4. provider DB 持久化 routing.service、routing.takeovers、routing.app 和 request-log 配置；不改变 direct/scope 的 active-key 契约。
5. Tauri daemon client 只发送 capability、reload、status、start、stop、reset-circuit 等控制帧；不发送 API key、proxy password 或完整 provider document。
6. PTY daemon 持有 listener、forwarder、provider snapshot、route-only key cursor、circuit、rectifier 和 runtime metrics。
7. 唯一 projection writer 按 HomeIdentity 将 provider-owned endpoint/auth/model 投影到 Claude、Codex、Grok Home；stage、backup、replace、verify、compensation、journal 必须保持原子性。
8. HTTP router 校验受支持 path，按每个 provider/key attempt 从不可变的原始 body 重算 model mapping、协议转换、整流和 auth/header，再发送 upstream。
9. 在响应提交前，401/403/429 先尝试同 provider 的下一 enabled key；key 耗尽后才进入 provider failover。响应提交后只结束当前流。
10. daemon 只写脱敏 routing_request_logs；UI 读取真实运行状态和脱敏 metrics，不把 route logs 自动并入 history request stats。

明确绕过：

- Project/Worktree scope 首版保持 direct snapshot，不自动进入全局 route/failover。
- SSH、官方 OAuth、Gemini provider 首版不接管。
- CC Connect 显式代理、SSH host proxy、Tauri updater 和 WebView fetch 不被全局代理静默覆盖。
- GUI 生命周期不能成为 active route daemon 的唯一存活条件。

## 4. GitNexus upstream impact 结果

风险按 GitNexus 默认 maxDepth=3 的结果记录。HIGH 只表示修改时必须先审阅直接调用者和执行流，不表示本 Case 已修改代码。

| Symbol | 文件 | 结果 | 直接影响/执行流 | 实施约束 |
| --- | --- | --- | --- | --- |
| initialize_at | src-tauri/src/provider/database.rs | HIGH；54 个受影响符号，6 direct，1 process，4 modules | initialize、open_connection_at 及 4 个 schema tests；间接影响 lib.rs startup | Schema v2 必须 additive；保留启动失败降级、备份、WAL、checksum 和历史 migration |
| normalize_settings_config | src-tauri/src/provider/repository/support.rs | LOW；4 个符号，2 direct | catalog repository 与 commands | mapping normalize 必须保持现有 JSON envelope、secret ownership 和错误码 |
| create_provider | src-tauri/src/provider/repository/catalog.rs | LOW；1 direct | provider command | 新字段兼容 draft/ready/current 和 app_type composite identity |
| update_provider | src-tauri/src/provider/repository/catalog.rs | LOW；1 direct | provider command | 不覆盖 key-manager-owned secret；mapping 保存要和后端 validator 共用 |
| build_plan | src-tauri/src/provider/global.rs | HIGH；6 个符号，3 direct | preview、current、apply | Route projection 只能扩展现有 plan，不能复制 writer；所有 target 继续参与 fingerprint/verify |
| preview | src-tauri/src/provider/global.rs | LOW；当前图谱无直接 upstream 命中 | 由 build_plan 间接连接 | 仍须手工核对 command、frontend hook 和 preview fingerprint |
| current | src-tauri/src/provider/global.rs | LOW；2 direct | provider/global commands/Provider cluster | route current 与 direct current 分离；关闭 route 时以当前 route provider 恢复 |
| apply | src-tauri/src/provider/global.rs | LOW；1 direct | provider_global_apply | route on/off 必须经过同一 apply/recovery transaction |
| recover_pending | src-tauri/src/provider/global.rs | HIGH；4 个符号，1 startup process | provider_global_repair 与 lib.rs run | daemon active 时不能误恢复/停止 route；启动 recovery 要识别 routing generation |
| activate_key | src-tauri/src/provider/repository/keys.rs | LOW；1 direct | provider key command | A-03 不能改 is_active；自动 key selection 只存在 route daemon |
| load_codex_runtime_config | src-tauri/src/provider/runtime.rs | LOW；7 个符号，2 direct | provider commands、CC Connect 间接读取 | route projection 的 sentinel 不得污染 direct runtime detection |
| load_provider | src-tauri/src/provider/scope.rs | LOW；4 个符号，2 direct | scope repository/commands | Project/Worktree 继续绕过 route；provider snapshot 必须 immutable |
| get | src-tauri/src/provider/home.rs | HIGH（maxDepth=3）；16 个符号、4 modules | Home cache、provider/global、commands | local/WSL identity、显式 Home 和 active pointer 不能被 route endpoint 覆盖 |
| select | src-tauri/src/provider/home.rs | LOW；3 个符号 | Home preference/provider | select 只更新 Home preference；不得把 route endpoint 写入 Home identity |
| supported_features | src-tauri/src/daemon/protocol.rs | LOW；6 个符号，4 direct | daemon handshake/status | 增加 local_routing_v1 时保持未知 capability 和旧 daemon 兼容 |
| DaemonServer.run | src-tauri/src/daemon/server.rs | LOW；1 direct | terminal command | route host 驻留不能改变 terminal server 的 bind、websocket 和 idle 语义 |
| connect_or_spawn | src-tauri/src/daemon/client.rs | LOW；6 个符号，2 direct，1 startup process | lib.rs run、terminal commands | route client 要复用 discovery/connection，不生成第二 daemon |
| pty_daemon_shutdown_if_idle | src-tauri/src/commands/terminal.rs | LOW；图谱无 upstream 命中 | 可能存在动态 invoke/GUI wrapper | 必须以 grep 和手工退出矩阵补充 GitNexus 不完整的动态边界 |
| NativeProviderSettingsPage | src/components/settings/pages/NativeProviderSettingsPage.tsx | LOW；1 direct，SettingsModal process | SettingsModal | routing surface 与 catalog/home 同级，不能新增顶级 Settings tab |
| NativeClaudeConfigSection | src/components/settings/providers/NativeClaudeConfigSection.tsx | LOW；1 direct，2 processes | NativeProviderSettingsPage、SettingsModal | Claude role/display mapping 和 route-only generic mapping 不混淆 |
| NativeProviderAdvancedConfigSection | src/components/settings/providers/NativeProviderAdvancedConfigSection.tsx | LOW；1 direct，2 processes | NativeProviderSettingsPage、SettingsModal | Codex/Grok mapping 编辑器需双语 route-only 提示和后端重复校验 |
| SidebarFooter | src/components/sidebar/SidebarFooter.tsx | LOW；1 direct，App/Sidebar processes | App、Sidebar | 快捷开关按 active PTY 的 cliTool + HomeIdentity 派生，非 PTY/SSH/unsupported 禁用 |
| shared_client | src-tauri/src/commands/command_suggestion.rs | LOW；2 direct | command suggestion HTTP requests | 后续 global proxy 使用 generation client，不能破坏 debug/error boundary |
| shared_client | src-tauri/src/webdav/mod.rs | LOW；9 个符号，跨 WebDAV/Sync | WebDAV sync | WebDAV 自有 auth/timeout 保留，proxy client 只替换 transport |
| fetch | src-tauri/src/provider/models.rs | LOW；1 direct | provider model fetch | 全局 proxy 与 route upstream 的 no-proxy/self-loop 规则必须分开 |

### 4.1 HIGH 风险的直接调用者

- database.initialize_at：initialize、open_connection_at，以及 fresh schema、composite identity、backup、idempotence 测试。
- provider.global.build_plan：preview、current、apply；任何 route projection 改动都可能影响 direct global apply。
- provider.global.recover_pending：provider_global_repair 和 lib.rs startup run；恢复顺序必须覆盖 active route。
- provider.home.get：图谱在深层传播到多个 Provider/Commands 模块；Home cache 与显式/默认 Home 解析不能被 listener endpoint 混用。

### 4.2 GitNexus 图谱不完整的边界

以下触点不能只依赖图谱，已列入后续 grep、静态检查和人工场景验证：

- Tauri invoke 字符串、动态 command registration。
- React props/callback 和条件渲染产生的间接调用。
- PowerShell/WSL subprocess、UNC path 和文件 writer 的运行时边界。
- GUI close/minimize/tray callback 与 daemon 的跨进程生命周期。
- reqwest client 的构造闭包、OnceLock 和模块级静态状态。
- 配置 JSON/TOML 中的字符串字段、环境变量和外部 CLI 读取。

## 5. Discovery List

| 触点 | 状态 | 处理结论 |
| --- | --- | --- |
| provider database/schema/migration | confirmed | P0-02 扩展 providers.db；不改 cli-manager.db 历史 migration |
| repository normalize/create/update | confirmed | P0-02/P1-01/P1-13 共用 Rust validator |
| provider key active transaction | confirmed | direct/scope/Live 保持 active key；route-only pool 在 P1-12 单独实现 |
| provider runtime/scope | confirmed | route snapshot 与 scope snapshot 分离；不向 Project/Worktree 扩散自动 key |
| Home resolver/cache/select | confirmed | local/WSL identity 是 takeover identity 的组成部分；P1-04 至 P1-07 |
| global writer/preview/apply/current/recovery | confirmed | 唯一 writer 扩展 LocalRoute mode；P1-08/P2-04 使用 journal/compensation |
| daemon protocol/client/discovery/server | confirmed | 加 capability 和最小 routing frame；复用已有 daemon |
| terminal daemon idle/shutdown/GUI close | partially confirmed | 静态 symbol 已找到；动态 Tauri/React close callback 需 P1-10 手工补齐 |
| provider settings page/editor/modal | confirmed | routing surface、mapping hint、i18n/a11y 纳入 P1-13/P1-14 |
| Sidebar active PTY derivation | confirmed | P1-15，需覆盖多窗口、分屏、Workspan、WSL、SSH |
| provider model HTTP fetch | confirmed | P3-03/P3-04 纳入 shared client 和 no-proxy 规则 |
| command suggestion/WebDAV/notification/model pricing 等外部 HTTP | confirmed | P3-03 分批切换，保留各自 auth/timeout |
| CC Connect explicit proxy | confirmed unrelated for global proxy | 不被全局代理静默覆盖 |
| SSH remote secret/proxy | confirmed unrelated for route takeover | 首版不投影本地 key/route endpoint 到 SSH |
| Tauri updater/WebView fetch | confirmed unrelated | 首版不宣称全局代理覆盖 |
| history parser/stats | confirmed unrelated | routing_request_logs 独立存储，不并入 history stats |
| existing terminal output scheduling | confirmed unrelated | route runtime 不改 terminal frame scheduling；仅复用 daemon 生命周期契约 |

## 6. 场景枚举

### UI 与会话状态

- 当前窗口焦点、其他窗口焦点、应用未聚焦。
- 当前 pane、同窗口其他 pane、深层 split tree。
- 正常窗口、最小化、托盘、GUI 真退出、GUI 重启。
- 单 session、多 session、多 Workspan、切换 active PTY。
- route active/inactive、takeover partial、daemon crash/restart。
- 无 PTY、SSH session、unsupported app、无 current provider、无 active key。

### 平台与 Home

- Windows local Home。
- Windows WSL mirrored localhost。
- Windows WSL NAT exact host-gateway。
- 多个 WSL distro 且 gateway/可达性不同。
- macOS local Home、真实 runner、Keychain。
- main repo、Worktree、项目目录消失、显式 Home 与默认 Home 冲突。

### 请求与 provider

- Claude/Codex/Grok Build。
- 非流式 JSON、普通 SSE、Responses SSE keepalive 和 output/error event。
- route off/on。
- mapping 无匹配、a -> b、大小写、重复 source、Body Override。
- provider A/B mapping 不同。
- 单 key、多 enabled key、active-first、并发 cursor、reload、daemon restart。
- 401/403/429、network/TLS/timeout/5xx、能力错误、响应已提交后静默流错。
- failover queue empty/non-empty、Closed/Open/HalfOpen、manual reset。

### 网络、日志与安全

- global proxy 空配置、HTTP/HTTPS/SOCKS5/SOCKS5H、Basic auth、扫描、测试、清空。
- proxy 指向 route endpoint 的自环。
- CC Connect、SSH、updater、WebView 的显式例外。
- request log 开关、30 天/100,000 行边界、body/header/auth/secret 脱敏。
- 旧 daemon capability、未知 frame、超长 frame、错误 DTO 中的 secret redaction。

## 7. P0-01 Exit Criteria

- [x] 完成 branch/upstream/HEAD 和 CCS evidence 基线核对。
- [x] 完成 backend/frontend/spec 与 thinking guide 读取。
- [x] GitNexus 索引与当前 HEAD 一致。
- [x] 完成 provider、writer、Home、daemon、UI、network 六类 query。
- [x] 完成首批 symbol upstream impact。
- [x] 记录 4 个 HIGH 风险结果及直接调用者。
- [x] 记录 GitNexus 不覆盖的动态边界。
- [x] 完成跨窗口、分屏、WSL、Worktree、Hook、GUI 生命周期和请求边界场景枚举。
- [x] 通过两轮独立 Review：R1/R2 发现并修复路径、风险标注和 A-01 范围遗漏；修复后 R3/R4 连续两轮零未解决发现。
- [x] 完成 `docs(routing): record P0-01 impact baseline` 独立提交前准备，并将 progress.md 指针切换到 P0-02。

### 7.1 Review 记录

| 轮次 | 检查范围 | 结果 | 处理 |
| --- | --- | --- | --- |
| R1 | 触点完整性、HIGH 风险、安全边界 | 发现路径不完整、Home get/select 风险聚合不精确、旧 daemon 列表格式问题 | 全部修复并重新检查 |
| R2 | PRD/设计一致性、场景矩阵、结构 | 发现 A-01 的 15721-15799 精确范围未写入报告 | 已补充候选顺序与耗尽行为 |
| R3 | 决策覆盖、三平台、排除范围、secret boundary、路径和表格结构 | 零发现 | 通过，连续零发现 1/2 |
| R4 | Case 状态机、Review 规则同步、工作树范围、JSON/Trellis/空白 | 零发现 | 通过，连续零发现 2/2 |
| R5 | Review 证据、Case 数量、Trellis 与任务文档一致性 | 零发现 | 通过，提交前元数据复核 |
| R6 | 完成状态迁移、当前指针、提交元数据与路径检查 | 发现 progress.md 顶部仍写“当前从 P0-01 推进” | 已修正为 P0-02；连续零发现计数重置 |
| R7 | R6 修复后的当前指针、Case 状态、提交边界和 staged 文件范围 | 零发现 | 通过，连续零发现 1/2 |
| R8 | PNG 签名、JSON/JSONL、路径、空白和生产文件隔离 | 检查脚本的 PNG 字面量转义造成误报，未发现文档或资产漏洞 | 改用 `bytes.fromhex('89504e470d0a1a0a')` 复验；R8B 零发现，连续零发现 2/2 |
| R9 | staged 文件边界、diff whitespace、Trellis validate 和生产代码隔离 | 零发现 | 通过，连续零发现 1/2 |
| R10 | JSON/JSONL 可解析性、PNG 签名、18 文件清单和当前指针 | 零发现 | 通过，连续零发现 2/2 |

## 8. 下一步

P0-02 将只处理 providers.db additive schema v2、routing settings、routing_request_logs、索引和迁移测试。修改 database.initialize_at 或相关 schema symbol 前，必须重新核对本报告的 HIGH 风险直接调用者，并执行针对该 symbol 的 GitNexus impact。
