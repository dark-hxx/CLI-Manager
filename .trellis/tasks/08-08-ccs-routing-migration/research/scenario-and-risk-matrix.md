# CCS 路由迁移场景与风险矩阵

## 1. 判定规则

- **支持**：首版必须实现并进入自动/人工验收。
- **阻止**：UI/command 明确禁用并返回稳定原因，不能留下半启用状态。
- **绕过**：该范围继续 direct，并明确告知用户。
- **后续**：首版不实现，也不展示可用假开关。

首版固定为：

- Windows 本地 CLI；
- Windows WSL CLI；
- macOS 本地 CLI；
- Claude/Codex/Grok Build；
- 普通 API-key provider。

待审批的不是平台范围，而是：

- A-01：端口固定回退范围 `15721-15799`；
- A-02：WSL mirrored localhost + NAT exact host-gateway 安全边界。

## 2. 用户与运行时场景

| 维度 | 场景 | 预期 | 验收重点 |
| --- | --- | --- | --- |
| 窗口焦点 | 当前窗口 / 其他窗口 / 应用未聚焦 | 支持 | route/failover 不依赖 WebView focus；状态丢失后 `routing_get_state` 校准 |
| 窗口生命周期 | 正常 / 最小化 / 托盘 / GUI 真退出 / GUI 重启 | 支持 | daemon 持有 route；真退出可 retain daemon；重启不重复 bind |
| 分屏 | 当前 pane / 其他 pane / 深层 split tree | 支持 | 快捷控件只认 activeSessionId；切 pane 后 app/Home 同步 |
| 多会话/Workspan | 单会话 / 同 app 多会话 / 多 app / Workspan 切换 | 支持 | route runtime 按 app/Home，不按 pane 重复启动 |
| 非 PTY | transcript / file editor / synced history UI | 阻止 | 显示“当前不是可接管 CLI 终端” |
| 已运行 CLI | takeover 前已启动的进程 | 条件支持 | 只保证新启动进程读取新 Live；不承诺热重读 |
| 自定义启动命令 | 用户覆盖 startup command | 条件支持 | 不解析任意命令；只有可识别 app/Home 的 PTY 显示快捷开关 |
| Windows local | PowerShell/CMD/pwsh/Git Bash 启动受支持 CLI | 支持 | loopback、native Home writer、端口回退 |
| WSL mirrored | WSL -> Windows `127.0.0.1` 可达 | 支持 | 目标 distro 主动 probe 成功后写 Live |
| WSL NAT | localhost probe 失败，default gateway 可达 | 支持 | route/device/CIDR + Windows local unicast 校验；精确 bind gateway |
| WSL 多发行版 | local + Ubuntu + Debian 等同时 takeover | 支持 | `(app, HomeIdentity)` 独立；gateway 去重；同 actual port |
| WSL probe 工具缺失 | distro 无可用 bounded probe helper | 阻止 | `routing_wsl_probe_tool_unavailable`；不写 Live |
| WSL firewall 阻断 | bind 成功但 distro probe 失败 | 阻止 | 不自动改 firewall；提供排查提示 |
| macOS local | GUI/daemon/CLI 均在 macOS | 支持 | loopback、same-dir rename、Keychain、daemon detach |
| Linux native | Linux 桌面本地 CLI | 后续 | 不宣称支持 |
| SSH | SSH project/remote terminal/handoff | 阻止 | 不投影本地 endpoint/key；SSH transport 不吃 global proxy |
| Project scope | 无 override | 支持 | 使用 global current + route/failover |
| Project override | project provider override | 绕过 | direct snapshot；UI 明示绕过 |
| Worktree override | worktree provider override | 绕过 | `Worktree > project` 保持，不入全局 failover |
| Provider 类型 | Claude/Codex/Grok API key | 支持 | ready/enabled/current/active key |
| Provider 类型 | Gemini | 后续 | 不 seed、不显示 takeover/failover |
| 认证类型 | 官方 Claude/Codex/xAI OAuth | 阻止 | 启用前拒绝，不转发 OAuth token |
| Provider 状态 | no current / disabled / draft / no active key | 阻止 | listener/Live/DB 均不改变 |

## 3. Listener、端口与 Home 场景

