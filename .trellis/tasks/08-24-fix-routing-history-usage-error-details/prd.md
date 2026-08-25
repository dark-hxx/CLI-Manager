# brainstorm: 修复路由历史用量异常详情

## Goal

在启用路由后，历史用量分析的历史日志不能再以笼统的“usage 不适用”掩盖失败原因；它应显示该条请求对应的错误摘要，并允许用户按需查看完整异常详情，方便定位路由或上游调用失败。

## What I Already Know

* 用户在“开启路由”后观察到历史用量分析的历史日志出现“usage 不适用”。
* 用户希望该占位信息替换为对应的报错信息，并提供点击查看异常详情的入口。
* 项目要求所有新增或调整的用户可见文本同时支持 `zh-CN` 和 `en-US`。
* 本次代码变更的 CHANGELOG 版本为 `TEMP`。
* 路由 usage 记录已持久化 `error_code`，但 `unified_usage_records`、`history_list_request_logs` 和前端 `RequestLogItem` 未传递该字段；`RequestLogsView` 因而仅按 `usage_status=not_applicable` 显示泛化文案。
* 对非流式上游 HTTP 错误，路由器目前只记录状态和 outcome，不保存上游错误体；要提供真正的详情，需要在响应读取后提取并安全保存诊断文本。

## Assumptions (Temporary)

* 路由或上游请求的失败信息已在请求日志、后端响应或可追溯的持久化记录中存在，缺口主要是历史用量分析的传递与呈现。
* MVP 不新增重新请求、重试或修改路由策略，只改善失败记录的可诊断性。

## Open Questions

* 需确认是否在本地持久化经过脱敏和长度限制的上游错误文本，作为详情弹层的诊断内容；该选择决定隐私边界与可诊断性。

## Requirements (Evolving)

* 对路由后失败且无法取得 usage 的历史日志，显示可理解的错误摘要，而非笼统的“usage 不适用”。
* 为有异常详情的日志提供可点击的查看入口，并展示可用于诊断的完整异常信息。
* 异常详情的展示不得泄露密钥、令牌或其他敏感配置。
* 所有新增文案须支持中文和英文。
* 旧记录或只能取得错误代码的记录仍应显示可用的本地化摘要，详情弹层明确标示可用字段而非制造空异常。
* 对非流式上游 HTTP 错误，从受控的错误字段提取诊断文本；不得持久化完整原始响应体、请求内容或 headers。
* 对发送失败、预发送 skip、流式失败等没有上游正文的情况，详情至少应提供本地化错误摘要、稳定错误码、HTTP 状态（如有）和路由上下文；有安全详情时一并展示。
* 详情弹层必须可用键盘关闭，且点击入口不能触发行的双击会话打开操作。

## Acceptance Criteria (Evolving)

* [x] 开启路由后，出现 usage 缺失的失败日志会显示该记录实际对应的错误摘要。
* [x] 用户可通过明确的点击入口查看该条日志的异常详情，并可返回历史日志。
* [x] 无异常详情的正常或旧记录保持原有可用展示，不产生空白或误导性错误。
* [x] 中英文界面下的文案均正确；错误详情不暴露敏感字段。
* [x] 路由关闭、成功路由、session-log 回退记录、流式和非流式失败、故障转移跳过/失败及旧 schema 记录均保持既有正确行为。
* [x] 保存的异常详情来自允许的错误字段、经过脱敏并受长度上限约束；不保存完整原始上游响应。
* [x] 前端类型检查及受影响的后端检查/测试通过。

## Definition of Done

* Tests added or updated where the affected code has coverage.
* Lint/typecheck and relevant backend checks pass.
* `CHANGELOG.md` and `docs/功能清单.md` are updated under version `TEMP`.

## Out of Scope (Explicit)

* 修改路由的重试、故障切换或 usage 统计规则。
* 为历史记录补录无法从现有数据恢复的原始异常。
* 提供错误详情的复制、导出、重新请求或重试操作。

