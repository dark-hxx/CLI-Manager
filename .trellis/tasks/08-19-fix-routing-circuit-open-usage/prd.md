# 修复路由故障转移 circuit open 与 usage 缺失

## Goal

定位并修复启用路由与故障转移后，Codex 请求偶发收到
`503 routing_provider_circuit_open`，且本地日志同时提示“缺少 usage”的根因，确保故障转移链路按约定返回可消费的响应并准确记录请求结果。

## What I already know

- 问题仅在开启路由与故障转移后偶发出现。
- 客户端看到的响应为 `503 Service Unavailable`，错误体是
  `{"error":"routing_provider_circuit_open"}`，请求地址为本地 `/v1/responses`。
- 本地日志还会提示“缺少 usage”，需要确认它是根因、伴随现象，还是错误响应被误按成功响应解析后的二次噪声。
- 该问题涉及运行时状态、异步请求及路由/供应商边界，必须按根因修复处理。
- `CHANGELOG.md` 版本使用 `TEMP`。
- 本机 Codex 会话中找到 7 次真实 `routing_provider_circuit_open` 客户端错误；它们都发生在前序上游失败、流中断或 Key 冷却之后。
- 当前 Codex 故障转移队列配置过多个供应商，因此不是“只配置了一个供应商却期望故障转移”的误用。
- 运行记录显示：真实上游失败会启动 Key cooldown；cooldown 期间下一次请求在 `select_key` 处没有发出网络请求，却被记录为 `routing_provider_key_exhausted`，同时再次调用 `record_circuit_failure`。快速连续请求会用这些“未尝试的跳过”达到熔断阈值，随后整队列被跳过并返回 503。
- 失败 attempt 使用空 `UsageCapture` 进入统一 usage 写入层，当前一律被分类为 `missing`；因此“缺少 usage”是失败记录被误用成功响应完整性语义后的二次噪声，不是导致 503 的原因。

## Assumptions (temporary)

- 应保留熔断器对持续失败供应商的保护语义；修复不应简单禁用熔断。
- 对合法错误响应不应继续执行成功响应的 usage 提取流程。
- 有可用候选供应商时，单个供应商熔断不应提前终止整个故障转移链路。
- circuit-open 或 Key cooldown 只表示该候选本次不可尝试；它们不应消耗实际请求 attempt 预算，也不应制造新的 circuit failure。
- 所有候选确实都不可尝试时，保留熔断器的 fail-fast 503 保护，不强制向已熔断供应商发送流量。

## Requirements

- 找出 503 的实际产生位置、熔断状态的建立/恢复条件，以及故障转移候选遍历链路。
- 区分上游真实 503、路由器生成的 circuit-open 503 与 usage 统计解析告警。
- 只有实际发出的上游请求失败才可累计 circuit failure；Key cooldown、circuit-open 与 snapshot skip 仅作为候选跳过记录。
- provider attempt 预算按实际出站请求计数，不能按队列位置或跳过次数计数。
- 失败且没有 Token 的路由记录使用明确的“不可用/不适用”usage 状态；只有成功响应缺失预期 usage 时才标记 `missing`。
- 修复应落在产生错误状态的上游边界，而不是只在“缺少 usage”日志处添加默认值或吞掉异常。
- 保持未启用路由/故障转移时的既有请求行为。
- 用户可见文案如有变更，必须同步 `zh-CN` 与 `en-US`。

## Acceptance Criteria

- [ ] 有可用故障转移候选时，某个供应商熔断不会导致请求直接返回 `routing_provider_circuit_open`。
- [ ] Key cooldown 期间的候选跳过不会累计 circuit failure、不会写成一次实际 provider attempt，也不会消耗重试预算。
- [ ] circuit-open 候选跳过不会消耗重试预算；队列后方仍可尝试的供应商会被访问。
- [ ] 所有候选均不可用时，返回明确且符合现有接口契约的错误，不产生误导性的“缺少 usage”成功解析告警。
- [ ] 成功的 `/v1/responses` 非流式与流式路径仍能正确处理 usage。
- [ ] 熔断恢复/半开场景不会永久阻断已恢复的供应商。
- [ ] 补充覆盖故障转移与错误响应处理的自动化测试。
- [ ] 相关前端类型检查、Rust 检查与定向测试通过。
- [ ] `CHANGELOG.md` 的 `TEMP` 版本和 `docs/功能清单.md` 已更新。

