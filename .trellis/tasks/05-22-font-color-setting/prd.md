# 设置字体颜色

## Goal

在设置中增加“字体颜色”配置，让用户可以自定义应用界面的主文字颜色，同时保留当前主题默认颜色作为默认值/恢复选项。

## What I already know

* 用户先询问“整个系统的字体颜色”，当前系统默认字体色来自 `src/App.css` 的 `--text-primary`。
* `body` 使用 `color: var(--text-primary)`，语义色 `--on-surface` 也通过 `--text-primary` 派生。
* 设置已通过 `src/stores/settingsStore.ts` 持久化到 `settings.json`，新增设置字段可复用现有 `update()` 流程。
* 应用字体族已在 `src/components/settings/pages/GeneralSettingsPage.tsx` 的“外观”区域配置，字体颜色入口也适合放在同一区域。
* `src/App.tsx` 已有通过 effect 写入根节点 CSS 变量的模式，用于覆盖 UI 字体族。
* 终端文字颜色目前由 `src/lib/terminalThemes.ts` 的 xterm theme `foreground` 控制，不等同于应用 UI 字体颜色。

## Assumptions (temporary)

* “字体颜色”优先指应用界面主字体颜色，不包括内置终端的 ANSI/主题文字色。
* 默认值应为空/跟随主题，而不是复制当前主题色到用户配置中，避免切换主题后被旧颜色锁死。
* 颜色设置只覆盖主文字色 `--text-primary`，次级文字、弱化文字、强调色仍跟随当前主题，避免破坏整体层级。

## Open Questions

* 暂无

## Requirements (evolving)

* 在设置页“外观”区域新增应用字体颜色配置入口。
* 字体颜色仅影响应用界面主文字，不影响内置终端文字。
* 支持选择/输入颜色并立即预览。
* 支持恢复为“跟随主题默认颜色”。
* 设置需要持久化。
* 不改动现有主题预设结构，避免把每套主题都变成可编辑主题。

## Acceptance Criteria (evolving)

* [ ] 设置页可以配置应用主字体颜色。
* [ ] 修改后主界面与设置弹窗中的主文字立即生效。
* [ ] 切换/重启后配置仍保留。
* [ ] 可以恢复为主题默认字体颜色。
* [ ] 未配置自定义颜色时，现有主题配色表现不变。

## Definition of Done (team quality bar)

* Tests added/updated where appropriate
* Typecheck passes
* UI manually verified in settings page
* Rollback considered: 清空自定义颜色即可回到主题默认

## Technical Approach

推荐采用“单一全局覆盖变量”方案：在 `settingsStore` 新增 `uiTextColor`，默认空字符串表示跟随主题；在 `App` 中当 `uiTextColor` 存在时写入 `document.documentElement.style.setProperty("--text-primary", uiTextColor)`，为空时移除该 inline override；在 `GeneralSettingsPage` 外观区域增加颜色输入、文本输入和恢复按钮。

## Decision (ADR-lite)

**Context**: 当前应用主题通过 CSS 变量集中控制字体颜色，设置存储已有持久化能力。
**Decision**: 采用 Approach A，仅新增应用界面主字体颜色设置；内置终端文字继续由终端主题控制。
**Consequences**: 改动集中在设置存储、App 根变量覆盖和通用设置页；不会影响 xterm 主题体系。

## Out of Scope (explicit)

* 不新增完整主题编辑器。
* 不允许逐项配置 secondary/muted/accent 等所有颜色。
* 不重构现有主题预设。
* 不改变终端主题库或内置终端文字颜色。

## Technical Notes

* 已查看：`src/App.css`、`src/App.tsx`、`src/stores/settingsStore.ts`、`src/components/settings/pages/GeneralSettingsPage.tsx`、`src/components/settings/pages/ThemeSettingsPage.tsx`、`src/lib/terminalThemes.ts`、`src/components/SettingsModal.tsx`。
* `src/App.css:475-478`：`body` 使用 `color: var(--text-primary)`。
* `src/App.css:307`：`--on-surface: var(--text-primary)`，所以覆盖 `--text-primary` 会影响多数主文字。
* `src/components/settings/pages/GeneralSettingsPage.tsx:319-335` 已有“应用字体”设置，适合就近加入“应用字体颜色”。
* `src/App.tsx:111-143` 已有 UI 字体族覆盖 effect，可按同类方式新增颜色变量覆盖。
* `src/lib/terminalThemes.ts:469-479` 返回 xterm 主题，若要终端字体颜色也可配，需要额外合成 `foreground/cursor`。

## Research Notes

### Feasible approaches here

**Approach A: 仅应用界面主字体颜色（推荐）**

* How it works: 新增 `uiTextColor`，覆盖 `--text-primary`，空值恢复主题默认。
* Pros: 改动集中、可预期、和用户刚才询问的“系统字体颜色”一致。
* Cons: 不影响内置终端文字。

**Approach B: 仅终端字体颜色**

* How it works: 新增 `terminalTextColor`，合成 xterm theme 的 `foreground/cursor`。
* Pros: 对终端可读性控制更直接。
* Cons: 用户界面字体颜色不变；还要处理终端主题预览和独立主题逻辑。

**Approach C: 应用界面 + 终端分别设置**

* How it works: 同时新增 `uiTextColor` 和 `terminalTextColor`。
* Pros: 最完整。
* Cons: 设置项变多，改动面更大，当前需求可能过度。
