# CCS 路由控制矩阵

## 1. 阅读方式

本矩阵逐项回答三件事：

1. 控件在 CCS 中做什么；
2. CCS 如何实现；
3. CLI-Manager 首版如何实现和验收。

“首版”固定指 **Windows 本地 CLI、Windows WSL CLI、macOS 本地 CLI + Claude/Codex/Grok Build + 普通 API Key 供应商**。Gemini、SSH、官方 OAuth 和 Project/Worktree route override 的边界在末尾单列。

## 2. 本地路由

### 2.1 页面与运行控件

| 控件/信息 | CCS 中做什么 | CCS 如何实现 | CLI-Manager 首版实现与验收 |
| --- | --- | --- | --- |
| 模块状态徽章 | 显示本地路由服务“运行中/已停止” | 轮询 `get_proxy_status`，状态来自进程内 `ProxyServer` | `routing_get_state` 返回 daemon 实际监听状态；不能只读持久化开关。显示运行、停止、恢复失败、端口占用和旧 daemon 不支持等状态 |
| 在主页显示本地路由开关 | 仅控制首页是否显示当前应用的快捷接管开关，不启动服务 | 保存在普通 settings；首页 `ProxyToggle` 依据 `activeApp` 显示 | 保存在 provider DB 的 routing settings；`SidebarFooter` 按活动 PTY 的 `cliTool + HomeIdentity` 显示。Windows local、WSL、macOS local 可用；Shell 本身、SSH、非 PTY 或不支持应用时禁用并说明原因 |
| 路由总开关 | 启动/停止本地 HTTP 路由服务 | 启动默认 `127.0.0.1:15721`；手动关闭时停止服务、恢复所有 Live 配置、清除逐应用接管状态、删除敏感备份、清健康状态；保留故障转移队列和参数 | daemon 托管监听服务。开启先完成 bind，再写 `serviceEnabled=true`；关闭按应用恢复 direct projection，全部成功后停服务并清接管状态。任何恢复失败时服务继续运行，避免留下指向死端口的 Live 配置 |
| Claude 接管 | 让 Claude Code 的请求经过本地路由 | 自动启动服务；备份 Live；把当前 Live 凭据同步到 CCS DB；写本地 Base URL 和 `PROXY_MANAGED`；保存 `proxy_config.enabled` | 支持 Windows local、WSL 与 macOS local 的规范化 Home；校验 ready/current provider 和 active API key。复用 native provider effective config 与 global writer，把 provider-owned endpoint/key 投影为路由和 `CLI_MANAGER_ROUTED` sentinel；非 owned 字段保持不变 |
| Codex 接管 | 让 Codex 请求经过本地路由 | 写 `http://host:port/v1`、`wire_api=responses`、模型/目录；第三方供应商在 `auth.json` 写 sentinel；官方 Codex 保留原生认证 | 支持 Windows local、WSL 与 macOS local；普通 API-key provider 写 `/v1` endpoint，保留当前 provider 的 model catalog/模型映射并写 sentinel。官方 Codex OAuth 不显示可用开关，返回稳定“不支持”原因 |
| Gemini 接管 | 让 Gemini CLI 请求经过本地路由 | 写 `GOOGLE_GEMINI_BASE_URL` 和 `GEMINI_API_KEY=PROXY_MANAGED`；路由 `/v1beta/*` | 研究结论保留，但首版不显示 Gemini 开关。当前 native provider domain 不接受 `gemini`，不得增加无后端能力的假 UI |
| Grok Build 接管 | 让 Grok Build 请求经过本地路由 | 选中模型的 `base_url` 改为 `/grokbuild/v1`，`api_key` 写 sentinel；官方 OAuth 无自定义模型表时拒绝 | 支持 Windows local、WSL 与 macOS local；普通 API-key provider 写 `/grokbuild/v1` 和 sentinel；保留 Grok Home、Hook、MCP、history 与 skills。xAI OAuth/无自定义模型配置首版拒绝 |
| 服务地址/复制 | 显示可供 CLI 使用的本地 URL，并可复制 | 从全局 proxy config 的 host/port 组成 URL；IPv6 加方括号 | 显示 `actualPort` 与每个 Home 的实际 advertised endpoint。Windows local/macOS 使用 loopback；WSL mirrored 显示 `127.0.0.1`，NAT 显示经过校验的精确 host-gateway；禁止 wildcard/LAN 地址 |
| 监听地址 | 配置 bind host，变更后重启生效 | UI 接受 IPv4、IPv6、localhost，后端保存 `listen_address` | 只接受 `127.0.0.1`、`::1`、`localhost`；WSL takeover 时强制 required listener set 包含 IPv4 loopback。运行中变更先预绑定完整 listener set，失败保留旧 listener |
| 监听端口 | 配置 bind port；固定端口占用时 `ProxyServer.start()` 直接失败；`listen_port=0` 由 OS 分配并在启动后持久化 actual port | `TcpListener::bind(address:port)` 后读取 `local_addr().port()`；`persist_ephemeral_listen_port_if_needed` 只在配置为 0 时写回 | 明确增强为候选 bind：上次 actual -> preferred -> `15721-15799` 升序去重；完整 listener set 成功后才提交 actual。端口变化必须重新投影所有已接管 `(app, HomeIdentity)`，不能出现部分 Home 指向旧端口 |
| 当前 Provider/活动目标 | 显示请求当前实际使用的供应商 | `ProxyStatus.current_provider` 和 per-app `active_targets` 由 forwarder 更新 | 展示每个已接管应用的 active provider、ID、模型/协议、是否因故障转移降级；不在普通状态 DTO 中返回密钥 |
| 同供应商多密钥池 | CCS v3.19.2 路由证据按 provider 选择，未提供 CLI-Manager 当前手动 active-key 之外的统一 key-pool 契约 | 当前 CLI-Manager `provider_api_keys` 只保证一个 active key；runtime/scope 默认只加载它 | A-03：仅 route 开启时加载全部 enabled keys，按 `sort_index` 轮询，active key 为初始首选；`401/403/429` 未提交前换同 provider key，key 耗尽后才换 provider；不修改 `is_active` |
| 记录请求用量 | 开关路由请求用量与状态写入本地数据库 | `enable_logging` 控制 SSE/JSON usage 解析及 `proxy_request_logs` 写入 | 默认开启。写独立 `routing_request_logs`，按“一个客户端逻辑请求”记录最终供应商、attempt 数、token、耗时、状态和 rectifier 标记；不记录 body/header/凭据，不与现有 history request logs 重复合并 |
| 故障转移队列概览 | 在本地路由模块只读显示各应用队列及健康状态 | 复用 `providers.in_failover_queue` 和 `sort_index`，读取 circuit/health | 复用 native `providers.in_failover_queue` 和 `sort_index`，不建第二套队列表。显示 P1…Pn、Closed/Open/HalfOpen、降级原因和手动重置入口 |
| 活跃连接 | 当前仍在处理的客户端逻辑请求数 | forwarder RAII guard +1/-1 | daemon 中使用 RAII guard；流式响应必须在 body 真正结束或客户端断开时才减 1 |
| 总请求数 | 本次服务启动后的逻辑请求数 | 内存状态计数 | daemon 内存计数，重启归零；不等于上游 attempt 数 |
| 成功率 | 成功逻辑请求 / 总逻辑请求 | forwarder 成功/失败计数计算 | 最终返回成功才计成功；经过 rectifier/failover 后成功仍计成功，同时单独记录 attempts 和 degraded 标志 |
| 运行时间 | listener 本次启动时长 | `Instant` 计算 | daemon listener 启动时间计算；持久化开关开启但 listener 启动失败时不得显示为运行中 |

