# 修复自动故障转移当前供应商高亮

## Goal

自动故障转移启用后，供应商快捷面板和设置页展示的“当前供应商”必须与路由成功后实际持续使用的供应商一致，不能继续高亮已被队列替代的全局供应商。

## What I already know

- 用户截图中自动故障转移队列包含前三个供应商，但被高亮的全局当前供应商“君”不在队列内。
- daemon 自动模式只从已入队且 ready 的供应商生成候选；若数据库当前供应商不在队列内，队列首项会成为第一个实际请求候选。
- 路由成功后的热切换目前以 `selected_provider_index > 0` 为触发条件。当队列首项不是数据库当前供应商时，它的索引仍是 `0`，因此不会提交 `is_current`，前端继续高亮旧供应商。
- 供应商快捷面板每秒读取 `routing_get_failover_queue`，其高亮来自返回供应商的 `isCurrent`。

## Root-Cause Statement

根因位于 daemon 路由成功提交边界：代码把“发生供应商切换”等同于“选中了候选列表的后续索引”，但自动队列可以排除数据库当前供应商，使索引 `0` 也代表一次真实切换；修复应落在成功提交条件，而不是在前端猜测当前供应商。

## Requirements

- 自动故障转移开启时，任一非数据库当前供应商成功完成请求后，系统应执行既有安全热切换流程并将其提交为当前供应商。
- 非流式响应只在上游响应完整读取且状态成功后提交切换。
- 流式响应只在现有语义完成事件确认成功后提交切换；失败、取消或不完整流不得改变当前供应商。
- 已是当前供应商的成功请求不得产生重复热切换。
- 自动故障转移关闭时保持现有单供应商行为。
- 前端继续以权威 `isCurrent` 状态渲染高亮，侧边栏与设置页保持一致。
- 保留现有热切换的预览、指纹校验、回滚和多 Home 一致性保护。

## Acceptance Criteria

- [ ] 当前供应商不在自动队列时，队列首个 ready 供应商成功处理非流式请求后成为 `isCurrent`，侧边栏下一次轮询高亮该供应商。
- [ ] 同一场景下，流式请求仅在成功完成事件后更新 `isCurrent`。
- [ ] 非当前供应商返回失败、流式失败、流式中断或客户端取消时不更新 `isCurrent`。
- [ ] 当前供应商仍在队列且成功处理请求时不执行冗余热切换。
- [ ] 熔断跳过当前供应商并由后续供应商成功处理时，成功供应商成为当前供应商。
- [ ] 设置页和供应商快捷面板在后端状态刷新后显示同一当前供应商。
- [ ] Rust 定向测试、`cargo test`、`cargo check` 与前端 `npx tsc --noEmit` 通过。
- [ ] `CHANGELOG.md` 的 `TEMP` 版本和 `docs/功能清单.md` 同步记录行为修复。

## Scenario Coverage

- 当前供应商在队列内：继续优先使用；成功不重复提交，失败后切到后续成功供应商。
- 当前供应商不在队列内：首个成功队列供应商也必须提交为当前供应商。
- 候选不可用或熔断：跳过的供应商不成为当前；实际成功者成为当前。
- 流式/非流式：均以各自既有成功提交点为准。
- 本地 PowerShell/CMD/Pwsh、WSL：复用现有 active Home 热切换目标；SSH 不属于本地路由接管范围。
- 多窗口、分屏、Workspan：均通过共享后端状态和轮询收敛，不引入窗口局部状态。
- daemon 未连接、路由未接管、自动故障转移关闭：不进入本修复路径。

## Discovery List

- [x] `src-tauri/src/daemon/route_http.rs`：候选加载、成功响应判定、流式提交与热切换触发条件；本次根因触点。
- [x] `src-tauri/src/provider/routing.rs`：队列资格、当前供应商优先级及 `apply_hot_switch_for_active_homes`；复用既有安全切换流程。
- [x] `src-tauri/src/provider/global.rs`：热切换提交与失败回滚；确认无需改写事务协议。
- [x] `src/components/terminal/ProviderQuickSwitchPanel.tsx`：高亮消费 `isCurrent`；确认不在前端添加推测逻辑。
- [x] `src/components/terminal/useProviderQuickSwitch.ts`：每秒同步完整 failover 快照；确认无需新增轮询链路。
- [x] `src/components/settings/providers/NativeProviderCard.tsx`：设置页同样消费 failover `isCurrent`；确认将随权威状态自动一致。
- [x] daemon `RoutingStatus` 协议：只报告运行与熔断状态；本次不扩展 IPC/协议。

## Definition of Done

- 根因条件由测试覆盖，流式与非流式提交语义保持一致。
- 类型检查、Rust 检查及相关测试通过。
- GitNexus 变更检测仅命中预期 daemon 路由流程。
- 产品变更记录同步完成。

## Out of Scope

- 不新增“请求处理中供应商”或每个并发请求的实时 UI 指示器。
- 不改变故障转移队列排序、重试次数、熔断策略或手动热切换交互。
- 不新增 daemon 协议字段或 IPC 契约。
- 不修改已有本地路由接管和多 Home 回滚协议。

## Technical Notes

- GitNexus 对 `forward_request` 和 `load_provider_snapshot_for_provider` 的上游影响均为 LOW，直接范围限定在 daemon 请求处理链。
- 现有工作区包含上一项 UI 小字调整：`ProviderQuickSwitchPanel.tsx`、`CHANGELOG.md`、`docs/功能清单.md`。实现时必须保留并区分这些改动。
- 版本未指定，变更记录使用 `TEMP`。
