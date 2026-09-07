# CCS 路由板块迁移 — 产品需求

## Changelog Target

`[TEMP]`

## 1. 审批摘要

CLI-Manager 将迁移 CCS v3.19.2 的“路由”板块，但运行时完全归 CLI-Manager 自有 provider domain 与 PTY daemon 管理，不依赖 CCS 进程或数据库。

模块实施优先级固定为：

1. **本地路由**；
2. **自动故障转移**；
3. **全局出站代理**；
4. **整流器与 Bedrock 优化器**。

首版范围固定为：**Windows 本地 CLI、Windows 下 WSL CLI、macOS 本地 CLI + Claude/Codex/Grok Build + 普通 API Key provider**。Gemini 行为已研究记录，但当前 provider domain 不支持；SSH、官方 OAuth 与 Project/Worktree route override 首版不接管。

路由入口固定放在 `设置 -> 供应商` 内，与现有 `供应商目录`、`CLI Home` 同级，形成 `供应商目录 / CLI Home / 路由` 三段导航；不新增设置顶级页签。

任务在执行 `task.py start` 前保持 `planning`；审批已完成，激活后进入 Phase 2 实施流程。

## 2. 产品问题

当前分支已拥有 CLI-Manager 自有的供应商目录、active key、Home resolver、global apply writer 与 provider DB，但缺少 CCS 路由提供的四类运行能力：

- 将 CLI Live 配置安全接管到本地 loopback 服务；
- 在 provider 故障时按队列、timeout 与 circuit breaker 自动切换；
- 给 CLI-Manager 自有外部 HTTP 请求统一设置可热更新出站代理；
- 在特定上游错误下修复 thinking、budget、media 与 Bedrock cache/thinking 请求。

这不是简单“把 Base URL 改成 localhost”：路由必须理解 Claude/Codex/Grok 的协议、流式提交点、provider effective config、active key、逐供应商模型映射、Windows/WSL/macOS Home、Live 文件恢复、GUI/daemon 生命周期和安全边界。

## 3. 证据基线

- UI 证据：`docs/ccs/` 下五张路由页面截图。
- 固定上游：CCS `v3.19.2`，commit `43eaf07355af145aebfee301801779e824d4c221`。
- 安装包：`CLI-Manager_1.3.4_x64-ccs-setup.exe`，SHA-256 `493939688BE236723343ABB7A884CF12AE04AE6DE2B0C1AE13835A636B50788D`。
- 源码与截图映射：`research/source-manifest.md`。
- 每个开关在 CCS 中做什么、怎么做、CLI-Manager 如何实现：`research/ccs-routing-control-matrix.md`。
- CCS 服务、协议、failover、proxy 与 rectifier 运行机制：`research/ccs-runtime-architecture.md`。
- 当前仓库触点与退出生命周期冲突：`research/cli-manager-touchpoints.md`。
- 场景、风险与回滚：`research/scenario-and-risk-matrix.md`。

## 4. 用户价值

1. 用户可在 Windows 本地、Windows WSL 与 macOS 本地 CLI 中开启路由，让新的 Claude/Codex/Grok Build 请求统一进入可观察、可恢复的本机服务。
2. 用户可为每个 CLI 类型维护故障转移队列和独立参数，provider 故障时自动降级并在 P1 恢复后回切。
3. 用户在供应商维护中配置 `a（CLI 请求模型） -> b（供应商实际模型）` 后，开启路由即可保证上游真正请求 `b`；关闭路由时该请求重写不生效。
4. 用户可统一配置 CLI-Manager 自身的 HTTP/HTTPS/SOCKS 出站代理，密码不再像 CCS 一样明文写入 URL。
5. 用户可按需开启 CCS 同等语义的 thinking、budget、media 与 Bedrock 优化规则，并能明确知道规则是否执行。
6. GUI 最小化、托盘或真退出后，已接管 CLI 不会因为 WebView 消失而失去路由 endpoint。

## 5. 功能需求

### R1. 本地路由服务与供应商页入口