### 2.2 CCS 的逐应用 Live 投影

| 应用 | CCS 写入 | CLI-Manager 计划 |
| --- | --- | --- |
| Claude | `env.ANTHROPIC_BASE_URL=http://host:port`；替换 `ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_API_KEY`、`OPENROUTER_API_KEY`、`OPENAI_API_KEY` 为 `PROXY_MANAGED`；无认证键时补 `ANTHROPIC_AUTH_TOKEN`；保留/写供应商模型覆盖 | 先由 native provider writer 生成 effective direct document，再只覆盖 writer-owned endpoint/auth paths；使用 `CLI_MANAGER_ROUTED`；保留 Hook、permissions、MCP、projects、statusline、未知字段 |
| Codex | `base_url=http://host:port/v1`；强制 `wire_api=responses`；写模型/目录；第三方 provider 的 `auth.OPENAI_API_KEY=PROXY_MANAGED`；原子写 `auth.json`/`config.toml` | 复用 Codex 双文件 stage/backup/replace/verify/compensation；按 provider `wire_api` 保留运行时兼容信息，但 client-facing route endpoint 固定 `/v1`；仅 API-key provider 写 sentinel |
| Gemini | `GOOGLE_GEMINI_BASE_URL=http://host:port`；`GEMINI_API_KEY=PROXY_MANAGED` | 仅记录为后续兼容目标，不进入首版 schema/UI/验收 |
| Grok Build | 当前模型 `base_url=http://host:port/grokbuild/v1`；`api_key=PROXY_MANAGED` | 复用 Grok writer，只改当前 provider-owned model entry；不替换 `GROK_HOME`，不破坏 Hook/MCP/history/skills |

