# CCS v3.19.2 路由运行时架构

## 1. 总览

CCS 的“路由”不是只改一个代理 URL，而是四层组合：

```text
Live CLI 配置接管
  -> 本地 HTTP 服务与协议转换
  -> provider 选择 / 重试 / 熔断 / 热切换
  -> 可选出站代理与请求整流
```

主要入口为：

- commands：`src-tauri/src/commands/proxy.rs`、`failover.rs`、`global_proxy.rs`；
- service：`src-tauri/src/services/proxy.rs`；
- runtime：`src-tauri/src/proxy/*`；
- persistence：`src-tauri/src/database/schema.rs`、`database/dao/proxy.rs`、`database/dao/failover.rs`。

## 2. 服务与接管

### 2.1 服务总开关

`start_proxy_server` 调用 `ProxyService.start()`。listener 默认绑定 `127.0.0.1:15721`；运行状态、活动连接、请求计数、成功率、运行时间与 active targets 保存在进程内。

端口行为是直接 bind，不是范围扫描：

- `ProxyServer.start()` 对配置的 `listen_address:listen_port` 调用 `TcpListener::bind`；
- 固定端口被占用时直接返回 `BindFailed`；
- `listen_port=0` 时由 OS 分配端口，读取 `local_addr().port()`；
- `persist_ephemeral_listen_port_if_needed` 把该 actual port 写回配置；
- CCS 没有“首选端口 + 固定候选范围”的逻辑，CLI-Manager 的 `15721-15799` 回退属于明确增强。

设置页手动关闭走 `stop_proxy_with_restore`：

1. 停止 listener；
2. 恢复 Live 配置；
3. 清理 legacy live takeover flag；
4. 清除各应用 `enabled`；
5. 删除 Live backup；
6. 清理 provider health；
7. 保留 failover queue 和 failover 参数。

程序正常退出使用 `stop_with_restore_keep_state`：恢复 Live 并删除 backup，但保留逐应用 `enabled`，下次启动根据状态重新接管。

### 2.2 逐应用接管

`set_proxy_takeover_for_app(app, true)` 的核心顺序是：

```text
ensure listener running
  -> strict backup Live
  -> sync Live credential/provider state into DB
  -> write local route projection + PROXY_MANAGED
  -> mark app proxy_config.enabled=true
```

关闭单个应用时：

```text
restore backup if valid
  -> otherwise rebuild from current provider SSOT
  -> reject/skip corrupted proxy-placeholder backup
  -> remove app backup and health
  -> mark enabled=false
  -> stop listener when no app remains enabled
```

CCS 源码包含多组回归测试，专门防止把已经含 `PROXY_MANAGED` 的 Live 再次保存为“原始备份”。这说明 Live backup 是该架构的高风险状态边界。

### 2.3 热切换

takeover 已启用时，provider switch 不把 Live 改回上游 URL，而是：

- 更新当前 provider；
- 更新 proxy service 的 active target；
- 更新用于未来 restore 的 provider backup/projection；
- 通知 UI/托盘。

因此 failover 成功后的 provider B 会成为新的 current，关闭路由后恢复为 B 的 direct config，而不是接管开始前的 provider A。

## 3. 路由与协议转换

### 3.1 路径分类

| 路径 | 应用 |
| --- | --- |
| `/v1/messages` | Claude |
| `/v1/chat/completions` | Codex/OpenAI Chat |
| `/v1/responses` | Codex/OpenAI Responses |
| `/v1beta/*` | Gemini |
| `/grokbuild/v1/*` | Grok Build |

路径决定 app type；provider 由 current/failover queue 决定。它不是任意 URL 正向代理。

### 3.2 provider adapter

`forwarder.rs` 通过 `ProviderAdapter` 提取：

- base URL；
- auth/key/header；
- model 与 model catalog；
- Claude `api_format` 或 Codex/Grok `wire_api`；
- provider-specific endpoint/query/header 规则。

随后按协议组合调用 `providers/transform*.rs` 和 `providers/streaming*.rs`：

- Anthropic Messages ↔ OpenAI Chat；
- Anthropic Messages ↔ OpenAI Responses；
- Anthropic Messages ↔ Gemini Native；
- Responses ↔ Chat Completions；
- Responses ↔ Anthropic；
- 非流式 JSON 与 SSE 的反向转换；
- tool call、reasoning/thinking、图片/文件、usage 的结构转换。

### 3.3 header 与编码

- auth header 由 provider adapter 重建，客户端 sentinel 不上送；
- hop-by-hop header 被过滤；
- transform/SSE 路径强制 identity encoding，响应需要时由 CCS 自己解压；
- Anthropic beta/version 和 Codex client fingerprint 有专门分支；
- HTTP/HTTPS 显式出站代理需要 CONNECT 路径以尽量保留上游敏感的 header 形态。