- 扩展 `NativeProviderSettingsPage` 的 surface 为 `catalog | home | routing`，导航顺序固定为 `供应商目录 / CLI Home / 路由`；`SettingsModal` 仍只有现有 `native-providers` tab。
- 路由 surface 内四个 accordion 顺序按实施优先级固定为：本地路由、自动故障转移、全局出站代理、整流器。
- 本地路由模块必须展示 daemon 实际状态：运行、停止、恢复失败、端口占用、旧 daemon 不支持；不能只展示持久化开关。
- 总开关开启时先成功 bind 所需 listener set，再持久化 `serviceEnabled=true`。
- 总开关关闭时逐应用恢复 direct projection；只有全部无需保留的 takeover 完成恢复后才停 listener。部分恢复失败时返回 partial result，失败 app 与 listener 保持运行。
- 本地 listener 只允许 `127.0.0.1`、`::1`、`localhost`；WSL NAT 只允许额外绑定目标 distro 实际使用的 Windows host-gateway 地址，禁止 `0.0.0.0`、`::` 与普通 LAN wildcard。
- 保留用户首选端口，默认 `15721`、合法范围 `1024-65535`；首版自动回退范围固定为 `15721-15799`，不增加范围配置 UI。
- daemon 必须持久化并展示 `preferredPort` 与 `actualPort`。候选顺序为“上次成功 actual port -> 首选端口 -> `15721-15799` 升序去重”；只有真实 bind 成功的端口才可成为 actual port。
- 首选/目标端口被占用时自动尝试下一候选；范围耗尽返回 `routing_port_range_exhausted`，不得写入任何新 Live projection。
- 运行中修改首选端口或 listener set 必须执行“预绑定完整新 listener set -> 更新所有已接管 Home projection -> 切换 listener -> 持久化 actual port”；失败保持旧 listener、旧 actual port 和旧 Live。
- Takeover identity 固定为 `(appType, HomeIdentity)`，同一 app 可同时接管 Windows local Home 与一个或多个 WSL Home；failover/current provider 仍按 app 共享。
- Windows 本地与 macOS 本地 Home 使用 loopback endpoint。WSL 先从目标 distro 主动探测 `127.0.0.1:actualPort`；失败时解析并仅绑定该 distro 的 Windows host-gateway 地址，再次探测，成功后才写 WSL Live。
- WSL endpoint 探测、gateway 校验或防火墙连通性失败时返回稳定错误并保留原配置，不允许写入不可达地址冒充支持。
- 支持 Claude、Codex、Grok Build 独立 takeover；开启前校验目标 Home、current provider、enabled/ready 状态和 active API key。
- 路由 provider snapshot 同时加载该 provider 的 enabled key candidates；active key 只作为 direct/scope 的手动凭据和路由初始首选，不把自动 key 选择写回 CLI Live 文件。
- 路由内密钥池按 `sort_index` 轮询；单个逻辑请求在响应提交前遇到 `401/403/429` 时可尝试下一个 key，key candidates 全部耗尽后才进入 provider failover。
- key cooldown/不可用状态只驻留 daemon 内存；配置 reload 或 daemon 重启重建，不做后台余额/有效性探测、配额同步、权重调度或跨重启健康持久化。
- Gemini、官方 Claude/Codex/xAI OAuth 与 SSH 在启用边界明确阻止，不展示可用假开关。
- 服务地址可复制；本地地址和各 WSL Home 的实际 advertised endpoint 分开展示。状态展示每 app 当前 provider、请求模型/上游模型、协议、是否 degraded，不返回 secret。
- 支持“记录请求用量”开关，默认开启；只写独立 `routing_request_logs`，不存 body/header/auth/raw error，不自动并入现有 history request stats。
- 活跃连接、逻辑请求数、成功率、运行时间都以 daemon runtime 为准；重启归零。
- 主页快捷本地路由开关按当前活动 PTY 的 `cliTool + HomeIdentity` 决定；Windows local、WSL 与 macOS local 会话可用，非 PTY、SSH 与 unsupported app 显示不可用原因。

### R2. Live 接管、恢复与 Provider Writer