### 2.3 CCS 路由端点与 CLI-Manager 兼容矩阵

| 入站应用/路径 | CCS 行为 | CLI-Manager 首版要求 |
| --- | --- | --- |
| Claude `/v1/messages` | 选择 Claude provider；根据 `api_format` passthrough 或转换为 Anthropic、OpenAI Chat、OpenAI Responses、Gemini Native | 支持 native provider 已暴露的四种 `apiFormat`；非流式和 SSE 双向转换均需 fixture 测试 |
| Codex `/v1/responses` | 选择 Codex provider；可直发 Responses，或转换为 Chat/Anthropic；对 Responses SSE 先做语义验证 | 支持 `responses`、`chat_completions`、`anthropic_messages` 三种 `wireApi`；工具调用、reasoning、图片/文件和 usage 必须 round-trip |
| Codex `/v1/chat/completions` | 接受 OpenAI Chat 路径并按 provider 规则转发 | 接受并路由；如果当前 provider 仅支持 Responses/Anthropic，执行对应转换 |
| Gemini `/v1beta/*` | Gemini 原生转发/转换 | 首版返回不支持，不注册 Gemini takeover |
| Grok `/grokbuild/v1/*` | 选择 Grok Build provider，复用 Codex/Responses 兼容层 | 支持 Grok `responses`、`chat_completions`、`anthropic_messages`；xAI 特有字段只移植当前 native provider 实际使用的最小集合 |
| 其他路径 | 拒绝或 404 | 明确 404/405；不能把本地路由变成任意正向代理 |

### 2.4 接管生命周期差异

- CCS 正常退出会恢复 Live 文件但保留逐应用 `enabled`，下次启动重新接管。
- CLI-Manager 的 PTY daemon 可在 GUI 退出后继续存活。首版采用 daemon-hosted route service：窗口关闭、最小化、托盘和 GUI 重启不停止路由；用户显式关闭路由时才恢复 Live。
- CLI-Manager 不长期保存含明文 token 的 `proxy_live_backup`。接管前要求 Live provider-owned 状态与 native current provider 可解释；writer journal 的临时备份在提交/恢复后删除。

### 2.5 模型映射与请求覆盖

