# fix-new-terminal-group-dropdown-selection

## Goal

修复新增终端弹窗中“分组”下拉框能展开但无法选择的问题，确保新增时可以正常选择已有分组并保存。

## What I already know

* 用户反馈：新增终端时，分组下拉框可以正常下拉，但无法选择。
* 分组选择逻辑位于 `src/components/ConfigModal.tsx` 的本地 `GroupSelector`。
* `GroupSelector` 通过 `Portal` 把下拉面板渲染到弹窗内容外部。

## Assumptions (temporary)

* 问题与新增终端弹窗内的分组选择交互有关，不改变分组数据结构和项目保存逻辑。
* 优先做最小修复：让下拉项点击能触发 `onChange` 并关闭菜单。

## Open Questions

* 无阻塞问题，先按用户描述修复新增终端分组选择。

## Requirements (evolving)

* 新增终端时，分组下拉可以展开。
* 点击已有分组后，字段显示选中的分组名称。
* 点击“不分组”后，字段回到不分组。
* 分组下拉改为弹窗内部渲染，避免 Dialog 外部交互拦截。
* 不改变项目保存的数据结构。

## Acceptance Criteria

* [x] 新增终端弹窗里可以选择已有分组。
* [x] 可以切回“不分组”。
* [x] 编辑/复制终端配置时分组选择不退化。
* [x] 类型检查通过。
* [x] 生产构建通过。
* [ ] 浏览器/桌面手动验证（用户选择跳过）。

## Definition of Done (team quality bar)

* Tests added/updated where appropriate.
* Lint / typecheck / CI-relevant checks pass.
* Docs/notes updated if behavior changes.
* Rollout/rollback considered if risky.

## Out of Scope (explicit)

* 不新增依赖。
* 不重构整个表单或分组数据流。
* 不改变数据库 schema。

## Decision (ADR-lite)

**Context**: `GroupSelector` 的下拉面板 Portal 到 Dialog content 外部，选项点击可能被 Radix Dialog 当作外部交互处理。
**Decision**: 按用户选择，将分组下拉改为弹窗内部绝对定位渲染，不再使用 Portal。
**Consequences**: 点击属于 Dialog 内部交互，避免外部交互拦截；面板定位不再做 viewport 翻转，保持表单内简单下拉。

## Technical Notes

* 已读文件：`src/components/ConfigModal.tsx`、`src/components/ui/dialog.tsx`、`src/components/ui/Portal.tsx`。
* `GroupSelector` 当前通过 `Portal` 渲染到 `document.body`，不在 Radix Dialog content DOM 内。
* 新增终端弹窗使用 Radix Dialog；portaled 面板点击会被视为 Dialog content 外部交互，可能在 option `onClick` 前被拦截/关闭。
* GitNexus impact：`GroupSelector` LOW，0 direct callers，0 affected processes。
