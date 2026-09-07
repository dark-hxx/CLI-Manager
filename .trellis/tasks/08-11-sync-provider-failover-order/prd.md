# 统一故障切换排序与侧边栏设置同步

## Changelog Target

`[TEMP]`

## Goal

统一终端侧边栏与设置页的供应商故障切换排序：自动故障切换关闭时不显示排序手柄；开启时两处都按同一 `sort_index` 顺序展示并使用一致的拖拽排序交互；任一入口修改顺序后，另一入口能刷新到相同顺序。

## Root Cause

- 侧边栏的优先级徽标和 `canReorder` 没有完整绑定 `autoFailoverEnabled`，所以关闭故障切换后仍显示 `#1`，并继续渲染拖拽手柄。
- 侧边栏定时 `refreshFailover()` 只合并 `circuit/circuits`，故意保留旧的 `failover.providers`；设置页或其他入口更新 `sort_index` 后，侧边栏持续显示旧顺序。
- 设置页定时 `refreshFailover()` 同样只合并熔断字段，侧边栏更新 `sort_index` 后，已打开的设置页会持续显示旧顺序。
- 设置页故障切换列表使用上下按钮，侧边栏使用 dnd-kit 拖拽，两个入口的排序交互和即时状态更新不一致。

## Discovery List

- 数据真源是后端 `providers.sort_index`；`provider_catalog_reorder` 会按 app type 重写全量供应商顺序。
- `routing_get_failover_queue` 返回的 `providers` 已按 `sort_index` 排序，不需要新增第二套队列顺序字段。
- 侧边栏 `reorderFailoverQueue` 已同时更新 catalog 与 failover 快照，但周期轮询没有接收外部顺序变化。
- 设置页 `reorderFailoverQueue` 已复用同一个后端命令，改造重点是交互统一与刷新一致性。
- 当前工作区已有 `ProviderQuickSwitchPanel.tsx`、`useProviderQuickSwitch.ts` 的未提交 Home 识别改动；本任务必须保留并兼容，不得回退。

## Requirements

- 自动故障切换关闭时，侧边栏供应商卡片不显示 `#N` 优先级徽标或拖拽排序手柄，也不响应拖拽排序。
- 自动故障切换开启时，侧边栏按后端 `sort_index` 顺序展示全量供应商，拖拽后立即按新顺序渲染。
- 自动故障切换开启时，已入队供应商必须自动置顶并按 `sort_index` 显示为 `#1/#2/...`；未入队供应商排在其后并保持各自的 `sort_index` 相对顺序。手动模式不做队列置顶。
- 自动故障切换开启时，点击侧边栏供应商卡片不得触发全局预览、确认或应用；供应商成员与优先级只能通过队列加入、移出和排序控件调整。
- 设置页故障切换列表在自动模式下使用与侧边栏一致的 dnd-kit 垂直拖拽排序；手动模式不显示排序手柄。
- 设置页“供应商目录”主列表在自动模式下也读取故障切换状态：队列成员连续置顶并显示 `#N`，卡片提供加入/移出队列及上下调整优先级操作；关闭自动模式后恢复普通目录展示。
- 侧边栏与设置页都只调用 `provider_catalog_reorder` 持久化全量 provider ID 顺序，不维护第二套前端排序来源。
- 侧边栏轮询必须接收最新 `failover.providers`，使设置页修改的顺序能同步回来；轮询期间保留既有请求版本保护和 action 防重入。
- 设置页修改排序后继续刷新其 failover state；重新打开或轮询侧边栏时顺序必须一致。
- 侧边栏与设置页的独立 Hook 实例共享最近一次成功的故障切换快照；队列、开关或排序写入成功后立即发布，新打开的入口先回放该快照，再由后端轮询校准。
- 拖拽手柄保持键盘可操作、可读 aria-label 和现有中英文文案，不新增硬编码用户可见文案。
- 搜索、CLI 切换、手动热切换、队列加入/移出、熔断状态轮询与现有 Home/WSL 识别行为不得回归。

## Scenario Enumeration

- 自动故障切换开启/关闭切换；本地路由未接管；daemon 不可用或操作 busy。
- 供应商为 0、1、多个；ready/not-ready；入队/未入队；当前 provider 与非当前 provider。
- 侧边栏先排序后打开设置页；设置页先排序后返回侧边栏；面板保持打开时由轮询接收外部变化。
- 鼠标拖拽与键盘拖拽；长名称、中英文界面；不同 CLI app type 的顺序相互隔离。
- 当前工作区本地 Home、WSL Home 识别改动并存，排序修复不得假设固定 `local:host`。

## Acceptance Criteria

- [ ] 自动故障切换关闭后，侧边栏不再显示 `#N` 优先级徽标，也不显示或响应排序手柄。
- [ ] 自动故障切换开启后，侧边栏严格按 `sort_index` 展示，拖拽后顺序立即更新并在刷新后保持。
- [ ] 自动故障切换开启后，`#1/#2/...` 队列成员连续置顶，未入队供应商随后显示；设置页故障切换列表遵循同一规则。
- [ ] 自动故障切换开启后，点击侧边栏供应商卡片不弹出“应用全局供应商”确认框，也不执行全局或手动热切换；队列操作仍可正常使用。
- [ ] 设置页自动故障切换列表提供与侧边栏一致的拖拽排序，关闭/手动模式不显示排序手柄。
- [ ] 设置页“供应商目录”主列表在自动模式下与侧边栏显示相同的队列成员、`#N`、加入/移出和优先级顺序。
- [ ] 在侧边栏修改顺序后，设置页展示相同顺序；在设置页修改后，侧边栏通过刷新展示相同顺序。
- [ ] 两处排序均提交当前 app type 的全量 provider ID，未引入独立队列排序状态。
- [ ] 队列成员状态、优先级编号、当前 provider、ready 与 circuit 状态仍正确。
- [ ] `npx tsc --noEmit` 通过，相关前端测试通过。
- [ ] `CHANGELOG.md` 的 `[TEMP]` 与 `docs/功能清单.md` 已更新。

## Out of Scope

- 修改后端故障切换算法、数据库 schema 或 IPC 参数。
- 改变手动模式的单 provider 队列约束。
- 重做供应商卡片视觉设计或故障切换参数表。

## Technical Approach

- 将侧边栏 `canReorder` 绑定 `autoFailover`；共享派生排序先按 `inFailoverQueue` 分组，再在组内按 `sortIndex` 排序，且不新增持久化顺序字段。
- 让侧边栏 `refreshFailover` 用服务端最新 failover state 更新 provider 顺序，而非只合并 circuit 字段。
- 在 `NativeProviderFailoverSection` 复用项目既有 dnd-kit 配置、`DND_ACTIVATION_CONSTRAINT` 与 `DND_SORTABLE_TRANSITION`，提交完整 provider ID 顺序。
- 保留设置页 `useNativeProviderRouting.reorderFailoverQueue` 的后端持久化与刷新链路。

## Definition of Done

- 完成实现、类型检查和有针对性的测试。
- 运行 GitNexus `detect_changes`，确认影响仅限预期供应商排序链路。
- 更新 Changelog、功能清单与任务记录，不覆盖工作区已有未提交改动。
