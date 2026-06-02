# terminal-tab-overflow-navigation

## Goal

终端 Tab 数量过多时，后面的 Tab 仍然可以被发现、切换和关闭；激活某个终端后，它应该自动出现在 Tab 栏可视区域内。目标是借鉴 IntelliJ IDEA 的单行 Tab 溢出处理思路，用最小改动改善多终端场景，不改变终端会话生命周期和分屏逻辑。

## What I already know

* 用户已同意采用 IDEA 风格的 Tab 溢出解决方向。
* 当前终端 Tab 主要实现在 `src/components/TerminalTabs.tsx`。
* 当前 Tab 容器已有 `overflow-x-auto`，但 `src/App.css` 中隐藏了滚动条。
* 当前实现没有显式的溢出提示、滚动控制，也没有在激活 Tab 后自动滚入可视区。
* 终端 Tab 支持拖拽排序、关闭、右键菜单、通知状态、分屏、背景图显隐等行为，改动应避免影响这些能力。
* `src/components/ui` 有 Radix Popover 封装，可复用为“更多 Tab”列表，不需要新增依赖。

## Assumptions (temporary)

* MVP 优先解决“后面的 Tab 看不到/不好访问”，不引入新的状态管理和依赖。
* Tab 仍保持单行，不采用多行布局。
* 不新增复杂的最近使用列表或搜索面板。

## Open Questions

* None.

## Requirements

* Tab 栏保持单行布局。
* Tab 标题过长继续省略，不挤压动作区。
* 当 active session 变化时，对应 Tab 自动滚入可视区域。
* 多 Tab 超出宽度时，用户可以通过横向滚动访问后面的 Tab。
* 仅当 Tab 实际溢出时，右侧显示“更多 Tab”图标入口；列表展示所有终端 Tab，点击后切换到对应终端并关闭列表。
* “更多 Tab”列表需要标识当前激活 Tab，并保留 Claude 通知状态的可见提示。
* 不改变 `createSession`、`closeSession`、`setActive`、`reorderSessions` 等会话行为。

## Acceptance Criteria (evolving)

* [ ] 创建足够多终端后，后续 Tab 可通过横向滚动访问。
* [ ] 选择隐藏区域内的终端后，该 Tab 自动进入可视区域。
* [ ] 未溢出时不显示“更多 Tab”入口；溢出后入口出现，可打开全部终端列表并切换到任意终端。
* [ ] 更多列表中当前终端和通知状态清晰可见。
* [ ] 拖拽排序、关闭终端、右键菜单仍可用。
* [ ] 新建终端后，新 Tab 可见。
* [ ] 窄窗口下动作区不被 Tab 挤出或覆盖。

## Definition of Done

* Tests added/updated where appropriate.
* Typecheck/build checks pass or known limitations are reported.
* UI interaction verified in the running app if feasible.
* No new dependency unless explicitly approved.

## Out of Scope (explicit)

* 多行 Tab。
* Tab 搜索面板。
* 最近使用顺序切换。
* 固定 Tab。
* 改造终端会话存储或恢复逻辑。

## Technical Notes

* Likely impacted files:
  * `src/components/TerminalTabs.tsx`: Tab DOM refs, active Tab auto-scroll, optional overflow controls/list.
  * `src/App.css`: Tab scroll visibility, edge fade, overflow control styling.
* Existing relevant implementation:
  * `SortableTab` renders each terminal Tab and close button.
  * `TerminalTabs` renders the scroll container, DnD context, actions, history panel and terminal well.
  * `.ui-terminal-tab-scroll` currently hides scrollbars.
* Before code edits, run GitNexus impact analysis for edited symbols as required by project instructions.