| 场景 | 预期 | 恢复/回滚点 |
| --- | --- | --- |
| service off，开启首个 local takeover | bind candidate loopback -> apply Live -> persist item/actual | bind/apply 失败保持 Live 与 takeover false |
| service off，开启首个 WSL takeover | bind loopback -> mirrored probe；必要时 gateway bind/probe -> apply WSL Live | 任一 probe 失败不写 WSL Live |
| service on，无 takeover | listener 可运行；关闭直接停 | stop failure 显示 broken |
| 同 app local + 多 WSL Home | 共用 route runtime/actual port，每 Home endpoint 独立 | 关闭单项只恢复该 Home |
| 多 app 多 Home | listener set 去重；每 `(app, Home)` 独立 journal | 总关闭返回 partial result |
| preferred port 空闲 | actual=preferred | 成功后持久化 |
| last actual 可复用 | 重启优先 bind last actual | 成功后保持 endpoint，避免无意义重投影 |
| last actual 被占用、preferred 可用 | 跳过 last actual，bind preferred | 所有 active Home 重投影后提交 |
| preferred 被占用 | 尝试 `15721-15799` | 选中首个完整 listener set 可用端口 |
| 某候选 loopback 空闲但 gateway 占用 | 候选整体失败，尝试下一端口 | 不能只检测 loopback |
| `15721-15799` 全耗尽 | `routing_port_range_exhausted` | 不写新 Live；已有 route 显示 recovery/broken |
| 运行中修改 preferred | 新 listener lease + 重投影 + swap + persist | 失败补偿回旧 endpoint |
| 运行中增加 WSL takeover | actual port 相同时只预绑定 gateway delta | delta bind/probe 失败保留旧 listener set |
| 运行中移除最后一个 NAT WSL Home | direct restore 后可移除未引用 gateway listener | restore 失败继续保留 listener |
| projection 中途失败 | 已切换 Home 补偿回旧 endpoint | 补偿不完整时新旧 listener 同时保留并标记 recovery |
| daemon restart，gateway 变化 | 重新解析/校验/probe，不信任 persisted host | bind 新 gateway并重投影 WSL Live |
| daemon capability 缺失 | GUI 不发 routing frame | 不强杀 alive PTY/route |
| daemon route 启动失败但 Live 指向 route | 高危 recovery state | journal + current provider direct restore |
| GUI 真退出 route active | 关闭选定 PTY，retain daemon，允许退出 | route busy 不当作退出错误 |
| GUI 真退出 route inactive | 现有 close_all + shutdown | 状态不可信取消退出 |
| external owned drift | 阻止覆盖 | 用户显式 reload/reapply/restore |
| external non-owned edit | merge 保留 | verify Hook/MCP/permissions/statusline |
| Codex 双文件部分失败 | 整体失败 | compensation auth/config |
| providers.db busy/corrupt | routing unavailable，主应用可启动 | backup + stable error |

## 4. 模型映射、HTTP 与故障转移

| 场景 | 预期 | 健康/日志 |
| --- | --- | --- |
| route off，配置 `a -> b` | CLI-Manager 不做请求层重写 | 无 route log |
| route on，source 精确命中 | outbound model=`b` | requested=`a`，upstream=`b` |
| source 大小写不同 | 不匹配 | 保持原模型或 provider fallback |
| duplicate source | 保存前拒绝 | `routing_model_mapping_duplicate_source` |
| target 空/仅空白 | 保存前拒绝 | `routing_model_mapping_invalid` |
| Body Override `model=c`，mapping `a->b` | 最终 outbound=`b` | 日志 upstream=`b` |
| Claude sonnet/opus/haiku/fable | 使用该 provider 角色实际模型 | display name 不进入 outbound |
| Claude fable 未配置 | 回退该 provider opus | 记录最终 upstream |
| Claude unknown role | 回退 provider default 或保持原值 | 依 provider config |
| Codex catalog 已含请求 model | 保持该 catalog model | displayName 仅 UI |
| Codex catalog 未含请求 model | 使用 provider upstream model fallback | fixture 固定 |
| Failover A/B mapping 不同 | A 从原始 `a` 得 `targetA`；B 从原始 `a` 得 `targetB` | requested 始终 `a` |
| 同 provider 多 enabled keys | route 开启后按 `sort_index` 轮询，active key 为初始首选；direct/scope 仍只用 active | log 只记录 masked key identity |
| key 返回 401/403/429，响应未提交 | 尝试本 provider 下一个未使用 key | key attempt 增加；不直接打开 provider circuit |
| 同 provider key pool 耗尽 | 推进 provider failover | provider-level failure 只计一次 |
| key cooldown/reload/restart | cooldown 仅 daemon 内存；reload/restart 重建 pool | 不自动 disable DB key |
| 两个并发请求选择 key | cursor 分散选择，单请求不重复 key | 不暴露 secret，不改变 `is_active` |
| A 做过 Bedrock/media/override | B 从原始 body 重建 | 不泄漏 A 字段 |
| 非流式成功 | 完整 body 验证后提交 | success +1 |
| 普通 SSE 首事件前 timeout | 可 failover | provider counted failure |
| Responses SSE 仅 keepalive | 不算 commit | timeout 后可 failover |
| 已提交 SSE 后错误 | 终止，不切 provider | stream error，不拼接 |
| client disconnect | 终止 attempt | neutral release |
| DNS/connect/TLS/timeout/5xx | 未提交时可 failover | counted failure |
| 429/API-key auth/quota | 未提交时可 failover | sanitized failure |
| 400/405/406/413/414/415/422/501 | 先 applicable rectifier；仍失败返回 | client/capability，不继续 failover |
| body/header over limit | 本地拒绝 | 不访问 provider |
| unknown path/CONNECT | 404/405 | 不成为 forward proxy |
| concurrent fallback | upstream 可并发，hot switch 串行 | app mutex |
| config reload during request | 当前 request 完整旧 snapshot，新 request 新 generation | 不混合 key/URL |
| circuit Open | skip | timeout 后 single HalfOpen |
| HalfOpen client error/cancel | release permit | 不加 success/failure |