- 复用现有 `provider/global.rs` 的 plan、stage、parse、backup、replace、verify、compensation、journal 与 recovery，不新增第二套 writer。
- writer 增加内部 `Direct` 与 `LocalRoute` projection mode；现有 provider global commands 外部签名尽量保持。
- Claude route projection 只覆盖 provider-owned endpoint/auth/model 路径，使用 `CLI_MANAGER_ROUTED` sentinel，并保留 Hook、permissions、MCP、projects、statusline 与未知字段。
- Codex route projection 原子管理 `auth.json` 和 `config.toml`，client-facing endpoint 指向 `/v1`，保留 provider 的 `wireApi`、model catalog 与双文件 compensation。
- Grok Build route projection 只改当前 provider-owned model entry 的 base URL/key sentinel，不替换 `GROK_HOME`，不破坏 Hook/MCP/history/skills。
- 供应商维护弹框中的所有“模型映射”区域必须明确显示双语提示：**仅在开启路由后用于请求重写；关闭路由时不会改写请求模型**。
- Codex/Grok 通用映射沿用现有 `settings_config.advanced.modelMappings: [{ source, target }]`：`source=a` 表示 CLI 原始请求模型，`target=b` 表示该供应商实际收到的上游模型。
- `source`/`target` 保存时 trim；`source` 使用大小写敏感精确匹配；同一 provider 内重复 `source` 在前后端都拒绝保存，避免依赖数组顺序产生歧义。
- 路由收到模型 `a` 时，在当前 provider attempt 中必须把最终上游请求模型写为 `b`；无匹配时保留原始模型。模型映射的最终结果优先于请求 Body 覆盖中的 `model` 字段。
- 每个 provider attempt 都从不可变的原始客户端 body 和原始请求模型重新计算映射。failover 从 provider A 切到 B 时，必须应用 B 自己的 `a -> targetB`，禁止把 A 已映射的 `targetA` 继续传给 B。
- Claude 继续使用现有角色/显示名字段，但路由转发阶段同样按当前 attempt provider 解析实际请求模型；direct projection 不执行 route-only 模型重写。
- 关闭 takeover 时恢复“当前 provider”的 direct projection；如果 failover 已把 current 从 A 切到 B，恢复目标必须是 B，不是 takeover 开启前的 A。
- Takeover active 时，global provider apply、active key 激活和 current provider 保存后的 reapply 都保持 Live 指向 route，只更新 route target/provider projection。
- Project/Worktree override 首版继续生成 direct snapshot；SSH 继续拒绝本地 provider secret 注入。UI 明示这些 scope 绕过 route/failover。
- Live owned 字段发生无法解释的外部 drift 时阻止覆盖；non-owned 字段继续 merge 保留。

### R3. Daemon 生命周期与控制协议

- HTTP listener set、forwarder、circuit、rectifier、request metrics 驻留 PTY daemon，不驻留 GUI/Tauri WebView 生命周期。
- 新增 daemon capability `local_routing_v1`；旧 daemon 缺失 capability 时，GUI 不发送 routing frame并提示兼容处理。
- 路由 HTTP port 与 daemon control/WS/hook ports 分离；外部 CLI 只能访问 route port。
- Windows daemon 可同时持有 loopback 与经校验的 WSL host-gateway listener；macOS daemon 只持有 loopback listener。任何 listener 都共享同一 actual port 和 route runtime。
- 路由 active 时计入 daemon busy，idle watchdog 不退出。
- GUI 真退出且 route active 时：按用户选择关闭 PTY，但显式保留 daemon，允许 app exit；不得把 route busy 当成退出失败，也不得错误停止 route。
- GUI 真退出且 route inactive 时保持现有 close_all + shutdown 安全契约；daemon 状态不可信仍阻止静默退出。
- 版本不匹配升级时，有 alive PTY 或 active route 的旧 daemon 不被强杀。
- 配置与队列由 Tauri commands 写入 provider DB；daemon control frame 只负责 reload/status/start/stop/reset circuit。Secret 与完整 provider document 不通过 frame。

### R4. 协议与请求边界