## Definition of Done

- 根因陈述与完整发现清单已记录。
- GitNexus 变更前影响分析与交付前变更检测完成。
- 测试、类型检查和编译检查通过，或明确记录与本次无关的既有失败。
- 回滚方式明确，不改变现有持久化协议或数据库结构。

## Open Questions

- 无。

## Decision (ADR-lite)

**Context**: 全部候选处于 circuit-open / Key cooldown 时，强制尝试可能减少少量 503，但会绕过熔断保护并持续冲击已经失败的上游。

**Decision**: 保留 fail-fast 503。只修复错误的失败累计、attempt 预算和 usage 状态分类；不添加强制探测或熔断旁路。

**Consequences**: 所有 provider 真实不可用时客户端仍会明确失败；正常恢复由既有 cooldown 到期、circuit timeout 与 half-open probe 完成。修复后，跳过事件不会人为延长不可用窗口。

## Out of Scope

- 重设计整个路由配置界面或供应商管理模型。
- 更改供应商优先级/故障转移顺序的产品规则，除非根因证明现有实现违反已定义规则。
- 新增依赖、数据库迁移或新的外部 API。

## Technical Notes

- 必须先读取 `.trellis/spec/guides/fix-triage-guide.md` 并遵循根因修复门禁。
- 代码触点优先通过 GitNexus 查询、上下文与影响分析定位。

## Root-Cause Statement

根因位于 daemon 路由器的 provider/key 选择边界：`forward_request` 将 Key cooldown 导致的“未发送请求”与真实上游失败合并为 `KeyExhausted`，继续累计熔断失败并按队列位置消耗 attempt 预算，快速把全部后备 provider 置为 open；usage 写入层又把这些失败的空采集统一分类为 `missing`，因此修复必须同时落在候选遍历/熔断计数边界和 usage 状态分类边界，而不是在 503 或“缺少 usage”展示处吞错。

## Discovery List

- [x] `src-tauri/src/daemon/route_http.rs::forward_request`：候选遍历、Key cooldown、attempt 预算、熔断失败累计、503 生成和失败 usage 记录的主链路。
- [x] `src-tauri/src/daemon/route_http.rs::RouteState::select_key` / `KeyPool::next_key`：当前用同一种错误表达锁异常与全部 Key 冷却。
- [x] `src-tauri/src/daemon/circuit.rs::CircuitRegistry`：open/half-open/timeout 和真实成功/失败计数；机制本身可恢复，确认不是持久化死锁。
- [x] `src-tauri/src/usage.rs::record_route_usage`：空 capture 不区分成功缺失与失败无 usage，统一写成 `missing`。
- [x] `src-tauri/src/commands/history.rs`：数据质量把 `missing` / `invalid` 计为缺失记录；失败 attempt 当前会污染该指标。
- [x] `src/components/stats/RequestLogsView.tsx`、`src/lib/types.ts`、`src/lib/i18n.ts`：usage 状态展示、类型与中英文文案消费者。
- [x] `.trellis/spec/backend/ccs-provider-domain-contracts.md`：流式失败立即熔断和候选顺序契约必须保留；本修复不把真实流失败降级为普通 skip。
- [x] `.trellis/spec/backend/history-stats-contracts.md`：失败 attempt 需保留状态记录，但不要求将失败无 Token 解释为成功响应 usage 缺失。
- [x] 场景：路由/故障转移开关、流式/非流式、单/多 Key、401/403/429 cooldown、网络/5xx、circuit open/half-open、并发请求、候选数大于重试预算、所有候选不可用。

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
