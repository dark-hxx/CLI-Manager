# optimize file explorer auto refresh

## Goal

优化终端内 Codex 或外部工具修改文件后的文件浏览器自动刷新，减少无效 IO，并避免连续写文件时刷新并发乱序。

## Requirements

* `project-files-changed` 事件携带变更路径，前端能按路径缩小刷新范围。
* 前端刷新需要串行合并，避免多个 watcher 事件同时执行 `refreshVisibleState()`。
* 保留现有行为：窗口不可见或失焦时不主动刷新，重新聚焦补刷新。
* 保留现有保护：已打开且未保存的脏文件不被外部变更覆盖。
* watcher 不可用时继续降级慢轮询。

## Acceptance Criteria

* [ ] 终端连续修改多个文件时，文件浏览器只触发合并后的刷新，不出现并发刷新。
* [ ] 变更事件包含相对路径，前端优先刷新相关目录。
* [ ] 已展开目录保持展开。
* [ ] 未脏的已打开文件在外部修改后自动更新。
* [ ] 脏文件不会被自动覆盖。
* [ ] `npx tsc --noEmit` 通过。
* [ ] `cd src-tauri && cargo check` 通过。

## Definition of Done

* 影响范围已通过 GitNexus 检查。
* 行为变更记录到 `CHANGELOG.md`。
* 产品功能变化同步到 `docs/功能清单.md`。

## Technical Approach

后端 watcher payload 从只包含 `projectPath` 扩展为 `projectPath + changedPaths`。前端监听事件时把变更路径传入 store，store 根据根目录、已展开目录、已打开文件父目录、变更父目录计算最小刷新集合，并用 `refreshInFlight/pendingRefresh` 合并并发刷新。

## Decision (ADR-lite)

**Context**: 当前事件粒度过粗，前端每次只能刷新所有可见范围；连续文件写入可能重叠刷新。  
**Decision**: 增加路径粒度并在 store 内串行化刷新。  
**Consequences**: 需要改动前后端事件契约；旧前端不会消费新字段，但当前应用前后端同版本发布，兼容风险低。

## Out of Scope

* 不做脏文件冲突提示 UI。
* 不引入文件 hash。
* 不重构 Git watcher。

## Technical Notes

* 相关文件：`src-tauri/src/file_watcher.rs`
* 相关文件：`src/components/files/FileExplorerSidebar.tsx`
* 相关文件：`src/stores/fileExplorerStore.ts`
* 参考任务：`.trellis/tasks/07-03-terminal-file-explorer-auto-refresh/prd.md`
* Changelog Target: `[TEMP]`