## 5. 全局出站代理

| 场景 | 预期 | 边界 |
| --- | --- | --- |
| 无显式代理 | 系统代理或直连，UI 准确描述 | 系统 proxy 命中任一 route listener 时禁用 |
| HTTP/HTTPS | 支持，可选 Basic auth | auth 只发代理握手 |
| SOCKS5/SOCKS5H | 支持 | 复用 reqwest socks |
| URL 无 host/port/非法 scheme | 保存前拒绝 | 旧 config/runtime 保持 |
| password 空保存 | 默认保留旧密码 | clear 必须显式 |
| Windows credential failure | 整体失败 | 补偿 DB/runtime |
| macOS Keychain failure | 整体失败 | 补偿 DB/runtime |
| scan | 只报告 TCP reachable | 不宣称协议已验证 |
| test unsaved config | 临时 candidate | 不改 DB/runtime，10s |
| explicit proxy 指向 route | 拒绝 | `routing_upstream_proxy_self_loop` |
| route listener set 多地址 | 任一 current route host+port 都视为 self-loop | 包含 WSL gateway |
| CC Connect profile proxy | 继续独立且优先 | 不被 global proxy 覆盖 |
| updater/WebView/SSH | 不承诺 | UI 列为例外 |

## 6. 整流器

| 场景 | 预期 |
| --- | --- |
| 总开关 off | 子值保留，所有 rectifier/optimizer 不执行 |
| signature 明确错误 | Anthropic 类清理，同 provider 最多一次 |
| 任意 400 无 signature 证据 | 不改请求 |
| budget 明确错误 | 非 adaptive 按 CCS 修正，同 provider最多一次 |
| explicit text-only | 发送前替换 `[Unsupported Image]` |
| heuristic off | 关闭名单预判，保留显式能力与上游 fallback |
| upstream 明确不支持图片 | 未提交时同 provider retry 一次 |
| Bedrock provider | 仅 effective env=1 触发 |
| failover non-Bedrock | 原始 body clone，不携带 optimizer 字段 |
| rectifier 修改 body | final model pin 仍保持当前 provider target |
| retry 后 5xx/network | 进入 failover |
| retry 后 client error | 直接返回 |

## 7. UI、i18n 与可访问性

| 场景 | 预期 |
| --- | --- |
| 信息架构 | `设置 -> 供应商 -> 供应商目录 / CLI Home / 路由`；不新增独立路由顶级页签 |
| routing surface | 四 accordion 固定顺序，复用 app tabs |
| catalog search | 只过滤 catalog；routing surface 不显示伪搜索结果 |
| model mapping modal | Claude 与 Codex/Grok 均显示 route-only 中英文提示 |
| model mapping columns | 明确“显示/请求名称 -> 实际请求名称” |
| port UI | 同时显示 preferred 与 actual；停止时标识 last actual |
| Home UI | 按 app + local/每个 WSL distro/macOS local 展示 takeover 与 endpoint |
| 1024/1440 | 无横向溢出，header/action 可换行 |
| collapsed/expanded Sidebar | 快捷开关可聚焦、有 title/aria、不挤压现有按钮 |
| zh-CN/en-US | label/description/status/toast/error/aria 全覆盖 |
| keyboard | Tab、Space/Enter、accordion expanded、danger confirm |
| screen reader | 状态不只靠颜色；包含 app/Home/不可用原因 |
| page reopen | draft reset 到持久化；runtime 从 backend 重取 |

