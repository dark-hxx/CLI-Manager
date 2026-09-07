# P0-03 协议 Fixture 基线与 Review 记录

## 1. 实现边界

- 本 Case 只新增 `src-tauri/tests/` 下的集成测试与脱敏 fixture。
- 未修改现有 provider、daemon、Tauri command、listener、writer、HTTP client 或前端 symbol。
- 未注册可达路由命令、端口或设置页入口。
- 未复制 CCS 生产实现；fixture 语义按固定 CCS `v3.19.2` commit `43eaf07355af145aebfee301801779e824d4c221` 与本任务已批准差异编写。

## 2. Fixture 合同

| 文件 | 覆盖内容 |
| --- | --- |
| `src-tauri/tests/fixtures/routing/protocol_matrix.json` | Claude 四种 `apiFormat`、Codex/Grok Build 三种 `wireApi`；每个格式同时含 JSON 与 SSE payload；覆盖 tool call、reasoning/thinking、image/file、usage |
| `src-tauri/tests/fixtures/routing/stream_commit.json` | 普通 SSE 首个可解析事件、Responses keepalive、Responses output/error、普通与 Responses 提交后错误禁止切换 |
| `src-tauri/tests/fixtures/routing/model_mapping.json` | route off、精确/大小写/trim、重复与空值、Body Override final pin、A/B provider 重算、Claude role、Codex catalog/upstream fallback |
| `src-tauri/tests/fixtures/routing/rectifier_errors.json` | signature、budget、adaptive guard、media/工具/MCP 嵌套、heuristic guard、Bedrock thinking/cache、非 Bedrock 泄漏 guard、route-off guard |
| `src-tauri/tests/fixtures/routing/redacted_request_logs.json` | 与 schema v2 `routing_request_logs` 精确列集合一致的脱敏持久化样本，以及不入 DB 的脱敏 runtime key-attempt 样本 |
| `src-tauri/tests/routing_fixtures.rs` | 独立解析、覆盖矩阵、提交边界、映射、整流与敏感字段断言 |

## 3. 影响分析

- GitNexus 查询未发现现有 routing adapter 或 fixture execution flow；相关定义仍集中在 P0-02 schema 与未来 daemon/provider 触点。
- 对 `src-tauri/src/provider/mod.rs` 的模块名查询无可解析 symbol；本 Case 随后选择不修改该模块或任何既有 symbol。
- 新增集成测试只依赖 `serde_json` 与 Rust 标准库；无新增 crate、feature 或生产调用者。
- 结论：无现有 symbol blast radius，无 HIGH/CRITICAL 风险；生产执行流影响为零。

## 4. Review 记录

### R1 — 正确性、安全、数据边界

发现并修复：

1. 原协议矩阵每格式只含一种 transport，补为每个格式 JSON/SSE 双覆盖。
2. feature 断言扫描了 feature 标签自身，存在假阳性；改为只扫描 request/response payload。
3. Codex catalog fixture 错把 `displayName` 当实际请求 model；改为 catalog `model` 命中，displayName/unknown 均回退 provider upstream。
4. rectifier 样本缺 adaptive、Bedrock cache、工具/MCP 嵌套媒体和非 Anthropic signature guard；已补齐。
5. request-log fixture 使用 DTO 风格字段并包含 schema 不存在的 key 字段；改为精确 schema v2 列，key attempt 仅保留为脱敏 runtime 样本。

复验：`rtk cargo test --test routing_fixtures`，5 passed。

### R2 — PRD/设计一致性、场景矩阵、回归

发现并修复：

1. Grok backend app type 明确为 `grokbuild`，同时记录 public app `grok`。
2. `rectifier_flags` 对齐 SQLite `TEXT` 列，不再用 JSON array 值冒充存储形态。
3. 补普通 SSE 已提交后错误样本，避免只验证 Responses SSE。
4. A/B failover fixture 增加从原始 requested model 逐 provider 计算断言。
5. mapping duplicate 校验改为 trim 后大小写敏感去重，并补空 target 与 trim case。

复验：`rtk cargo test --test routing_fixtures`，5 passed；`rtk cargo fmt --all -- --check` 与 `rtk git diff --check` 通过。

### R3 — 独立安全与编译复核

范围：敏感信息、测试隔离、生产触点、provider 回归与 Rust 编译。

- `rtk cargo test --test routing_fixtures`：5 passed。
- `rtk cargo test provider --lib`：123 passed。
- `rtk cargo check`：通过。
- fixture 中无 `sk-`、`Bearer `、PEM 私钥头或 secret 字段键。
- `src-tauri/tests` 中无 `routing_get_*`、`TcpListener`、`tauri::command` 或 invoke 注册。
- 未解决发现：0。

### R4 — PRD/设计与交付范围复核

范围：协议格式与双 transport、stream commit、mapping、rectifier、schema v2、平台/i18n/许可适用性和提交范围。

- 10 个格式组合均含 JSON/SSE 两种 transport。
- stream fixture 同时覆盖普通 SSE 与 Responses SSE 的提交前/后错误边界。
- mapping fixture 覆盖 route off、trim、大小写、重复、空值、Body Override final pin、A/B、Claude role 与 Codex catalog fallback。
- rectifier fixture 覆盖 route-only、精确规则、adaptive、嵌套媒体、Bedrock/non-Bedrock 与 cache breakpoint。
- request-log fixture 列集合和列类型与 provider DB schema v2 一致；key identity 仅存在脱敏 runtime attempt 样本。
- 本 Case 无平台分支、用户文案、UI、a11y 或 substantial CCS 源码复制，因此无需 i18n、平台 runner、CHANGELOG、功能清单或 NOTICE 变更。
- `rtk cargo test --test routing_fixtures`：5 passed。
- `rtk cargo fmt --all -- --check` 与 `rtk git diff --check`：通过。
- 未解决发现：0。

R3、R4 连续两轮零未解决发现，满足独立提交门槛。