| 配置/行为 | CCS 中做什么 | CCS 如何实现 | CLI-Manager 首版实现与验收 |
| --- | --- | --- | --- |
| Claude 角色映射 | 把 Claude 客户端请求的 sonnet/opus/fable/haiku/default 映射到当前 provider 的实际模型 | `proxy/model_mapper.rs` 从 `ANTHROPIC_DEFAULT_*_MODEL`、`ANTHROPIC_MODEL`、`CLAUDE_CODE_SUBAGENT_MODEL` 解析；角色判断大小写不敏感，fable 缺失时回退 opus，最后回退 default | 复用相同角色语义；每个 provider attempt 从原始客户端模型重新解析。display-name 字段只用于 CLI 菜单，不作为 outbound model |
| Codex 模型目录 | 给 `/model` 菜单生成 model catalog，并在 Chat/Anthropic upstream 时确定真实模型 | `modelCatalog.models[].displayName` 只控制菜单显示；`models[].model` 是 catalog model id。请求 model 不在 catalog 时，`apply_codex_upstream_model` 回落到 provider 配置的 upstream `model` | 现有 `advanced.modelMappings[{source,target}]` 明确承载“显示/请求名称 -> 实际请求名称”；source 精确大小写匹配，target 是最终 upstream model |
| Grok 实际模型 | 稳定的 client-facing profile 转为 provider 实际模型 | forwarder 在协议转换前调用 `apply_codex_upstream_model` | 与 Codex generic mapping 共用 resolver；Grok provider attempt 使用自己的 target |
| 每次 attempt 重算 | failover 后新 provider 使用自己的映射和配置 | forward loop 为每个 provider clone 原始 body；`forward()` 内重新调用 model mapper | 必须从原始 `requested_model` 重算，A 的 `targetA` 不得成为 B 的 source |
| Header Override | 覆盖允许的上游 header，认证/Content-Type 等受保护 | `apply_local_proxy_header_overrides` 在 auth/header 构建后执行并过滤危险项 | 保留安全 allow/deny 语义；不得覆盖 route auth、proxy auth 或 hop-by-hop header |
| Body Override | 深合并协议转换后的最终 body；`stream` 保持客户端语义 | `apply_local_proxy_body_overrides` 在 mapping/协议转换之后执行，因此 CCS 当前允许 override 中的 `model` 覆盖前面的映射结果 | 按用户要求有意不同：Body Override 后重新执行 final model pin，mapping target 优先于 override 的 `model` |
| 供应商弹框提示 | CCS 部分高级文案提示某些格式需路由，但没有统一声明所有映射只在路由层执行 | 分散在 Claude/Codex 表单 i18n hint | Claude 与 Codex/Grok 所有“模型映射”区域统一显示中英文提示：只有开启本地路由后，CLI-Manager 才会在请求层执行映射 |

保存规则：

- source/target trim；
- 空 source/target 拒绝；
- 同 provider duplicate source 拒绝；
- source 大小写敏感，因此 `a` 与 `A` 可分别配置；
- 路由关闭时不调用 route mapper；
- route log 同时记录 `requested_model` 与 `upstream_model`。

## 3. 自动故障转移

### 3.1 可见控件