## Technical Notes

* 根因陈述：问题位于路由 usage 持久化到历史请求日志展示的跨层契约——后端虽然对部分失败写入 `error_code`，但统一视图、列表 command 和前端类型/组件均丢弃该信息；而非流式上游错误体也没有被捕获，因此 UI 只能把 `not_applicable` 渲染为泛化文案。修复必须在错误捕获、持久化、查询和展示的完整数据链路落地，不能只替换 UI 文案。
* 数据流：路由器 `forward_request` / 流式完成器 → `usage::record_route_usage` → SQLite `usage_records` / `unified_usage_records` → `history_list_request_logs` → `RequestLogItem` / `RequestLogsView`。
* UI 可复用现有 Radix `Dialog` 原语；不需要引入新依赖。
* GitNexus 初次重建因 `.gitnexus/lbug` 访问被拒绝，但后续 impact analysis 与 change detection 已可执行；本任务的目标符号均为低风险。change detection 的工作区级 critical 结果来自并行的供应商编辑器改动，未混入本任务的调用链。

## Verification Note

* 已完成格式化、针对性 Rust tests、完整 `cargo test --lib`、`cargo check`、`npx tsc --noEmit`、`npm run build` 与 `git diff --check`。因本任务不启动 Tauri 桌面运行时，路由失败的真实桌面 UI 场景、语言切换和键盘焦点仍作为交付后的手动验证项。

## Decision (ADR-lite)

**Context**：用户需要看到“usage 不适用”背后的真实路由故障，但完整上游 body 可能包含敏感内容，且旧记录不能可靠补齐。

**Decision**：对新产生的路由失败记录，持久化稳定错误码与从允许字段提取、脱敏、限长的诊断文本；列表显示本地化错误摘要，并在可访问的 dialog 中展示状态码、错误码、供应商与安全详情。旧记录仅展示已有字段。

**Consequences**：诊断能力覆盖新记录和已有 `error_code` 的记录，同时不把原始上游响应、请求或认证数据写入本地数据库；无法恢复的旧原始异常保持不可用。

## Root-Cause Discovery List

* [x] `src-tauri/src/daemon/route_http.rs::forward_request` / 流式完成器：写入静态失败 code；非流式上游错误响应读到 body 后仍以 `error_code=None` 记录，未保留可诊断详情。
* [x] `src-tauri/src/usage.rs::record_route_usage`：持久化 `error_code` 但 schema 中无 `error_detail`；`usage_status_for` 正确把失败的空 usage 分为 `not_applicable`，不是本次需要改回 `missing` 的根因。
* [x] `src-tauri/src/lib.rs` 的 `usage_records` schema、迁移及 `unified_usage_records`：schema 和视图都需同步扩展，旧库必须兼容。
* [x] `src-tauri/src/commands/history/request_logs.rs::list_request_logs_with_connection`：SELECT 与 `RequestLogItem` 省略错误字段，是历史日志列表的信息丢失边界。
* [x] `src/lib/types.ts` / `src/components/stats/RequestLogsView.tsx` / `src/lib/i18n.ts`：前端 payload 类型、状态摘要和详情 dialog 以及双语文案触点。
* [x] `src/components/stats/StatsPanel.tsx`：只挂载 `RequestLogsView`，确认不应承担错误字段转换。
* [x] `history_get_request_log_stats` 与统计聚合：只消费用量数值，确认本次不改变统计口径。

## Scenario Matrix

* 路由：关闭；开启且成功；发送前 circuit-open/key-cooldown/无 key 跳过；发送超时/网络失败；非流式 HTTP 错误；流式 error 事件、超时或客户端取消；跨 provider failover。
* 数据：新记录含 code/详情；新记录仅含 code；旧记录无错误字段；正常 route/session-log 记录；缺少 usage 但没有错误的成功响应。
* UI：中文/英文、键盘焦点与 Escape 关闭 dialog、详情长文本换行/滚动、点击详情不触发行双击打开会话。