- 只注册 Claude `/v1/messages`、Codex `/v1/responses` 与 `/v1/chat/completions`、Grok `/grokbuild/v1/*`；其他路径返回明确 404/405。
- 不支持任意 URL forwarding、CONNECT 或客户端 header 指定 provider，不能变成正向代理。
- Claude 覆盖 native provider 的四种 `apiFormat`；Codex/Grok 覆盖 `responses`、`chat_completions`、`anthropic_messages` 三种 `wireApi`。
- 非流式与 SSE 转换必须覆盖 tool call、reasoning/thinking、image/file、usage 的 fixture round-trip。
- 请求 body/header 有上限；本地验证错误不访问 provider、不污染 health。
- 每个逻辑请求持有完整 immutable provider snapshot；配置 reload 不能拼接旧 key 与新 URL。
- 每个 attempt 的固定顺序为：克隆原始请求 -> 选择 attempt provider -> 解析该 provider 的模型映射 -> 固定最终 upstream model -> 执行 media/Bedrock 处理 -> 协议转换与 header/auth 构建 -> 发送。后续转换不得把模型改回 `source` 或其他 provider 的 target。
- 只有响应尚未提交给客户端时才允许 rectifier retry 或 failover。普通 SSE 等首个可解析事件；Responses SSE 等首个语义 output/error event，keepalive 不算成功。
- 响应一旦提交，后续静默 timeout/stream error 只终止当前流，禁止切 provider 拼接第二段响应。

### R5. 自动故障转移

- 每个 app 独立 failover enabled、参数、queue view 与 circuit state；takeover 按 `(appType, HomeIdentity)` 维护，首版只显示 Claude/Codex/Grok Build。
- provider failover 与 key failover 分层：同 provider 的 key candidates 先按 A-03 规则尝试，全部失败后才消耗 provider attempt；key-level 失败不得把同一逻辑请求重复计入多个 provider-level failure。
- 队列复用 `providers.in_failover_queue`，顺序复用 provider catalog `sort_index`；不新增第二套顺序。
- 只允许同 app type、enabled、ready、普通 API-key provider 入队；重复添加幂等。
- 开启 failover 要求 app 已 takeover；空队列时自动把 current 加为 P1；先成功切到 P1，再保存 enabled；失败回滚自动入队。
- 关闭 failover 不清队列、不改变 current。
- `maxRetries` 表示初始失败后的额外重试，`maxAttempts=maxRetries+1`，并受可用 provider 数与 circuit 限制。
- 实现 Closed -> Open -> HalfOpen -> Closed；HalfOpen 同 provider 最大一个探测；config 热更新不重置状态；daemon 重启从 Closed 开始。
- DNS、连接、TLS、timeout、5xx、429 和普通 API-key provider/auth/quota 错误可在未提交时切换。
- `400/405/406/413/414/415/422/501` 先给适用 rectifier 一次机会，仍失败按客户端/能力错误返回，不继续 failover。
- 客户端取消/断开 neutral release，不计 provider failure。
- fallback provider 成功后 route-aware hot switch 更新 current 与 Live target；失败可让当前请求成功返回，但不得伪造 DB/current 已提交。
- P1 回切依赖 circuit timeout、HalfOpen 探测与恢复阈值，不通过手工硬重置实现。
- 参数默认值必须与 CCS v3.19.2 对齐：

| 应用 | 重试 | 首字节 | 静默 | 非流式 | 连续失败 | 恢复成功 | 等待 | 错误率 | 最小请求 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Claude | 6 | 90s | 180s | 600s | 8 | 3 | 90s | 70% | 15 |
| Codex | 3 | 60s | 120s | 600s | 4 | 2 | 60s | 60% | 10 |
| Grok Build | 3 | 60s | 120s | 600s | 4 | 2 | 60s | 60% | 10 |

### R6. 全局出站代理

