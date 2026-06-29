# 会话历史列表批量删除

## Goal

在会话历史侧栏的会话列表中增加批量删除能力，让用户能一次删除多条本地历史会话，减少逐条删除的重复操作，同时尽量复用现有单条删除链路，避免扩大后端改动面。

## What I already know

* 历史会话主界面入口在 `src/components/HistoryWorkspace.tsx`，列表面板在 `src/components/history/HistoryListPane.tsx`。
* 当前已有单条删除能力：前端通过 `src/stores/historyStore.ts` 的 `deleteSession` 调用后端 `history_delete_session`。
* 后端删除命令位于 `src-tauri/src/commands/history.rs`，当前只提供单条会话文件删除。
* 历史会话属于用户可见界面，新增文案必须同时支持 `zh-CN` 和 `en-US`，统一走 `src/lib/i18n.ts`。

## Assumptions (temporary)

* 本次优先做最小可用版本，不新增后端批量删除 IPC。
* 批量删除默认仅作用于用户明确勾选的会话，不提供“删除所有筛选结果”这类高风险快捷操作。
* 删除时仍保留确认弹层，确认内容展示选中数量，降低误删风险。

## Open Questions

* 批量选择交互是否采用“进入选择模式后显示复选框和批量操作栏”的方案。

## Requirements (evolving)

* 用户可以在会话历史列表中进入批量选择状态。
* 用户可以勾选多条会话，并执行一次性删除。
* 用户可以取消批量选择，且不影响现有单条打开、继续会话、右键菜单等常规交互。
* 删除完成后，列表、活动会话、搜索命中和本地元数据状态需要保持一致。
* 新增文案需要覆盖中英文。

## Acceptance Criteria (evolving)

* [ ] 列表中可进入批量选择并勾选多条会话。
* [ ] 点击批量删除后会弹出确认，确认后选中会话全部从列表移除。
* [ ] 删除后若当前活动会话在被删集合内，界面能正确切换到新的活动会话或清空详情。
* [ ] 中英文文案完整，无硬编码。
* [ ] 前端类型检查通过；如涉及后端改动，再补 `cargo check`。

## Definition of Done (team quality bar)

* Tests added/updated (unit/integration where appropriate)
* Lint / typecheck / CI green
* Docs/notes updated if behavior changes
* Rollout/rollback considered if risky

## Out of Scope (explicit)

* 新增后端批量删除命令
* 删除当前全部筛选结果
* 回收站、撤销删除、软删除

## Technical Notes

* 关键文件：
  * `src/components/HistoryWorkspace.tsx`
  * `src/components/history/HistoryListPane.tsx`
  * `src/stores/historyStore.ts`
  * `src/lib/i18n.ts`
* GitNexus 初步影响面：
  * `HistoryWorkspace`：LOW
  * `HistoryListPane`：LOW
  * `history_delete_session`：LOW
