# terminal file explorer auto refresh after external edits

## Goal

让终端内或外部工具修改项目文件后，文件浏览器与文件预览能够自动刷新，避免用户手动点刷新，同时把性能成本控制在低水平。

## What I already know

* 用户报告对应 GitHub issue：#80。
* 目标版本为 `V1.2.5`。
* 当前文件浏览器手动刷新入口在 `src/components/files/FileExplorerSidebar.tsx`，调用 store 的 `refresh()`。
* 当前 `refresh()` 会重新 `openProject()`，属于全量刷新路径。
* Git 面板已经实现 `fs-watcher + debounce + 失败降级慢轮询`，位于 `src/components/git/GitChangesPanel.tsx` 与 `src-tauri/src/git_watcher.rs`。
* 文件树数据项已有 `modifiedMs`，可用于轻量变更判断。
* 文件预览状态在 `src/stores/fileExplorerStore.ts` 的 `openFiles` / `activeFile` 中维护。

## Assumptions

* 本次优先解决当前已打开项目文件浏览器/文件编辑器的自动刷新，不扩展到所有后台项目。
* 脏文件（未保存编辑）绝不能被外部变更自动覆盖。
* WSL UNC / 网络盘 watcher 失败时允许降级为低频轮询。

## Requirements

* 当当前项目目录发生外部文件变更时，文件浏览器自动刷新可见范围，而不是要求用户手动点击刷新。
* 已展开目录保持展开状态，避免刷新后树结构塌陷。
* 已打开且未修改的文件，如果磁盘内容变化，应自动重读预览内容。
* 已打开但有未保存修改的文件，不自动覆盖内容。
* 文件状态（如 Git 状态点）保持同步。
* 搜索结果仅在当前存在搜索词时重算。
* 性能上避免固定高频全量轮询。

## Acceptance Criteria

* [ ] 打开文件浏览器后，在终端中修改并保存同项目文件，文件树无需手动操作即可反映变化。
* [ ] 已展开目录刷新后仍保持展开。
* [ ] 未脏的已打开文本文件在外部修改后，预览内容自动更新。
* [ ] 脏文件在外部修改后不会被自动覆盖。
* [ ] watcher 初始化失败时有降级路径，不阻塞原功能。
* [ ] `CHANGELOG.md` 与 `docs/功能清单.md` 同步更新。

## Definition of Done

* `npx tsc --noEmit` 通过。
* `cd src-tauri && cargo check` 通过。
* 变更影响范围已检查。
* 文档已更新。

## Technical Approach

复用现有 watcher 架构，但为文件浏览器提供独立事件通道与刷新逻辑：

* 后端新增文件浏览器 watcher bridge，沿用 notify debouncer。
* 前端文件浏览器在项目打开时订阅 watcher 事件。
* 收到事件后只刷新根目录、已展开目录、已打开文件父目录，并按需重读未脏打开文件。
* watcher 不可用时降级为低频轮询，并在窗口重新聚焦时补一次刷新。

## Decision (ADR-lite)

**Context**: 需要自动刷新，但不能引入高成本全量轮询，也不能破坏当前文件编辑状态。  
**Decision**: 采用 watcher 驱动的增量刷新，复用现有 Git watcher 模式，但不给文件浏览器直接复用同一个单实例 bridge，避免面板之间互相抢占。  
**Consequences**: 代码会跨前后端多文件调整，但运行时开销可控，且能保留失焦/失败降级策略。

## Out of Scope

* 不实现所有项目的全局后台监听。
* 不处理远程协同冲突提示 UI。
* 不改动项目文件命令协议本身。

## Technical Notes

* 相关前端：`src/stores/fileExplorerStore.ts`、`src/components/files/FileExplorerSidebar.tsx`
* 相关后端：`src-tauri/src/git_watcher.rs`、`src-tauri/src/lib.rs`、`src-tauri/src/commands/*`
* 相关规约：`.trellis/spec/backend/project-file-command-contracts.md`、`.trellis/spec/backend/wsl-path-contracts.md`
* 共享交付规约：`.trellis/spec/guides/task-delivery-checklist.md`
* Changelog Target: `V1.2.5`