- 支持 `http`、`https`、`socks5`、`socks5h`；URL 必须包含有效 host/port，拒绝 route 自身地址与其他 scheme。
- DB 保存无密码 URL、username 与 credential account ref；密码只存 OS credential store。普通 get DTO 只返回 `hasPassword`。
- 编辑时空 password 默认保留旧值；清除密码需要明确动作。
- 保存顺序为：normalize/validate -> 构建 candidate client -> DB 与 credential store 补偿写 -> 原子 swap runtime generation。任一步失败保留旧持久化与旧 runtime client。
- 未配置显式 proxy 时准确显示“系统代理/直连”；系统代理指向 route 自身时禁用该系统代理，其他本地代理可用。
- 扫描端口固定 `7890/7891/1080/8080/8888/3128/10808/10809`，只报告 TCP reachable candidate。
- 测试使用当前未保存或已保存配置，10s 限时，依次尝试 httpbin、Google、Anthropic，任一成功即通过；不保存，错误脱敏。
- 覆盖 provider model discovery、model pricing、command suggestion、desktop pet、SSH agent supply-chain download、WebDAV/sync、third-party notification 与 local route upstream。
- CC Connect profile/update proxy 保持独立且优先；SSH transport、Tauri updater、WebView fetch 首版不宣称覆盖。
- 首版优先复用现有 `reqwest` + socks feature 与共享 builder；只有 fixture 证明必需时才引入新的 direct HTTP dependency。

### R7. 整流器与 Bedrock 优化器

- 整流器只作用于已经 takeover 的 route 请求，不修改 direct 请求或 CLI 文件。
- 总开关默认开；子开关默认值保留，关闭总开关后不执行。
- Thinking signature：仅 Anthropic 类上游、仅明确 invalid/missing/extra/modified signature 错误；清理非法历史 thinking/signature，同 provider 最多重试一次。
- Thinking budget：仅明确 budget/thinking/max token 约束错误；非 adaptive 时设 `thinking.type=enabled`、`budget_tokens=32000`，缺失/过小 `max_tokens` 设 `64000`；最多一次。
- Media fallback：显式 text-only 能力先处理；可选内置 text-only heuristic；上游 `400/415/422/501` 明确不支持图片时反应式替换；覆盖 Claude/Codex/tool/MCP 嵌套媒体，占位固定 `[Unsupported Image]`，不记录原图。
- 关闭 text-only heuristic 只关闭内置预判，不关闭 provider 显式能力与上游错误 fallback。
- Bedrock optimizer 只由 effective config `CLAUDE_CODE_USE_BEDROCK=1` 判定，不从名称/URL 猜测。
- Thinking optimizer 与 cache injection 的请求修改只存在于本次 attempt；failover 到非 Bedrock 必须从原始 body 重建。
- 每条 rectifier rule 每个逻辑请求最多消费一次 retry bit；重试仍为 network/5xx 才进入 failover，客户端错误直接返回。

### R8. 数据、安全、许可与 UI 质量

- `providers.db` schema 从 v1 升到 v2；routing 配置复用 versioned `settings` JSON keys，另增最小 `routing_request_logs`。
- 未知 settings 字段可忽略；未知 schemaVersion 拒绝写入并保留旧值。
- 路由日志默认保留最近 30 天且最多 100,000 行；不存请求/响应 body、完整 URL、header、auth、原始 upstream error body。
- 路由日志分别保存 `requested_model` 与最终 `upstream_model`，用于验证模型映射和故障转移；模型名可记录，但不得附带请求 body 或密钥。
- 所有 command 输入在 Rust 边界校验 app type、Home、范围、URL、credential ref、provider readiness；错误只返回稳定 code 与脱敏参数。
- 新 UI 文案、toast、状态、tooltip、aria 同步支持 `zh-CN`/`en-US`。
- 供应商页路由 surface 遵守现有 Mantine 与响应式约定；1024px/1440px 无横向溢出；快捷控件 collapsed/expanded 都可键盘操作。
- 如复制 substantial CCS 源码，更新根 `NOTICE` 并新增 `third-party/cc-switch-LICENSE`，记录固定 commit 与 MIT 归属。

## 6. 明确排除

