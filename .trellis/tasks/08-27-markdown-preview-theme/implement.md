# Implement — 终端 Markdown 预览独立主题

## 执行顺序

### 步骤 1 · 数据层与解析层（可独立验证）

1. `src/lib/terminalPreviewTheme.ts`：新增 `FOLLOW_TERMINAL_PREVIEW_THEME`、`resolveTerminalPreviewTheme()`、`buildTerminalPreviewPanelStyle()`（后者从 `TerminalMarkdownPreview.buildTerminalMarkdownPreviewStyle` 原样搬运，保持输出的 CSS 变量集合完全一致）。
2. `src/lib/terminalThemes.ts`：若 `themePresetMap` 未导出判定能力，补一个 `isKnownTerminalThemePreset(id)` 导出（只读查询，不改现有解析函数签名）。
3. `src/stores/settingsStore.ts`：`Settings` 加键、`DEFAULTS` 加默认值、`load()` 加 `migrateTerminalPreviewThemeName` 校验块（对齐 `terminalThemeName` 的 `persistSetting` 洗值写法）。
4. `src/lib/syncSettings.ts`：加 `terminalPreviewThemeName: "preferences"`。
5. 验证：`npx tsc --noEmit`。

### 步骤 2 · 消费层接线

6. `src/hooks/useTerminalPreviewTheme.ts`：新增 hook，返回 `{ theme, tone, isIndependent, panelStyle }`。
7. `TerminalMarkdownPreview.tsx`：删除本地 style builder 与 `terminalTheme` prop，改用 hook；`XTermTerminal.tsx` 调用点同步去掉 `terminalTheme={terminalTheme}`（注意 `terminalTheme` 变量在 XTermTerminal 内仍被 xterm 自身使用，不要误删）。
8. `SubagentTranscriptView.tsx`：删除 4 个 settings selector 与本地 `getTerminalTheme` 计算，改用 hook；根节点补 `style={panelStyle}`（与现有 `backgroundColor: TERM.bg` 内联样式合并，避免二者打架）。
9. `GitDiffViewer.tsx`：`viewerThemeTone = useTerminalTheme ? previewTone : resolvedTheme`，删掉本地终端主题计算。
10. `SessionReplayPanel.tsx`：根节点补 `panelStyle`；两处 `SessionTranscriptContent` 改传 `variant="terminal"` + `terminalCodeTheme={tone}` + `linkBehavior="preview"`；`SessionTranscriptContent.tsx` 与 `MarkdownContent` 增加可选 `linkBehavior` 透传（默认值保持现状，不改任何现有调用点行为）。
11. 验证：`npx tsc --noEmit`。

### 步骤 3 · 设置 UI 与共享网格

12. 新增 `src/components/settings/pages/TerminalThemePresetGrid.tsx`（纯展示，props 见 design.md）。
13. `ThemeSettingsPage.tsx`「终端主题库」区块改为调用共享组件，**保留** `groupedThemes` / `selectedResolvedThemeId` / auto 特例 / 搜索与 tone 分段逻辑。
14. `ThemeSettingsPage.tsx` 新增「预览主题」折叠区块：模式分段控件 + 独立时的 tone 分段 + 搜索 + 共享网格 + 说明文案；新增 section 展开态 key。
15. 双语文案沿用页面内 `text()` 写法；如需新 i18n key 则同步 `src/lib/i18n.ts` 的中英两份。
16. 验证：`npx tsc --noEmit`。

### 步骤 4 · 测试与文档

17. 新增 `scripts/terminalPreviewTheme.test.mjs`（沿用 `ts.transpileModule` + stub 的既有写法）：
    - `follow-terminal` → 与直接解析终端主题等价、`isIndependent: false`；
    - 独立预设 → 主题与 tone 取预设、`isIndependent: true`；
    - 未知/空/被改名 id → 回退跟随终端；
    - `buildTerminalPreviewPanelStyle` 输出包含 `--term-panel-bg` / `--terminal-theme-foreground` 等关键变量；
    - 静态断言：范围内面板文件都 import `useTerminalPreviewTheme`，且不再各自调用 `isLightTerminalTheme`；`SessionReplayPanel` 的 transcript 调用点显式带 `linkBehavior="preview"`。
18. 更新 `.trellis/spec/frontend/component-guidelines.md`：新增约定「终端右侧预览面板的主题走 `useTerminalPreviewTheme` + 面板局部 CSS 变量作用域，禁止再各自 `getTerminalTheme` + `isLightTerminalTheme`」。
19. 更新 `CHANGELOG.md`（`TEMP` 段）与 `docs/功能清单.md`（`[TEMP]` 段）。
20. 全量验证：`npx tsc --noEmit`；`node --test scripts/terminalPreviewTheme.test.mjs scripts/terminalMarkdownPreview.test.mjs scripts/gitDiffThemeWorkflow.test.mjs scripts/historyConversationView.test.mjs scripts/terminalReplay.test.mjs`。

## 验证命令

```bash
npx tsc --noEmit
node --test scripts/terminalPreviewTheme.test.mjs scripts/terminalMarkdownPreview.test.mjs scripts/gitDiffThemeWorkflow.test.mjs scripts/terminalReplay.test.mjs
```

## 人工验证矩阵

| 维度 | 取值 |
|---|---|
| 预览主题模式 | 跟随终端（默认）/ 独立浅色 / 独立深色 |
| 终端主题 | 浅色预设 / 深色预设 / auto(system) |
| 面板 | Markdown 预览（小眼睛）/ 子代理转录 / 会话回放 / 终端内 Git diff |
| 布局 | 单终端 / 左右分屏两个预览同时开 |
| 生命周期 | 面板已打开时改设置（应即时生效）/ 重启应用后保留 |
| 脏值 | 手动把 store 里的键改成不存在的预设 → 回退跟随终端 |

## Review Gate

- 步骤 1、2、3 各自完成后跑一次 `tsc`；步骤 2 完成即可先人工确认「跟随终端」零回归，再做 UI。
- 若步骤 13 的抽取导致终端主题库任何视觉/选中行为变化 → 立即回退该步，改为「新区块单独渲染网格、终端主题库不动」并在报告中说明取舍。

## Rollback Points

- 步骤 3 有问题：只回退 `ThemeSettingsPage.tsx` 与 `TerminalThemePresetGrid.tsx`，数据层与面板接线可保留（此时设置项无入口，但默认值等价于旧行为）。
- 步骤 2 有问题：回退面板与 hook，保留步骤 1（未被消费，无行为变化）。
- 整体回退：`git checkout -- <上述文件>`，无数据库迁移、无 IPC 契约变更，无需清理用户数据。