### 3.4 模型映射与最终请求体

Claude route mapping 在 `proxy/model_mapper.rs`：

- `ModelMapping::from_provider` 从 `ANTHROPIC_DEFAULT_HAIKU_MODEL`、`SONNET`、`OPUS`、`FABLE`、`CLAUDE_CODE_SUBAGENT_MODEL` 与 `ANTHROPIC_MODEL` 取值；
- `map_model` 对角色名做大小写不敏感包含匹配；
- fable 未配置时回退 opus；
- subagent actual model 在 default fallback 前保持；
- `apply_model_mapping` 修改当前 provider attempt 的 body，并返回 original/mapped model。

Codex/Grok 另有 catalog/upstream model 逻辑：

- `modelCatalog.models[].displayName` 主要用于 CLI 菜单；
- runtime 匹配 `models[].model`；
- 请求 model 不在 catalog 时，`apply_codex_upstream_model` 回退到 provider 配置的 upstream `model`；
- Grok 和 Codex Chat/Anthropic transform 路径会在协议转换前固定该 upstream model。

`forward_with_retry` 为每个 provider clone 原始 body，随后 `forward()` 再执行当前 provider 的 mapping，因此 failover provider 不会继承前一个 provider 已改写的 body。

CCS 的本地请求覆盖顺序需要特别记录：

1. model mapping；
2. media/协议转换；
3. `apply_local_proxy_body_overrides` 深合并最终 body；
4. 读取最终 outbound model。

因此 CCS v3.19.2 的 Body Override 可以再次覆盖 `model`。CLI-Manager 按本任务产品要求有意不同：Body Override 后重新执行 final model pin，使映射结果优先。

## 4. provider 选择与故障转移

### 4.1 队列

队列没有独立表，直接使用：

```text
providers.in_failover_queue
providers.sort_index
```

DAO 顺序为 `COALESCE(sort_index, 999999), id`。自动故障转移关闭时只选择 current provider；打开时使用队列顺序。

启用 failover 时：

1. 要求该 app 已接管；
2. 队列为空则把 current 自动加入；
3. 先切换到 P1；
4. 只有 P1 switch 成功才写 `auto_failover_enabled=true`；
5. 失败则回滚自动加入的队列项。

关闭 failover 不清队列。

### 4.2 attempt 与 timeout

`max_retries` 表示失败后的额外重试数：

```text
max_attempts = max_retries + 1
```

实际 attempt 还受 provider 数量和 circuit allow result 限制。failover 关闭时 handler context 强制 `max_retries=0`，并关闭 failover 专用首字节/静默/非流式 timeout 语义。

### 4.3 circuit breaker

每个 `(app_type, provider_id)` 对应一个内存 circuit：

```text
Closed -> Open -> HalfOpen -> Closed
```

- 连续失败阈值或累计错误率阈值打开；
- Open timeout 到达后进入 HalfOpen；
- HalfOpen 只放行一个并发探测；
- HalfOpen 任一 counted failure 立即回 Open；
- 达到连续恢复成功阈值后 Closed，并清累计请求/失败计数；
- config 可热更新但不重置状态；
- 客户端错误/取消通过 neutral release 只释放 HalfOpen permit。

### 4.4 成功后的回切

fallback provider 成功后，CCS 更新 current provider。下一请求仍从队列 P1 开始判断；当 P1 从 Open 超时进入 HalfOpen并达到恢复阈值，current 会自动回到 P1。

### 4.5 CLI-Manager route-only 多密钥扩展

CCS/当前 CLI-Manager 的 provider attempt 证据只描述 provider 级选择；CLI-Manager 现有 provider domain 还明确要求一个 active key，不能把“多个已保存 key”误认为运行时 key pool。A-03 批准后采用边界清晰的扩展：

- direct projection、Project/Worktree snapshot、模型发现和未开启路由的请求继续解析 active key；
- route daemon 为每个 provider generation 加载 enabled key candidates，按 `sort_index, id` 轮询，active key 作为初始首选；
- 未提交响应前的 `401/403/429` 只在同 provider key pool 内重试，key candidates 耗尽后才进入 provider queue；
- network/TLS/5xx、请求能力错误和已提交 SSE 不触发全池遍历；key-level failure 不直接打开 provider circuit；
- cursor/cooldown 只在 daemon 内存中存在，reload/restart 重建，不引入 quota、balance、后台 probe 或持久化 KeyRing。

## 5. 错误分类与流提交

### 5.1 可故障转移

- DNS/连接/TLS/timeout；
- 5xx；
- 429 和多数 provider/auth/quota 相关 4xx；
- rectifier 同 provider 重试后仍为 provider/network/5xx。

