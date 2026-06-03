# fix project sidebar collapsed group drag drop

## Goal

修复左侧项目栏拖拽到折叠分组时无法稳定放入的问题：当目标分组未展开，拖拽悬停/放置过程中项目被布局挤压走，导致用户无法把项目拖进该分组。

## What I already know

* 问题发生在左侧项目栏的项目/分组拖拽交互。
* 目标分组处于未展开状态时，拖拽进入失败或难以完成。
* 用户描述的直接原因是拖拽放上去时目标区域会被挤压走。

## Assumptions (temporary)

* 该问题大概率与项目树组件的 drag/drop hover、折叠态展开或占位布局有关。
* 最小修复应优先保持现有拖拽数据结构和分组逻辑不变。

## Open Questions

* 无。

## Requirements (evolving)

* 用户可以把项目稳定拖入分组。
* 拖拽悬停在目标分组行时，不能先触发 sortable 位移把目标分组挤走。
* 修复不应破坏已展开分组、根级项目、分组排序等现有拖拽行为。
* 优先采用最小改动，不重写 dnd-kit 拖拽结构。

## Acceptance Criteria (evolving)

* [ ] 折叠分组作为拖拽目标时，拖拽区域稳定，不会因为布局挤压导致无法放入。
* [ ] 项目可以成功从根级或其他分组拖入折叠分组。
* [ ] 已展开分组的拖拽体验保持正常。
* [ ] TypeScript 检查通过。

## Definition of Done (team quality bar)

* Tests added/updated if there is a focused existing test harness.
* Lint / typecheck green where applicable.
* Direct UI behavior verified if the app can be launched locally.
* Rollback considered if risky.

## Out of Scope (explicit)

* 不重做项目树拖拽系统。
* 不引入新的拖拽库。
* 不调整项目/分组数据模型。

## Technical Notes

* 待检查：`src/components/sidebar/ProjectTree.tsx`、`src/components/sidebar/TreeNodeItem.tsx`。