| 控件 | CCS 中做什么 | CCS 如何实现 | CLI-Manager 首版实现与验收 |
| --- | --- | --- | --- |
| 在主页显示故障转移开关 | 显示当前 `activeApp` 的快捷 failover 开关 | 普通 UI preference；`FailoverToggle` 按当前应用读取/写入 `auto_failover_enabled` | `SidebarFooter` 按活动 PTY 的 app/Home 显示。Windows local、WSL、macOS local 均可用；该 app 没有任何 active takeover、SSH、非 PTY 或无可用队列时禁用并给出原因 |
| 应用标签 Claude/Codex/Gemini/Grok | 每个应用独立队列、开关和参数 | `proxy_config` 每应用一行 | 首版只显示 Claude/Codex/Grok。每应用独立 settings JSON、circuit state 和队列过滤 |
| 自动故障转移 | 立即切到 P1；失败时按 P1→Pn 尝试 | 开启要求应用已接管；空队列自动把 current 加入 P1；先切 P1，成功后才保存 enabled；关闭不删除队列 | 完全保持该事务顺序。内部 route apply 失败时不得留下 enabled=true；关闭只停止自动选择，不改变 current、不删队列 |
| 同 provider key failover | CCS 的 429/认证失败可因不同 key/额度而成功，但固定版本证据不等于 CLI-Manager 已有自动 key pool | CCS `forwarder` 的 provider attempt 与当前 CLI-Manager active key 解析是 provider 级 | 先执行 A-03 key pool；key-level `401/403/429` 不直接打开 provider circuit；全部 eligible keys 失败后才推进 P1→Pn；网络/TLS/5xx 直接走 provider-level 分类 |
| 添加供应商 | 把 provider 加入队列 | 更新 `providers.in_failover_queue=1` | 复用同一字段；只允许 enabled、ready、同 app type、普通 API-key provider。重复添加幂等 |
| 移除供应商 | 从队列移除 | 更新 `in_failover_queue=0` | 同上；如果移除当前 P1/active provider，后续请求重新按剩余顺序选择；空队列时 failover 自动关闭或阻止保存 |
| 队列优先级 | P1 优先，顺序来自 provider `sort_index` | DAO `ORDER BY COALESCE(sort_index...), id` | 复用 native provider catalog 排序，不增加单独拖拽顺序；UI 明示“队列顺序跟随供应商目录排序” |
| 最大重试次数 | 一次初始尝试失败后最多再试 N 次 | `max_attempts=max_retries+1`，同时受队列长度限制 | 同语义，范围 `0-10`；不得把值误解为总尝试数 |
| 失败阈值 | 连续失败达到阈值打开熔断器 | `consecutive_failures >= threshold` | 同算法；范围 `1-20` |
| 流式首字节超时 | 等待第一个可提交数据的最长时间 | timeout 前可切 provider | 同语义，范围 `1-120s`；Responses 必须等首个语义有效事件，而非任意字节 |
| 流式静默超时 | 相邻流数据最大间隔；`0` 禁用 | 提交前超时可切换；提交后不能切换 | 同语义，范围 `0-600s`；提交后只结束当前流并记录错误，禁止把第二个 provider 的流拼给客户端 |
| 非流式超时 | 完整响应的总超时 | 读完整 body 后才记成功 | 同语义，范围 `60-1200s` |
| 恢复成功阈值 | HalfOpen 连续成功多少次后 Closed | 单 HalfOpen permit；达到阈值重置计数 | 同语义，范围 `1-10` |
| 恢复等待时间 | Open 后等待多久进入 HalfOpen | `last_opened_at.elapsed >= timeout` | 同语义，范围 `0-300s`；`0` 允许立即进入 HalfOpen，但同一 provider 仍只放行一个探测请求 |
| 错误率阈值 | 请求数达到最小值后，错误率达到阈值则 Open | 从 Closed 周期累计 `failed/total`；Closed 恢复时清零 | 同算法以保持 CCS 兼容，范围 `0-100%` |
| 最小请求数 | 开始计算错误率前的样本下限 | `total >= min_requests` | 同语义，范围 `5-100` |
| 重置 | 放弃未保存编辑，恢复数据库当前值 | 前端重建 form state，不写数据库、不重置 circuit | 同语义；另设清晰的“重置熔断器”动作，不能混用 |
| 保存 | 一次保存该应用全部参数 | UI 范围校验，后端持久化；运行时 config 热更新 | Rust 再验证后事务保存；daemon 热更新 circuit config，但不重置当前 Closed/Open/HalfOpen 状态 |

### 3.2 CCS v3.19.2 默认值

| 应用 | 重试 | 首字节 | 静默 | 非流式 | 连续失败 | 恢复成功 | 等待 | 错误率 | 最小请求 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Claude | 6 | 90s | 180s | 600s | 8 | 3 | 90s | 70% | 15 |
| Codex | 3 | 60s | 120s | 600s | 4 | 2 | 60s | 60% | 10 |
| Gemini | 5 | 60s | 120s | 600s | 4 | 2 | 60s | 60% | 10 |
| Grok Build | 3 | 60s | 120s | 600s | 4 | 2 | 60s | 60% | 10 |