## 8. 风险登记与回滚

| 风险 | 等级 | 触发信号 | 缓解 | 回滚点 |
| --- | --- | --- | --- | --- |
| Live 指向死 route | Critical | bind/restart/restore failed | bind-first、listener lease、journal、route busy | 保留被引用 listener；direct restore |
| Port check/bind race | High | 检查空闲后 bind 失败 | 直接 bind 并持有 lease | 尝试下一 candidate |
| Partial listener set | Critical | loopback 成功、gateway 失败 | candidate 要求完整 listener set | 释放整个 candidate |
| Rebind partial projection | Critical | 一些 Home 指新 port，一些旧 port | 新旧 listener 并存 + compensation | 保留所有被引用 listener |
| WSL gateway 暴露 LAN | Critical | bind 到 wildcard/LAN adapter | route/CIDR + local unicast 校验，精确 bind | 停 gateway listener，恢复 WSL direct |
| 自动改 firewall/network | High | 管理员级系统副作用 | 明确禁止 | 无系统变更可回滚 |
| macOS 未真实验证 | High | Windows tests 全绿但 mac 不可用 | 真实 runner/设备为 exit criterion | 不标记 macOS 完成 |
| GUI exit blocked/kills daemon | High | shutdown_if_idle 与 route 冲突 | `retainDaemon` 分支 | 关闭 route 后恢复旧退出语义 |
| Codex auth/config split | High | 任一 verify fail | multi-target compensation | journal rollback |
| 多 writer 分裂 | High | current/Live/daemon 不一致 | 唯一 projection writer | disable takeover + direct restore |
| SSE 拼接两 provider | Critical | duplicate/mixed events | commit point，commit 后禁 failover | terminate current stream |
| Mapping A 泄漏到 B | High | B 收到 targetA | 每 attempt 原始 body clone | 关闭 failover，修复 resolver |
| Body Override 覆盖 mapping | High | outbound 不是 target | final model pin + fixture | 禁用该 override，修复 pipeline |
| duplicate source 歧义 | Medium | 数组顺序决定结果 | 前后端 duplicate reject | 修复 provider settings |
| Proxy self-loop | Critical | proxy 指向 local/gateway route | normalize against full listener set | old client/direct |
| Proxy password leak | High | DB/DTO/log 有 credential | credential store + masked DTO | delete credential/config |
| Static client not hot reload | Medium | 部分模块旧代理 | touchpoint checklist + generation | restart 临时恢复 |
| Snapshot mixed generation | High | old key/new URL | immutable snapshot | reload daemon |
| Key pool mixed generation | High | old key/new URL 或 disabled key 仍被使用 | generation swap + request snapshot | reload daemon，终止未提交 attempt |
| Key failure 污染 provider circuit | High | 一个坏 key 导致 provider 被熔断 | key attempts 先耗尽，最后一次才提交 provider classifier | reset key pool/provider circuit |
| Key pool 泄露密钥 | Critical | key secret 出现在 state/log/IPC | memory-only selected key、masked identity、redaction | stop route、清理日志、恢复 direct |
| Circuit client-error pollution | Medium | provider 错误 Open | single classifier + neutral release | reset/restart |
| Rectifier broad 400 rewrite | High | unrelated request modified | exact matcher + one bit | disable rectifier |
| Route log secret leak | High | DB/log 有 body/token | fixed schema + redaction | disable logging + purge |
| CCS license omitted | Medium | substantial copy 无归属 | pinned commit + NOTICE/license | 删除复制或补归属 |

## 9. 已批准决策

### A-01 固定端口回退范围（已批准）

`15721-15799`，保留用户可编辑 preferred port，不增加范围起止 UI。

结论：批准。

### A-02 WSL 网络边界（已批准）

mirrored `127.0.0.1` 优先；NAT 时只绑定目标 distro 解析并验证的精确 Windows host-gateway，主动 probe 成功后才写 Live；禁止 wildcard、自动 firewall 和 portproxy。

结论：批准。

### A-03 同供应商多密钥自动负载（已批准）

路由内按 `sort_index` 轮询 enabled keys，active key 作为初始首选；未提交响应前遇到 `401/403/429` 先换同 provider key，key pool 耗尽后再进入 provider failover。direct/scope 继续使用 active key；不实现完整 KeyRing、quota、balance 或后台健康持久化。

结论：批准。
