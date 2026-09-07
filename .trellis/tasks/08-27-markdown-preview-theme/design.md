# Design — 终端 Markdown 预览独立主题

## 现状（只读梳理结论）

| 面板 | 主题来源 | 派生内容 |
|---|---|---|
| `TerminalMarkdownPreview` | `XTermTerminal` 传入 `terminalTheme: ITheme` prop | 局部 `buildTerminalMarkdownPreviewStyle()` 写一整套 `--term-panel-*` / `--terminal-theme-*`；`isLightTerminalTheme()` 决定代码块明暗 |
| `SubagentTranscriptView` | 自己从 settingsStore 取 4 个键 → `getTerminalTheme()` | 只派生代码块明暗；面板配色靠 `TERM.*` 读**全局** CSS 变量 |
| `GitDiffViewer` | 同上 | `useTerminalTheme` 为真时用终端明暗，否则用应用明暗 |
| `SessionReplayPanel` | chrome 走 `TERM_PANEL` 全局变量 | 用 `SessionTranscriptContent`（`variant="history"`），代码块跟的是**应用**主题——既有不一致 |
| 全局 `--term-panel-*` | `App.tsx` 的 effect 按终端主题写到 `document.documentElement` | 终端右侧所有面板共用 |

关键点：`termStatsUi.tsx` 的 `TERM.*` 全是 `var(--term-panel-*, fallback)` 字符串，**不是解析后的色值**。因此在预览面板根节点上局部覆盖这些变量，即可让整棵子树换肤，无需改动任何子组件的取色代码——`TerminalMarkdownPreview` 现在已经是这个做法，把它推广即可。

## 方案

### 1. 数据层

- `Settings` 增 `terminalPreviewThemeName: string`，`DEFAULTS` 为 `FOLLOW_TERMINAL_PREVIEW_THEME = "follow-terminal"`。
- `settingsStore.load()` 复用现有 targeted 校验块写法：`migrateTerminalPreviewThemeName(value)` — 非字符串、非 `follow-terminal`、且不在 `themePresetMap` 内 → 回落默认并 `persistSetting` 洗回干净值（对齐 `terminalThemeName` 的既有处理）。
- 写入走现有泛型 `update("terminalPreviewThemeName", value)`，无需新 action。
- `src/lib/syncSettings.ts` 加 `terminalPreviewThemeName: "preferences"`。

### 2. 解析层（新增 `src/lib/terminalPreviewTheme.ts`）

```ts
export const FOLLOW_TERMINAL_PREVIEW_THEME = "follow-terminal";

export interface TerminalPreviewThemeResolution {
  theme: ITheme;
  tone: "light" | "dark";
  isIndependent: boolean;
}

export function resolveTerminalPreviewTheme(input: {
  previewThemeName: string;
  terminalThemeName: string;
  resolvedTheme: "dark" | "light";
  lightThemePalette: LightTerminalPalette;
  darkThemePalette: DarkTerminalPalette;
}): TerminalPreviewThemeResolution;
```

- `previewThemeName === follow-terminal` 或不是已知预设 → 用 `getTerminalTheme(terminalThemeName, ...)`，`isIndependent: false`。
- 否则用 `getTerminalTheme(previewThemeName, ...)`，`isIndependent: true`。
- `tone` 一律走 `isLightTerminalTheme(theme)`，明暗判定只有这一处。
- 面板样式构造从 `TerminalMarkdownPreview` 挪进本模块，改名 `buildTerminalPreviewPanelStyle(theme)`，两处以上共用；`TerminalMarkdownPreview` 内的局部实现删除。

### 3. 消费层（新增 `src/hooks/useTerminalPreviewTheme.ts`）

`useTerminalPreviewTheme()` 用 5 个 settings selector + `useMemo` 返回 `{ theme, tone, isIndependent, panelStyle }`。所有在范围内的面板改用它：

- `TerminalMarkdownPreview`：删掉 `terminalTheme` prop（同步改 `XTermTerminal` 调用点），改用 hook 的 `panelStyle` 与 `tone`。
- `SubagentTranscriptView`：删掉 4 个 settings selector 与本地 `getTerminalTheme` 计算，改用 hook；**根节点补上 `style={panelStyle}`**，否则独立主题下面板 chrome 仍吃全局变量。
- `GitDiffViewer`：`useTerminalTheme ? previewTone : resolvedTheme`。
- `SessionReplayPanel`：根节点补 `panelStyle`；transcript 改为 `variant="terminal"` + `terminalCodeTheme={tone}`，并给 `SessionTranscriptContent` 增加可选 `linkBehavior` 透传到 `MarkdownContent`，在此显式传 `"preview"`——`MarkdownContent` 里 `linkBehavior` 默认是从 `variant` 推的（`terminal` → `open`），不锁住会顺带改掉链接行为。

`App.tsx` 写全局 `--term-panel-*` 的逻辑**不动**——它是终端侧 chrome 的基线，预览面板靠局部作用域覆盖。

### 4. 设置 UI

- 新增 `src/components/settings/pages/TerminalThemePresetGrid.tsx`：纯展示组件，props `{ groups: Array<{ id: TerminalThemeGroupId; presets: TerminalThemePreset[] }>, isSelected(preset), onSelect(preset), currentBadgeLabel, emptyHint? }`，内部只保留分组标题 + `SimpleGrid` + 预设卡片（含选中态、徽标、色板与示例文本）。
- `ThemeSettingsPage`「终端主题库」区块改为调用该组件；**分组/搜索/tone 过滤与 auto 特例仍留在页面里**（`groupedThemes`、`selectedResolvedThemeId` 等逻辑不动），把这些结果作为 props 传入，保证行为等价。
- 新增「预览主题」可折叠区块（放在「终端主题库」之后、终端背景之前），含：分段控件（跟随终端 / 独立主题）、独立时的 tone 分段 + 搜索框 + 同一个 `TerminalThemePresetGrid`，以及一小段说明文案「影响 Markdown 预览、子代理转录与终端内 Git diff」。
- 折叠态沿用现有 `terminalSettingsSectionsExpanded` 机制，新增一个 section key。

## 兼容与回归边界

- 默认值 `follow-terminal` 保证升级用户零变化；旧版本读到未知键会忽略（tauri-plugin-store 是 KV，不会报错）。
- 终端主题为 `auto`/system 时，跟随模式跟着系统明暗变；独立模式固定在所选预设——这是预期语义，写进 PRD 验收。
- 终端背景图/透明模式只作用于 xterm 层，预览面板始终不透明，行为不变。
- 分屏、多会话：设置是全局键，所有面板一致；无 per-session 状态。
- 明暗判定收敛到 `resolveTerminalPreviewTheme` 一处，避免再出现第四个 `isLightTerminalTheme` 调用点各判一套。

## 备选方案与取舍

- **只做 Markdown 预览**：改动最小，但用户明确要求覆盖终端右侧所有预览类面板，且会留下 diff/转录与预览不同色的割裂感 → 不采纳。
- **不抽共享网格，预览主题用紧凑下拉**：代码量最小，但两处主题选择视觉不一致，后续易走偏 → 用户已选「抽成共享组件」，采纳共享网格。
- **在 App.tsx 全局变量上直接切预览主题**：会连带影响状态类面板，越界 → 不采纳，坚持面板局部作用域。