CLI-Manager 首版 seed Claude/Codex/Grok Build 三行等价值；不 seed/展示 Gemini。

### 3.3 错误与流提交规则

| 场景 | CCS 行为 | CLI-Manager 要求 |
| --- | --- | --- |
| DNS、连接、TLS、读取超时 | 可切换 | 可切换，前提是响应尚未提交给客户端 |
| 5xx | 可切换 | 可切换 |
| 429、一般 4xx | 通常可切换，因为不同 key/额度可能成功 | 普通 API-key provider 可切换；保留 sanitized status/error code |
| `400/405/406/413/414/415/422/501` | 不切换，属于请求/能力问题 | 先给 rectifier/media fallback 一次机会；仍失败则不切换 |
| 客户端中断 | 不污染 provider 健康 | 释放 HalfOpen permit，不计 provider 失败 |
| 官方 Codex 本地 AuthError/401/403 | 不切换 | 首版官方 OAuth 不接管，因此在启用前阻止 |
| xAI OAuth 本地 token 获取失败 | 不切换；上游 401/403 可切换 | 首版 OAuth 不接管；普通 API-key xAI 的上游 401/403 可切换 |
| 非流式 | 读取完整 body 后提交成功 | 相同 |
| 普通 SSE | 至少拿到首包后才向客户端提交 | 相同；转换器必须先验证事件可解析 |
| Responses SSE | 先识别语义 output/error event | 相同；不能把仅有 keepalive 的首字节当成功 |
| 已提交后的静默/流错误 | 不再切换 | 相同 |
| 整流重试后 provider/network/5xx | 继续故障转移 | 相同 |
| 整流重试后客户端请求错误 | 直接返回，只释放 HalfOpen permit | 相同 |

## 4. 全局出站代理

| 控件/行为 | CCS 中做什么 | CCS 如何实现 | CLI-Manager 首版实现与验收 |
| --- | --- | --- | --- |
| 代理 URL | 为 CCS 外部 HTTP 请求设置显式代理 | 支持 `http`、`https`、`socks5`、`socks5h`；空值时使用默认 client | 支持同四种 scheme；URL 必须含 host/port，拒绝路由服务自身地址，拒绝非代理 scheme |
| 用户名 | 可选代理认证用户名 | 与密码合并进 URL | provider DB 只存 URL（无密码）和用户名；DTO 可返回用户名 |
| 密码 | 可选代理认证密码，可显示/隐藏 | 与用户名合并进 URL，明文写 `settings.global_proxy_url` | 存 `credential_store`，普通 get command 只返回 `hasPassword`。编辑时空密码默认保留，清除需明确动作；日志永不返回密码 |
| 扫描 | 扫描常见 localhost 端口 | `7890/7891/1080/8080/8888/3128/10808/10809`，100ms TCP connect；7890 同时给 HTTP/SOCKS 候选 | 复用同端口和行为；扫描只说明端口可连接，不宣称协议验证成功 |
| 测试 | 用当前未保存或已保存配置测试联网 | 临时 reqwest client，依次 HEAD `httpbin.org`、Google、Anthropic，任一成功即成功 | 同目标与 10s 限时；返回目标、延迟、sanitized error；不保存配置 |
| 清空 | 清空 URL/用户名/密码，等待保存 | 前端置空 | 保存清空后删除 credential store 密码、热切换到系统/直连 client |
| 保存 | 验证并热更新全局 client | 构建/验证 client → 写 DB → 替换运行时 client | 构建两类 client（普通 reqwest + route upstream）→ DB/credential 原子补偿写 → 热替换；任一步失败保留旧运行态与旧持久化 |
| 空配置 | UI 文案近似“直连” | 实际 reqwest 仍遵循系统代理；若系统代理指向 CCS 自身端口则 `no_proxy` 防自环 | 明确显示“系统代理/直连”；若系统代理指向当前 local route host/port则禁用该系统代理，其他本地代理端口仍允许 |
| Basic 认证 | HTTP 代理认证 | 通过 URL/`Proxy-Authorization` | 仅向代理握手发送，绝不转发给上游 API |
| 作用范围 | API、Skills 下载、余额/订阅、WebDAV、本地路由上游等 | 多模块共享 client；需保留 header 大小写时 HTTP/HTTPS 代理使用 CONNECT | 覆盖 CLI-Manager 自有 reqwest 请求和 local route upstream；CC Connect profile 的显式代理继续独立且优先，SSH host proxy 和 Tauri updater 不伪装成已覆盖 |

