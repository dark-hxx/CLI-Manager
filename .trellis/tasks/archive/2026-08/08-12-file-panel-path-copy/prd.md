# file-panel-path-copy

## Changelog Target

`[TEMP]`

## Goal

增强文件面板的路径复制能力：右键菜单的“复制路径”直接复制所选文件或目录的绝对路径，并新增二级路径复制菜单，提供 AI 路径与项目相对路径等格式，方便终端、AI 提示词和系统文件操作场景复用。

## What I already know

- 文件面板实现位于 `src/components/files/FileExplorerSidebar.tsx`，文件树节点、搜索结果和根区域都有独立右键菜单。
- 文件树当前已有“复制 AI 路径”和目录“复制 AI 树”；AI 路径由 `src/lib/aiPathFormatter.ts` 生成。
- `Project.path` 是本地项目根路径；SSH 项目使用 `Project.remote_path`，文件面板对 SSH 项目为只读。
- 自定义 Radix 菜单已提供 `ContextMenuSub`、`ContextMenuSubTrigger`、`ContextMenuSubContent`，可复用二级菜单模式。
- 前端新增用户可见文案必须同时维护 `zh-CN` 与 `en-US`。

## Assumptions

- “绝对路径”对本地项目使用 `project.path` 拼接相对路径；SSH 项目使用 `project.remote_path` 作为远端绝对路径。
- “相对路径”使用文件树提供的项目相对路径格式（正斜杠分隔），根目录使用 `.`。
- 目录路径复制不额外添加尾部斜杠，AI 路径继续遵循现有 formatter 的目录尾斜杠约定。
- 文件面板、文件搜索结果、根区域与 Git 变更面板的路径复制行为保持一致。

## Requirements

- [x] 文件/目录右键菜单提供顶层“复制路径”，直接复制绝对路径。
- [x] 右键菜单提供二级“复制路径为”菜单，至少包含“复制 AI 路径”和“复制相对路径”。
- [x] 搜索结果行与根区域也提供相同的复制能力，根目录可复制本地/远端项目绝对路径、`.` 相对路径与 `@` AI 路径。
- [x] Git 变更面板的文件与目录节点也提供相同的路径复制能力。
- [x] 复制成功与失败提示均使用 i18n，兼容中文和英文。
- [x] 不改变现有文件编辑、拖拽、复制/粘贴、AI 树复制和打开所在文件夹行为。

## Acceptance Criteria

- [x] 本地项目文件 `src/foo.ts` 的“复制路径”得到项目根绝对路径下的 `src/foo.ts`。
- [x] SSH 项目文件 `src/foo.ts` 的“复制路径”得到 `remote_path` 下的远端绝对路径，不回落到空的本地 `path`。
- [x] “复制相对路径”得到 `src/foo.ts`；根区域得到 `.`。
- [x] “复制 AI 路径”继续得到现有格式（文件 `@src/foo.ts`，目录保留现有尾斜杠规则）。
- [x] 文件树、搜索文件结果、内容搜索结果、根区域均可访问路径菜单，菜单不会影响原有右键操作。
- [x] Git 变更面板的文件与目录节点均可访问路径菜单，菜单不会影响原有暂存/回滚操作。
- [x] `zh-CN` 与 `en-US` 下新增菜单项、toast 和可访问名称均有对应文案。
- [x] `npx tsc --noEmit` 通过。

## Definition of Done

- Tests or focused verification added/updated where appropriate.
- Frontend typecheck passes.
- `CHANGELOG.md` and `docs/功能清单.md` record the user-visible behavior.
- GitNexus impact is checked before symbol edits and change detection is run before commit.

## Technical Approach

- 在文件面板复用一个统一的路径格式化/复制 helper，集中处理本地、SSH、根目录、文件/目录及分隔符，避免三个右键菜单各自实现。
- 顶层菜单只保留绝对路径快捷操作；AI/相对路径放入 `ContextMenuSub` 二级菜单。
- 现有 AI 路径 formatter 继续作为 AI 格式的唯一来源。

## Decision (ADR-lite)

**Context**: 文件面板已有 AI 路径快捷操作，但缺少绝对路径和相对路径，且不同展示入口容易产生行为不一致。

**Decision**: 在文件面板与 Git 树共用路径格式化/复制 helper，并复用 Radix 二级菜单；SSH 绝对路径基于 `remote_path`，Git 树按其关联项目根路径计算。

**Consequences**: 复制行为一致且以后可扩展为 URI、终端参数等格式；不新增 IPC 或文件系统权限。

## Out of Scope

- 不修改终端拖拽路径格式或编辑器中的 AI 上下文复制格式。
- 不为历史 Diff 面板增加新的绝对/相对路径菜单。
- 不新增路径持久化设置或用户自定义复制模板。

## Technical Notes

- Relevant component: `src/components/files/FileExplorerSidebar.tsx`
- Git tree component: `src/components/git/GitTreeNode.tsx`
- Existing formatter: `src/lib/aiPathFormatter.ts`
- Menu primitives: `src/components/ui/context-menu.tsx`
- Translation catalog: `src/lib/i18n.ts`
- Scenario gate covered: local/SSH, file/directory/root/search/Git changes, read-only menu, Chinese/English.
