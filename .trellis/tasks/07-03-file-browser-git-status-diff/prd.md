# file browser git status and diff view

## Changelog Target

V1.2.5

## Goal

在文件浏览器中直接展示 Git 文件状态，并在打开变更文件时能看到该文件具体变更位置，减少用户在文件树和 Git 面板之间来回切换。

## What I already know

* 用户引用 issue #83，要求文件浏览器标记修改、新增、未管理等 Git 状态。
* 用户期望不同状态使用不同颜色：新增绿色、修改蓝色，效果参考 IDEA。
* 用户截图展示的是编辑器行号/滚动条附近的变更标记。
* 仓库已有 `git_get_changes`、`git_get_file_diff`、`DiffViewerModal`。
* 文件浏览器已有 `gitChanges` 状态，并已对文件名做基础状态上色。

## Requirements

* 文件浏览器中的文件状态要清晰可见，覆盖修改、新增、删除、重命名、冲突、未跟踪。
* 状态颜色要统一且可区分：新增绿色，修改蓝色，删除红色，未跟踪灰/紫色，冲突红色。
* 打开变更文件后，编辑器中应显示变更位置标记，类似 IDEA 的 gutter / overview ruler。
* 文件浏览器右键菜单应支持直接打开文件 Diff。
* Diff 应在中间文件浏览/编辑器 tab 内展示，而不是只能以弹窗展示。
* 内嵌 Diff 视图应支持文件级、hunk 级和选中行级回滚，复用现有 Git 回滚能力。
* 继续复用现有 Git 查询与 diff 能力，不新增依赖。
* 变更需要同步中英文文案。

## Acceptance Criteria

* [ ] 文件浏览器能看到修改、新增、未跟踪文件的状态标记和颜色。
* [ ] 搜索结果中的文件状态展示与文件树一致。
* [ ] 打开有 Git 变更的文本文件后，编辑器边栏/滚动条区域显示新增、修改、删除位置。
* [ ] 有 Git 变更的文件右键菜单可打开 Diff tab。
* [ ] Diff tab 在文件编辑器区域展示，并可执行 hunk/选中行/文件回滚。
* [ ] 普通未变更文件保持现有打开与编辑行为。
* [ ] `npx tsc --noEmit` 通过。
* [ ] `cd src-tauri && cargo check` 通过。

## Definition of Done

* Tests or static checks pass where practical.
* `CHANGELOG.md` updated under `V1.2.5`.
* `docs/功能清单.md` updated because product functionality changes.
* Commit message should reference `#83` if committing this task.

## Out of Scope

* 不做完整 Git 提交/暂存流程重构。
* 不新增第三方 diff/editor 库。
* 不改变现有 Git 面板的提交、推送、拉取行为。

## Technical Notes

* `src/components/files/FileExplorerSidebar.tsx` already maps `gitChanges` to display status.
* `src/stores/fileExplorerStore.ts` fetches `git_get_changes` on project open and visible refresh.
* `src/components/files/FileEditorPane.tsx` uses Monaco and already has search decorations.
* `src/components/git/DiffViewerModal.tsx` uses `git_get_file_diff` for modal diff rendering.
* `src-tauri/src/commands/git.rs` provides `git_get_changes` and `git_get_file_diff`.
* 2026-07-03 追加：内嵌 Diff 应从 `DiffViewerModal` 抽出共享内容，避免复制回滚逻辑。