- Gemini provider domain、takeover、failover 与 `/v1beta/*` 运行支持。
- SSH/远端 route、远端 secret 分发、SSH host proxy 改造。
- 官方 Claude/Codex/xAI OAuth token 接管。
- Project/Worktree override 自动进入全局 route/failover。
- Linux 原生桌面版、本地 CLI 以及 WSL 内独立 Linux route daemon。
- 自动修改 `.wslconfig`、自动创建管理员级 Windows/Hyper-V 防火墙规则或使用 `netsh portproxy`。
- 后台主动 key rotation、quota、balance、billing、权重调度、健康持久化、跨重启 key/circuit state。
- LAN listener、远程客户端认证、多用户代理。
- 任意正向代理、CONNECT 暴露、MCP/marketplace/prompt 等 CCS 其他模块。
- Tauri updater、WebView fetch 的全局代理承诺。
- 已经运行的 CLI 进程热重读配置保证。

## 7. 验收标准

### 7.1 本地路由

- [ ] Fresh v1 provider DB 可升级到 v2；原 provider/key/Home/apply journal 数据不变，失败有 backup 且主应用可启动。
- [ ] Windows local、WSL 与 macOS local Home 上，Claude/Codex/Grok Build 普通 API-key provider 可分别开启/关闭 takeover，Live 非 owned 字段保持。
- [ ] Windows local 与多个 WSL Home 可同时保持 takeover；切换当前 Home 不会静默关闭其他已接管 Home。
- [ ] WSL mirrored 与标准 NAT host-gateway 两种路径均有探测用例；不可达、gateway 非本机地址或防火墙阻断时不写 Live。
- [ ] macOS 使用真实 runner/设备验证 daemon 脱离 GUI、loopback bind、同目录原子 replace 和恢复流程。
- [ ] 首选端口被占用时自动选择 `15721-15799` 内可用端口，持久化并展示 actual port；范围耗尽不改 Live。
- [ ] daemon 重启后优先复用上次 actual port；端口变化会重新投影所有已接管 Home。
- [ ] bind/port/apply/verify 任一步失败不留下指向死 route 的新 Live 配置。
- [ ] Codex 任一文件失败时 auth/config 同时补偿，DB 不提交假 current/takeover。
- [ ] GUI 最小化、托盘、真退出、重启后 route 生命周期符合场景矩阵。
- [ ] Route active 的 GUI 真退出可完成；route inactive 的退出安全契约无回归。
- [ ] Project/Worktree/SSH/OAuth/Gemini 均按排除策略明确 bypass 或阻止。
- [ ] 请求统计与 route log 不泄露 secret，不与 history stats 自动双计数。

### 7.2 协议与故障转移

- [ ] Claude 四种 `apiFormat`、Codex/Grok 三种 `wireApi` 的 JSON/SSE fixtures 覆盖 tool/reasoning/media/usage。
- [ ] 路由关闭时 `a` 仍按 direct 配置处理；路由开启后 Codex/Grok `a -> b` 的最终 outbound body 为 `b`。
- [ ] failover A/B 配置不同映射时，每个 attempt 都从原始 `a` 计算，A 发送 `targetA`、B 发送 `targetB`；Body 覆盖不能覆盖最终映射结果。
- [ ] 同 provider 多个 enabled key 按 `sort_index` 轮询，active key 作为初始首选；路由关闭和 direct/scope 路径仍只使用 active key。
- [ ] 未提交响应前的 `401/403/429` 先尝试同 provider 下一个 key，全部 key 耗尽后才进入 provider failover；400 类能力错误、network/TLS/5xx 与已提交流不遍历 key 池。
- [ ] key cooldown 仅存在 daemon 内存，reload/restart 可重建；日志仅记录脱敏 key identity，不记录 secret。
- [ ] 供应商弹框在中英文下明确提示模型映射只在路由开启后生效，并拒绝重复 `source`。
- [ ] 未提交前 timeout/network/5xx 可切换；提交后流错误不切换、不拼接响应。
- [ ] CCS 默认参数、retry 语义、queue 顺序、Closed/Open/HalfOpen 与 P1 回切一致。
- [ ] 客户端断开不污染 health；HalfOpen 只允许一个探测。
- [ ] fallback hot switch 的 DB、Live、daemon target 提交顺序可恢复，并发不乱序。

### 7.3 全局代理与整流器

