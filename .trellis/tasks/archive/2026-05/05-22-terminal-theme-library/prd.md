# 扩充终端主题库

## Goal

扩充 CLI-Manager 内置终端配色，让用户在“设置 > 主题 > 独立主题库”中有更多高质量终端主题可选，同时保持现有“跟随应用 / 独立设置”的行为不变。

## What I already know

* 用户反馈：终端的配色不够多。
* 已做互联网调研：Gogh、iTerm2-Color-Schemes、Tinted Terminal、Dracula、Catppuccin、TokyoNight 等项目都围绕标准终端主题结构组织，即 background / foreground / cursor / selection / 16 ANSI colors。
* 当前项目已有内置终端主题库，集中在 `src/lib/terminalThemes.ts`。
* 当前已有 17 个终端主题预设，`TERMINAL_THEME_PRESETS` 定义在 `src/lib/terminalThemes.ts:413-431`。
* 设置页的独立终端主题列表自动读取 `TERMINAL_THEME_PRESETS`，筛选逻辑在 `src/components/settings/pages/ThemeSettingsPage.tsx:27-31`，渲染逻辑在 `src/components/settings/pages/ThemeSettingsPage.tsx:102-131`。
* `XTermTerminal` 会在主题、字体、浅/深应用配色变化时热更新 xterm theme，见 `src/components/XTermTerminal.tsx:64-75`。
* 终端创建时通过 `getTerminalTheme(...)` 设置初始 theme，见 `src/components/XTermTerminal.tsx:104-113`。
* `settingsStore` 已有 `terminalThemeMode` / `terminalThemeName` 持久化，独立模式切换逻辑在 `src/stores/settingsStore.ts:223-239`。

## Requirements

* 扩充内置终端主题库，优先增加成熟、用户熟悉、辨识度高的主题。
* 每个新增主题必须包含完整 xterm.js `ITheme` 需要的关键字段：`background`、`foreground`、`cursor`、`selectionBackground`、16 个 ANSI 色。
* 新增主题应自动出现在现有“独立主题库”中，不新增额外设置入口。
* 保留现有 `auto` / “跟随应用”行为，不改变当前应用主题和终端主题联动规则。
* 保留现有主题 ID，避免已有用户设置失效。
* 新增主题命名应清晰，便于搜索。
* 默认不引入外部依赖，不运行时联网拉取主题。

## Acceptance Criteria

* [ ] “独立主题库”中新增一批精选终端主题。
* [ ] 新增主题可通过现有搜索框按名称搜索。
* [ ] 选择新增主题后，当前终端能热更新配色。
* [ ] 新建终端会话使用当前选择的新增主题。
* [ ] “跟随应用”模式仍按现有浅/深应用配色自动选择主题。
* [ ] 现有主题 ID 和已有设置迁移逻辑不被破坏。
* [ ] TypeScript 类型检查通过。
* [ ] 至少手动验证一个新增深色主题和一个新增浅色主题。

## Definition of Done

* Tests added/updated where appropriate.
* Typecheck passes.
* UI manually verified in settings page and terminal instance.
* No new dependency unless explicitly approved.
* Rollback considered: 删除新增主题常量和 preset 条目即可回退。

## Technical Approach

采用最小改动方案：只扩展 `src/lib/terminalThemes.ts` 中的内置 `ITheme` 常量和 `TERMINAL_THEME_PRESETS` 数组；复用现有 `ThemeSettingsPage` 的搜索、主题卡片、预览和选择逻辑。设置存储、终端渲染、主题热更新逻辑不改。

建议新增主题控制在 12~16 个，避免主题库膨胀成难以浏览的列表。优先覆盖深色主流主题，同时补少量浅色主题。

建议新增清单：

* Catppuccin Mocha
* Catppuccin Macchiato
* Catppuccin Latte
* Gruvbox Dark
* Gruvbox Light
* Everforest Dark
* Everforest Light
* Rosé Pine
* Rosé Pine Moon
* Rosé Pine Dawn
* Kanagawa Wave
* Ayu Dark
* Ayu Light
* Night Owl
* Material Palenight
* One Light

## Decision (ADR-lite)

**Context**: 用户需要更多终端配色；当前项目已有独立主题库和完整选择 UI，缺的是主题数量与覆盖面。  
**Decision**: 本任务只扩充内置精选主题，不做主题导入器、远程主题库或完整主题编辑器。  
**Consequences**: 改动小、风险低、可快速交付；后续如果主题数量继续增长，再考虑分类、标签、收藏或导入功能。

## Out of Scope

* 不新增主题导入/导出功能。
* 不接入远程主题仓库。
* 不新增运行时联网下载主题。
* 不做完整主题编辑器。
* 不重构设置页信息架构。
* 不改变当前应用浅/深配色预设。
* 不改变默认终端主题选择规则。

## Technical Notes

### Files likely impacted

* `src/lib/terminalThemes.ts`：新增主题常量，并加入 `TERMINAL_THEME_PRESETS`。

### Files inspected

* `src/lib/terminalThemes.ts`
* `src/components/settings/pages/ThemeSettingsPage.tsx`
* `src/components/XTermTerminal.tsx`
* `src/stores/settingsStore.ts`
* `src/components/settings/pages/GeneralSettingsPage.tsx`

### Research Notes

#### What similar tools do

* Gogh 提供结构化主题数据，字段覆盖 background、foreground、cursor、16 个 ANSI 色，适合程序化转换。
* iTerm2-Color-Schemes 收集 450+ 主题，但数量很大，直接全量内置会降低设置页可用性。
* Tinted Terminal 以 Base16/Base24 组织主题，适合做规范化主题来源。
* Dracula、Catppuccin、TokyoNight 等流行主题都有明确色板和终端适配，适合优先内置。

#### Constraints from our repo/project

* 当前主题列表是纯前端静态数组，新增主题不需要后端改动。
* `ThemeSettingsPage` 已自动消费 `TERMINAL_THEME_PRESETS`，只扩数组即可显示新增主题。
* `settingsStore` 使用字符串 `terminalThemeName` 保存 ID，必须保证既有 ID 不改名。
* 主题对象需要兼容 xterm.js `ITheme`，字段应保持当前命名风格。

#### Feasible approaches here

**Approach A: 精选内置主题扩充（推荐）**

* How it works: 在 `terminalThemes.ts` 新增 12~16 个主题常量并注册到 `TERMINAL_THEME_PRESETS`。
* Pros: 最小改动、离线可用、无依赖、现有 UI 自动生效。
* Cons: 后续再加很多主题时，列表会越来越长。

**Approach B: 全量导入大型主题库**

* How it works: 批量导入 Gogh / iTerm2-Color-Schemes 的大量主题。
* Pros: 主题数量最多。
* Cons: 列表噪音大、维护成本高、可能需要额外转换脚本和来源治理。

**Approach C: 主题导入器**

* How it works: 允许用户导入 JSON / Windows Terminal / iTerm 主题。
* Pros: 扩展性最好。
* Cons: 需要设计格式校验、错误提示、持久化、导入冲突处理，超出当前“配色不够多”的最小修复范围。
