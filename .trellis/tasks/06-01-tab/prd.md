# 内部终端 tab 与左侧目录联动选中

## Goal

当内部终端上方 tab 栏切换到某个项目终端时，左侧菜单树同步选中该终端对应的项目目录项；当左侧菜单树选中项目时，如果该项目已有内部终端 tab，也切到对应 tab，让两边互相定位。

## What I already know

* 用户要求：内部终端 tab 被选中时，对应左侧菜单树也要选中对应目录。
* 用户追加要求：左侧菜单树选中项目时，如果该项目已有内部终端 tab，也要切到对应 tab。
* 项目是 React 19 + Zustand + Tauri 2，前端终端状态在 `src/stores/terminalStore.ts`。
* 终端 tab 点击通过 `TerminalTabs` 调用 `useTerminalStore.setActive(sessionId)`。
* `TerminalSession` 带 `projectId`，普通“新建终端”可能没有 `projectId`。
* 左侧树选中态在 `src/components/sidebar/index.tsx` 内部维护：`selectedId` 与 `selectedProjectIds`。
* 树节点高亮由 `TreeNodeItem` 读取 `actions.selectedId` / `actions.selectedProjectIds`。

## Assumptions (temporary)

* MVP 只需要同步“项目终端”的选中；无项目终端不改变左树选中。
* 不新增依赖，不引入新的全局 store；优先用现有 Zustand 状态派生同步。
* 同步应覆盖 tab 点击、快捷键切换、通知 toast 激活 tab 等所有调用 `setActive` 的路径。

## Open Questions

* （已回答）无项目终端或分屏终端成为 active 时，左侧树保持原选中。
* （已回答）一个项目如果已经打开了多个内部终端 tab，左树选中项目时激活第一个匹配 tab。

## Requirements (evolving)

* 当 active tab 的 session 有 `projectId` 时，左侧树选中该项目。
* 当 active tab 的 session 没有 `projectId` 时，左侧树保持当前选中态。
* 当左侧树选中项目时，如果存在该项目对应的内部终端 tab，则激活第一个匹配 tab。
* 当左侧树显式打开/启动项目时，仍按旧行为创建新终端，允许同项目多个终端。
* 同步逻辑应不影响手动多选的基本交互。
* 不新增依赖。

## Acceptance Criteria (evolving)

* [ ] 点击项目 A 的终端 tab 后，左侧树项目 A 显示选中态。
* [ ] 点击项目 B 的终端 tab 后，左侧树项目 B 显示选中态。
* [ ] 切到无 `projectId` 的普通终端时，左侧树保持原选中。
* [ ] 点击左侧树项目 A 后，如果存在项目 A 的内部终端 tab，会切到第一个匹配 tab。
* [ ] 点击项目 A 的打开/启动动作时，仍会创建新的内部终端。
* [ ] `npm run build` 或至少 `npx tsc --noEmit` 通过。

## Definition of Done

* 类型检查通过。
* 能启动 UI 时，手动验证 tab 切换联动左树选中。
* 能启动 UI 时，手动验证左树选中会激活已有项目 tab。
* 能启动 UI 时，手动验证显式打开项目仍会新开终端。
* 如发现 GitNexus 影响分析可用，编辑前完成影响分析。

## Out of Scope

* 不改变终端创建、关闭、恢复逻辑。
* 不改变项目树拖拽、重命名、删除、多选批量操作。
* 不新增持久化字段。

## Technical Approach

在 `Sidebar` 中订阅 `useTerminalStore` 的 `sessions` 与 `activeSessionId`，用 active session 的 `projectId` 派生左树选中态：有项目时同步 `selectedId` 与 `selectedProjectIds`；无项目时不改动当前树选中。反向联动时，左树项目点击先查找已有同 `projectId` 的 session，存在则 `setActive`，不存在才走原来的打开流程。

## Decision (ADR-lite)

**Context**: 终端 tab 激活态在全局 `terminalStore`，左侧树选中态目前在 `Sidebar` 本地维护，两者缺少同步。
**Decision**: 在左侧树的最近拥有选中态组件 `Sidebar` 内做派生同步，而不是把树选中态提升到全局。
**Consequences**: 改动范围最小；项目 tab 会覆盖树选中，多选会在 tab 切换到项目时收敛到当前项目；普通终端不改变树选中；左树选中已启动项目时会优先复用已有 tab。

## Technical Notes

* 相关文件：`src/components/TerminalTabs.tsx`、`src/stores/terminalStore.ts`、`src/components/sidebar/index.tsx`、`src/components/sidebar/TreeNodeItem.tsx`、`src/components/sidebar/TreeContext.tsx`。
* 最小方案倾向：在 `Sidebar` 订阅 `activeSessionId + sessions`，根据 active session 的 `projectId` 同步本地 `selectedId/selectedProjectIds`；左树选中项目时用 `sessions.find(s => s.projectId === project.id)` 复用已有 tab。