- [ ] HTTP/HTTPS/SOCKS5/SOCKS5H 保存、清空、扫描、测试、Basic auth 与 self-loop 防护通过。
- [ ] 列出的全局 HTTP 触点会热读取新 generation；CC Connect/SSH/updater/WebView 例外保持。
- [ ] Proxy password 只在 credential store；DB、DTO、event、log、错误均无明文。
- [ ] 每个 rectifier rule 只在精确错误下最多重试一次；关闭总开关后不执行。
- [ ] Media fallback 不记录原图；Bedrock 字段不会泄漏到非 Bedrock provider。

### 7.4 UI 与交付

- [ ] `设置 -> 供应商 -> 供应商目录 / CLI Home / 路由` 与 Sidebar 快捷控件在 `zh-CN`/`en-US`、1024/1440、键盘与 screen-reader 基本路径可用。
- [ ] Stable error code 都有双语映射，无硬编码新增用户文案。
- [ ] 自动测试、`cargo check`、`npx tsc --noEmit`、`git diff --check` 通过；运行应用与构建只在用户明确要求时执行。
- [ ] 若复制 CCS 代码，NOTICE 与 third-party license 完整。
- [ ] GitNexus `detect_changes` 只显示预期 provider/daemon/network/settings/exit flows。

## 8. 已批准决策

### A-01 自动端口范围（已批准，2026-08-08）

首版固定回退范围为 `15721-15799`，保留一个用户可编辑的首选端口，不增加“范围起止”配置 UI。

审批结论：**批准**。后续确有冲突再单独评估开放范围配置。

### A-02 WSL 网络边界（已批准，2026-08-08）

首版同时支持 WSL mirrored localhost 与标准 NAT host-gateway：只绑定探测得到且属于本机 WSL 网络的精确地址，不使用 wildcard，不自动改防火墙；探测失败则拒绝 takeover。

审批结论：**批准，按推荐安全边界实施**。

## 9. 已批准决策

### A-03 同供应商多密钥自动负载（已批准，2026-08-08）

当前 provider domain 的多密钥是手动模式：同一 `(provider_id, app_type)` 最多一个 enabled active key，direct projection、scope snapshot 与模型发现只读取该 active key。当前路由设计也把 failover 成员定义为 provider，并在每个 provider attempt 中只携带一个 active key，因此按现有方案实施时，多个密钥**不会**自动负载或自动切换。

推荐首版增加“仅路由生效的轻量密钥池”：

- direct CLI、Project/Worktree snapshot 与未开启路由时继续使用用户手动选择的 active key；
- 路由开启后，同 provider 下全部 enabled key 按现有 `sort_index` 参与轮询，active key 作为初始首选；
- 上游尚未提交响应且当前 key 返回 `401/403/429` 时，先尝试同 provider 的下一个 eligible key；全部 key 用尽后才进入下一个 provider attempt；
- network/TLS/5xx、请求格式错误与响应已提交后的错误不遍历同 provider 全部 key，继续遵守 provider failover 与流提交规则；
- key cooldown/不可用状态只保存在 daemon 内存，配置 reload 或 daemon 重启可重建；不做后台余额查询、主动有效性探测、配额同步、权重调度或持久化健康历史；
- 日志只记录脱敏 `key_id`/label 与 attempt 结果，不记录明文密钥。

该方案无需修改现有 `provider_api_keys` schema，可复用 `enabled`、`sort_index`、`is_active` 与密钥记录；但需要修改 routing provider loader、immutable snapshot、auth 注入、`provider attempt -> key attempt` 重试层、错误分类、内存 cooldown、日志/UI 状态和并发/SSE/failover fixtures，属于**中等范围**，不是简单改一条查询。由于路由尚未实现，现在纳入设计比后续重构成本低。

完整 KeyRing（额度轮询、权重、余额、后台健康检查、持久化 cooldown/usage）属于大范围扩展，首版不推荐。

审批结论：**批准**。首版按“路由内轮询 + `401/403/429` 同供应商换 key + key 耗尽后换 provider”的轻量密钥池实施；完整 KeyRing 继续排除。