### 4.1 CLI-Manager 网络触点清单

| 触点 | 首版策略 |
| --- | --- |
| `src-tauri/src/provider/models.rs` | 使用全局网络配置 |
| `src-tauri/src/commands/model_pricing.rs` | 使用全局网络配置 |
| `src-tauri/src/commands/command_suggestion.rs` | 移除不可热更新的静态 `OnceLock<Client>`，改取当前 shared client |
| `src-tauri/src/commands/desktop_pet.rs` | catalog 与包下载使用全局网络配置 |
| `src-tauri/src/ssh_agent_supply_chain.rs` | 下载/校验使用全局网络配置 |
| `src-tauri/src/webdav/mod.rs` | WebDAV client builder 应用全局代理，保留 WebDAV 自身 timeout/auth |
| `src-tauri/src/third_party_notification/http.rs` | 通知 HTTP client 应用全局代理 |
| local routing upstream | 必须使用全局代理；显式代理为自身地址时拒绝 |
| `src-tauri/src/commands/cc_connect.rs` | 保留 profile 显式代理，不被全局代理静默覆盖 |
| `src-tauri/src/commands/cc_connect/update.rs` | 保留 CC Connect 自己的代理决策；若以后合并，另开任务 |
| Tauri updater/WebView fetch | 首版不宣称覆盖，UI 帮助文案明确 |

## 5. 整流器与 Bedrock 优化器

所有整流器只在 **本地路由已接管的请求** 上生效。关闭/未接管时不修改直接请求或 CLI 文件。

| 开关 | CCS 默认 | CCS 中做什么/如何做 | CLI-Manager 首版实现与验收 |
| --- | ---: | --- | --- |
| 启用整流器 | 开 | 所有请求整流总开关；关闭后四个子功能不运行 | provider DB settings；daemon 热更新。关闭时子开关值保留但不执行 |
| Thinking 签名整流 | 开 | 仅 Anthropic 类上游；识别 invalid/missing/extra signature、被修改 thinking；删除历史非法 thinking/signature；同 provider 重试一次 | 移植 pinned CCS 规则与 fixture；每请求该规则最多一次；成功不计 provider failure，重试仍失败再进入错误分类 |
| Thinking Budget 整流 | 开 | 仅在 `budget_tokens + thinking + 1024` 约束错误时触发；设 `thinking.type=enabled`、`budget_tokens=32000`；缺失/过小 `max_tokens` 设 `64000`；adaptive 不改；重试一次 | 同规则；只匹配明确错误，不能对任意 400 改写请求 |
| 不支持图片降级 | 开 | 显式 text-only 能力预处理；上游 `400/415/422/501` 明确不支持图片时反应式重试；覆盖 Claude/Codex/工具/MCP 嵌套媒体；替换为 `[Unsupported Image]` | 同顺序和占位文本；不落原图内容到日志；每请求最多一次 media fallback |
| 纯文本模型预判 | 开 | 使用内置 text-only 模型注册表提前剥离图片 | 只控制启发式名单。关闭后仍保留 provider 显式能力声明和上游错误兜底；UI 文案必须说明这一点 |
| 启用 Bedrock 优化器 | 关 | Bedrock 请求的 Thinking/Cache 总开关 | 根据 effective provider env `CLAUDE_CODE_USE_BEDROCK=1` 判定，不靠 display name/URL 猜测 |
| Thinking 优化 | 开（受总开关控制） | Haiku 跳过；新模型用 adaptive + `effort=max`；旧模型用 enabled、budget=`max_tokens-1` 并补 beta | 移植规则；只改本次上游 body，不回写 provider 配置，不把 Bedrock 字段泄漏到 failover 的非 Bedrock provider |
| Cache 注入 | 开（受总开关控制） | 最多四个 5 分钟 `ephemeral` 断点：tools 尾、system 尾、最新可缓存消息、较早 user 锚点；不删除已有断点 | 同算法；只对 Bedrock provider；已有断点优先，绝不超过上游限制 |

