# 技术设计：自动故障转移当前供应商高亮

## 设计目标

让持久化的 `providers.is_current` 在成功路由提交后代表后续请求会优先使用的供应商，从源头保证 daemon、设置页和供应商快捷面板对“当前供应商”的理解一致。

## 当前数据流

1. `load_failover_provider_ids_for_daemon` 选择队列内且 ready 的供应商，并仅在当前供应商也位于队列内时将其提前。
2. `forward_request` 依次尝试候选，记录成功候选的数组索引。
3. 非流式完整成功或流式语义完成时，仅当索引大于 `0` 才调用 `apply_hot_switch_for_active_homes`。
4. 热切换成功后由 `commit_provider_current` 更新 `providers.is_current`。
5. `routing_get_failover_queue` 回传 `isCurrent`；前端据此高亮。

错误假设发生在第 3 步：候选索引 `0` 不一定是数据库当前供应商。

## 方案比较

### 方案 A：前端从队列和熔断状态推测当前供应商

- 优点：改动局部。
- 缺点：只能预测候选，无法证明请求成功；流式失败、并发请求和热切换回滚时会显示错误状态；设置页仍可能不一致。
- 结论：不采用。

### 方案 B：扩展 daemon 状态协议，报告最近一次成功供应商

- 优点：可展示最近请求的运行时供应商。
- 缺点：需要新增共享状态、daemon 协议和 IPC 契约；并发请求下“当前”语义仍需额外定义，超出本次修复范围。
- 结论：不采用。

### 方案 C：按供应商身份而非候选索引决定是否提交热切换（采用）

- 在 `ProviderSnapshot` 中保留该候选加载时的 `is_current`。
- 成功提交条件从 `selected_provider_index > 0` 改为“自动故障转移开启且所选候选不是加载时的当前供应商”。
- 非流式和流式分支共用同一派生布尔值，继续调用既有 `apply_hot_switch_for_active_homes`。
- 优点：修复根因，不扩展协议，保留事务/回滚保护，两个 UI 消费者自然一致。
- 风险：并发请求可能同时观察到旧 `is_current` 并尝试相同切换；既有后续候选切换也存在同类并发窗口，继续由现有 app 锁和热切换流程串行保护。本任务不改变并发协议。

## 状态与提交边界

- `ProviderSnapshot.is_current` 是请求开始时的权威快照，只用于判断该次成功是否代表供应商身份变化。
- HTTP 成功状态仍沿用 `classify_upstream_status(status) == Success`。
- 非流式必须成功读取完整 body 后提交。
- 流式必须由 `StreamCommitTracker` 产生 `Success` 后提交。
- 失败、取消和 Drop 路径只释放熔断 permit，不提交切换。

## 兼容性与回滚

- 不修改数据库 schema、序列化结构、Tauri command 参数或 daemon 协议。
- 自动故障转移关闭时只加载当前供应商，且不安排自动热切换。
- 回滚只需恢复 `route_http.rs` 的身份判断；数据库和配置无需迁移。

## 测试设计

- 提取或复用一个纯判定点，覆盖：当前候选、非当前首候选、非当前后续候选、自动模式关闭。
- 保留流式提交跟踪测试，新增断言确保只有成功完成才携带热切换提交。
- 运行 `cargo test` 覆盖 route_http 及 provider routing 现有测试。

## ADR-lite

**Context**：候选索引不能表达候选是否等于持久化当前供应商。

**Decision**：在请求候选快照中携带 `is_current`，以供应商身份差异决定成功后的热切换提交；前端继续消费后端权威状态。

**Consequences**：修复队列排除当前供应商时的高亮错误，不增加协议复杂度；UI 会在请求成功并完成热切换、随后轮询后更新，而不是在仅修改队列时提前预测。
