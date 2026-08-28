# 终端 Markdown 预览独立主题

## 背景与目标

终端右侧的预览类面板（小眼睛 Markdown 预览、子代理转录、终端内 Git diff）配色目前全部跟随终端主题，用户无法单独指定。目标：在 **设置 → 终端** 增加「预览主题」配置，复用现有终端主题库预设；默认跟随终端，选择独立主题后覆盖终端右侧所有预览类面板。

## 范围

In scope：

- 新设置项：预览主题（跟随终端 / 终端主题库任一预设）。
- 设置 → 终端 新增「预览主题」区块，与「终端主题库」**共用抽取出的预设网格组件**。
- 受影响面板：`TerminalMarkdownPreview`、`SubagentTranscriptView`、`SessionReplayPanel`、`GitDiffViewer`（`useTerminalTheme=true` 时）。
- 面板内代码块高亮明暗（oneLight/oneDark）跟随预览主题。
- 设置持久化（tauri-plugin-store）+ WebDAV 同步归类。

Out of scope：

- xterm 终端本体、终端 Tab、状态/统计类面板（TerminalStatsPanel、SystemResourcesPanel、ProviderQuickSwitchPanel、AgentCapabilitiesCard、TerminalPanelHeader）、Statusline 预览、历史会话页。
- 新增主题预设、主题编辑器、按会话/按项目粒度的预览主题。

## 需求

- **R1 设置项**：新增 `terminalPreviewThemeName: string`，默认 `follow-terminal`；其他合法取值为 `TERMINAL_THEME_PRESETS` 的 `id`。
- **R2 设置 UI**：设置 → 终端 新增可折叠区块「预览主题」。分段控件切换「跟随终端 / 独立主题」；独立时展示预设网格（浅色/深色分组 + 搜索 + 预设卡片 + 「当前」徽标）。
- **R3 共享组件**：从 `ThemeSettingsPage` 抽出 `TerminalThemePresetGrid`，终端主题库与预览主题两处共用。抽取后终端主题库现有行为必须不变：system/auto 模式只展示解析后的那一个预设并标为当前、分组标题与描述、搜索过滤、卡片视觉与选中态。
- **R4 生效范围**：跟随终端时表现与改动前完全一致；独立时预览面板局部作用域内的 `--term-panel-*` / `--terminal-theme-*` 变量改用预览主题，代码块明暗随预览主题。切换设置即时生效，无需重开面板或重启。
- **R5 容错**：未知、失效或被重命名的预设 id 回退为跟随终端，不抛错、不写脏值。
- **R6 同步**：该键归入 `preferences`（与 `terminalThemeName` 一致）；同步回灌非法值时按 R5 回退。
- **R7 i18n**：中英文都要有，沿用 `ThemeSettingsPage` 现有 `text("中文", "English")` 双语写法。

## 验收标准

- [ ] 默认（跟随终端）下，浅色与深色终端主题的三类面板外观与改动前一致。
- [ ] 设置独立预览主题后：Markdown 预览、子代理转录、终端内 Git diff 的面板底色/文字/边框/滚动条/代码块明暗都切到预览主题，切换即时生效。
- [ ] 终端本体、终端 Tab、统计/供应商/资源等状态面板、Statusline 预览不受影响。
- [ ] 分屏多面板同时打开表现一致；重启应用后设置保留。
- [ ] 预设 id 被清空或改名（模拟脏值/同步回灌）时回退到跟随终端。
- [ ] `npx tsc --noEmit` 通过；新增 `scripts/terminalPreviewTheme.test.mjs` 与既有终端相关 node 测试全绿。
- [ ] `CHANGELOG.md` 与 `docs/功能清单.md` 已更新（版本号未指定则记入 `TEMP`）。

## 开放问题

- 已确认：`SessionReplayPanel` 渲染会话内容（`SessionTranscriptContent`）、chrome 走 `TERM_PANEL` 全局变量，属于预览类面板，纳入 R4。它当前用 `variant="history"`，代码块跟随**应用**主题而非终端主题（既有不一致）；本任务把它的代码块也切到预览主题，但必须显式固定 `linkBehavior="preview"`，不能因为改 `variant` 顺带把链接行为从「预览」变成「直接打开」。
- 无其他待决问题。