### 5.1 请求处理顺序

CLI-Manager 首版固定以下顺序，防止不同功能互相覆盖：

1. 解析并校验客户端请求；
2. 选择当前 provider attempt 与该 provider 的 key attempt；
3. 为当前 provider attempt 从原始请求解析模型映射与协议；
4. 对当前 provider 的请求副本执行显式 media 能力处理、可选启发式预判；
5. 仅 Bedrock 请求执行 Thinking/Cache 优化；
6. 执行协议转换与 selected-key auth/header 构建；
7. 应用 Header/Body Override；
8. 重新固定最终 upstream model，确保映射结果优先于 Body Override 的 `model`；
9. 发送请求；在尚未向客户端提交响应时，按 key-level `401/403/429` 选择下一个 key，或触发 signature/budget/media 的同 provider 单次整流重试；
10. key candidates 耗尽后，整流仍失败再分类为 provider 可故障转移、客户端错误或已提交流错误；
11. 对成功响应执行协议/SSE 反向转换并记录逻辑请求统计。

每个 provider attempt 必须从原始客户端 body 克隆，避免上一个 provider 的 Bedrock 优化、media fallback 或协议字段泄漏到下一个 provider。

## 6. 明确不照搬的 CCS 行为

| CCS 行为 | CLI-Manager 决策 |
| --- | --- |
| 代理密码拼入 URL 并明文存 DB | 改用系统 credential store；普通 DTO 不返回密码 |
| 允许 `0.0.0.0` 等 wildcard bind | 首版禁止；WSL NAT 仅允许目标 distro 探测并校验成功的精确 Windows host-gateway |
| 长期保存含 token 的 Live backup | 复用 provider apply journal 的短期备份，完成后清理 |
| 完整 KeyRing/额度轮询/后台 key 健康 | 只实现 route-only enabled key pool、内存 cursor/cooldown 和 key exhaustion 后 provider failover |
| Gemini 路由开关 | 当前 native provider domain 不支持，首版不展示 |
| 官方 Codex/Claude/xAI OAuth 接管 | 首版仅普通 API-key provider；不得把官方账号认证静默转给本地代理 |
| 故障转移/用量健康写入 CCS 自有 provider DB | 复用 CLI-Manager provider DB；circuit 运行态不持久化，request logs 独立存储 |
| GUI 退出即停止路由并恢复 Live | route service 驻留 PTY daemon，GUI 生命周期不切断已接管请求 |

## 7. 首版范围提示

- Windows 本地 Home：支持 loopback listener 与 native writer。
- Windows WSL Home：支持 mirrored localhost 与 NAT exact host-gateway；由目标 distro 主动探测成功后才写 Live。
- macOS 本地 Home：支持 loopback、daemon 后台存活、同目录原子 replace 与 Keychain。
- SSH：首版不接管；禁止把本地 provider key 或 route endpoint 投影到远端。
- Project/Worktree provider override：首版继续按现有 scope snapshot 直连，不自动进入全局故障转移队列；UI 必须明确“该范围绕过本地路由”。
- 已经运行的 CLI 进程：只保证新启动进程使用新投影；不承诺进程会热重读环境/配置。