### 5.2 不故障转移

- `400/405/406/413/414/415/422/501` 等确定的请求/能力问题；
- 本地 request transform/validation error；
- 客户端断开；
- 官方 Codex 本地 AuthError、401/403；
- xAI OAuth 本地 token 获取失败；
- rectifier 重试后确定为客户端错误。

### 5.3 响应提交点

- 非流式：完整 body 读取、必要 transform 和语义检查完成后提交；
- 普通 SSE：先等首个可转发数据；
- Responses SSE：先确认语义 output 或 error event，不能把 keepalive 当成功；
- 一旦响应 body 已向客户端提交，后续静默 timeout/stream error 只结束当前流，不再切 provider。

该提交点是防止两个 provider 的响应被拼接到同一客户端流的核心边界。

## 6. 全局出站代理

### 6.1 持久化与热更新

CCS 把完整 URL（含用户名/密码）保存为 `settings.global_proxy_url`。保存顺序：

```text
validate/build candidate client
  -> write DB
  -> apply/swap runtime client
```

启动时读取 DB；无效配置被清理并回到默认连接。

### 6.2 scheme 与系统代理

支持 `http`、`https`、`socks5`、`socks5h`。没有显式 proxy 时 reqwest 遵循系统代理；如果系统 proxy 指向 CCS 当前 loopback route port，则 `no_proxy()` 避免递归。其他 localhost proxy 端口仍允许。

### 6.3 扫描与测试

- 扫描端口：`7890/7891/1080/8080/8888/3128/10808/10809`；
- 只做 TCP reachability，mixed port 同时列 HTTP/SOCKS 候选；
- 测试依次请求 httpbin、Google、Anthropic，任一成功即通过。

### 6.4 client 覆盖

共享 client 被 proxy upstream、模型、Skills、余额/订阅、WebDAV 等多个模块复用。该设计要求所有长期 client 都能被热更新，否则“全局”只会覆盖部分调用。

## 7. 整流器

### 7.1 Thinking signature

只处理 Anthropic 类型 provider。上游明确报告 invalid/missing/extra signature 或 thinking 被修改时，删除历史非法 thinking/signature，并对同一 provider 重试一次。

### 7.2 Thinking budget

只匹配 budget/thinking/max token 约束错误：

- `thinking.type=enabled`；
- `budget_tokens=32000`；
- `max_tokens` 缺失/过小时设 `64000`；
- adaptive thinking 不改；
- 同 provider 重试一次。

### 7.3 media fallback

处理层次：

1. provider 明确声明 text-only：发送前替换；
2. 可选内置 text-only model registry：发送前预判；
3. 上游 `400/415/422/501` 明确不支持图片：反应式替换并重试。

替换覆盖 Claude/Codex message、tool/MCP 嵌套媒体，文本为 `[Unsupported Image]`。关闭“纯文本模型预判”只停第 2 层，不停显式能力和错误兜底。

### 7.4 Bedrock optimizer

通过 provider config 的 `CLAUDE_CODE_USE_BEDROCK=1` 判定：

- Haiku 跳过 thinking 优化；
- 新模型用 adaptive + `effort=max`；
- 旧模型用 enabled，budget=`max_tokens-1` 并补 beta；
- cache 最多注入四个 5 分钟 `ephemeral` 断点；
- 每个 provider attempt 单独 clone body，避免 failover 到非 Bedrock 时泄漏字段。

## 8. 对 CLI-Manager 最重要的结论

1. 路由必须理解 native provider 的协议和模型，不是简单的 HTTP reverse proxy。
2. takeover、global apply、active key 变更和 failover hot switch 必须共享同一 writer/journal，否则 Live 与 DB 会分裂。
3. daemon 生命周期是 CLI-Manager 与 CCS 最大的结构差异；把 listener 留在 Tauri GUI 会破坏现有“PTY 可跨 GUI 退出”的契约。
4. global proxy 必须统一 client 构造；新增一个设置但保留各模块静态 client 不算迁移完成。
5. rectifier 的重试必须发生在响应提交前，并与 failover 错误分类共用一个请求上下文。
6. CCS 固定端口占用会失败；CLI-Manager 必须用持有 socket lease 的候选 bind 实现 actual port 回退，不能只做空闲预检。
7. 模型映射必须每 provider attempt 从原始请求重算；CLI-Manager 还需按产品要求让映射最终优先于 Body Override。
8. Windows WSL 与 macOS 是 CLI-Manager 平台扩展，不是 CCS 源码现成能力；必须通过独立平台 fixtures 和真实环境验收。
9. A-03 的 key attempt 必须嵌套在 provider attempt 内；只有同 provider candidates 耗尽后，才允许推进 provider circuit/queue，避免一个坏 key把整个 provider提前熔断。
