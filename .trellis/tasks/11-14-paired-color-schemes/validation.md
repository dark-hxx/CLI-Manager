# 实现与验收记录

日期：2026-11-14；记录版本：TEMP。

## 实现

- 六套通用界面配色与终端完整 ANSI 预设：Code 深空 / 晴昼、Nord 极夜 / 雪原、Rosé 松月 / 晨曦。
- 通用设置配色卡、默认文字/背景对比度映射、Mantine 主色与新色板自动文字对比度。
- 终端自动跟随、独立选择及终端预览共用主题解析；新名称与搜索支持中英文。
- 明暗预设追加到现有终端库尾部，保留原始默认选择和按色调选择第一个主题的行为。
- `appearanceSettings.ts` 集中外观类型、终端面板外观类型和设置导航 ID；`settingsStore.ts` 显式重导出既有公共类型，持久化键与迁移行为不变。设置文件从原有 2063 行降至 1993 行。
- 静态预览从实际主题源码生成，可直接打开 `docs/design/paired-color-schemes.html`；重新生成命令：`node scripts/colorSchemePreview.mjs`。
- CHANGELOG 与功能清单第 16.1 / 16.2 节已同步。

## 发现清单与影响范围

| 触点 | 结果 |
| --- | --- |
| `GeneralSettingsPage.tsx` | 已更新选择项及四组文字/背景映射 |
| `themes.css` | 已添加独立选择器，补齐语义层次、交互及主按钮前景 |
| `MantineThemeProvider.tsx` | 已补齐主色映射，新色板开启 autoContrast；实际控件渲染测试通过 |
| `settingsStore.ts` / `appearanceSettings.ts` | 已扩展类型并提取外观契约，原 API 入口、默认值与迁移逻辑兼容 |
| `terminalThemes.ts` | 已添加预设、翻译键及自动模式映射 |
| `TerminalThemePresetGrid.tsx` / `ThemeSettingsPage.tsx` | 已支持翻译名称、原英文名与当前语言名称搜索；语言切换更新 memo |
| `terminalPreviewTheme.ts` | 已确认共用解析，跟随/独立/文字覆盖/明暗判断测试通过 |
| App / xterm / 标签栏 / 工作区背景 / 状态栏预览 | 已确认消费既有主题入口，无需修改生命周期；热切换待桌面验收 |
| 中英文设置字典 | 已添加所有新名称和说明 |
| WSL / SSH / Worktree / Hook / Rust / 数据库 | 已确认无进程、IPC、安装或存储结构变更 |

图谱记录：

- 主题模块文件 impact：MEDIUM，13 个直接导入文件；Mantine provider 文件：LOW，2 个直接导入文件。
- 全局配色与设置类型 impact：CRITICAL（全局 Settings 状态带来大量间接流程）；已在编辑前告知。
- 部分 React/解析函数返回 UNKNOWN，不作为无影响结论；已通过文件图谱、直接引用与领域契约补查。
- 索引落后 3 个提交且 FTS 不可用，刷新失败。最近提交涉及统计页与终端信息栏，已检查相关主题消费入口。
- `detect_changes(scope: all)` 返回 8 个索引符号、12 个已跟踪变更文件，风险 critical；工作区原有 Cargo.lock 改动也在该范围内。新文件尚未进入旧索引，图谱不代表完整验证。

## 已执行验证

- `npx tsc --noEmit`：通过。
- `npm run build`：通过；Vite 提示现有大 chunk 体积警告。
- 41 项测试通过：colorSchemes、terminalPreviewTheme、defaultThemeSettings、settingsDialog、settingsFocus、settingsPresentation、extensionsSettingsLayout、extensionsMcpSaving、nativeProviderCatalogSelection、workspaceBackgroundLayout。
- 新增测试检查六套配色的自动匹配、独立选择、预览跟随与覆盖、背景图最低对比度，以及实际 Mantine 控件主色/文字和主题卡中英文。
- 六套终端正文对比度均超过 7:1；正文/弱化文字在各层背景，以及主要 ANSI 色、选区与主按钮达到 4.5:1。
- 浏览器静态预览：1440px 中文六套完整展示，390px 英文无整页横向溢出，Dark 筛选显示 3 套；时间示例保持 14:32。该检查不等于 Tauri 桌面验收。
- `git diff --check`：通过。
- `npm run check:architecture -- --strict`：未通过，剩余两处为本次未改动文件中的既有问题：
  - `src/features/stats/api/StatsPanel.tsx`：2020 行，超过 2000 行上限。
  - `src/features/settings/components/pages/TerminalStatusBarSettingsPage.tsx`：跨功能直接导入 `terminal/lib/terminalStatusBarItems`。
- 本次修改/新增的手写源文件符合长度与分层约束；未新增架构豁免。

## 待人工桌面验收

遵守 `.trellis/spec/frontend/quality-guidelines.md`，未启动应用服务或 Tauri：

1. 设置 → 通用：逐一选择六套配色；中英文切换后检查名称、说明和 24 小时时制。
2. 终端：自动跟随、独立配色、预览独立配色分别切换；检查现有多终端/分屏更新与重启后保存。
3. 自定义文字、终端背景图和工作区背景图开启时检查可读性；恢复预设后颜色正确。
4. 展开/折叠侧栏、紧凑窗口、失焦/最小化后恢复，检查层次、菜单、输入框、选中态和键盘焦点。

分支仍为 master；任务开始时与本地 origin/master 记录同步（0/0）。原有 `src-tauri/helpers/Cargo.lock` 改动未由本任务编辑。未提交或执行远程同步。

## 后续调整：终端主题卡片固定宽度

- 用户截图指出不同主题分组卡片宽度不一致。原因是共享网格使用 `auto-fit` 与 `1fr`，每个分组独立分配剩余宽度，主题少的分组会把卡片拉宽。
- 为 `TerminalThemePresetGrid` 增加终端专用网格样式，固定 240px 列宽、左对齐自动换行；容器不足 240px 时只收缩到容器宽度。终端主题库与预览主题库共用组件，通用界面配色网格不受影响。
- 图谱文件 impact 为 LOW，直接宿主是 `ThemeSettingsPage.tsx`；函数符号 UNKNOWN，已通过源码确认两处主题库调用。
- `npx tsc --noEmit`、7 项配色及设置渲染测试、`git diff --check` 通过。
- 严格架构检查仍为上文两处既有问题；本次没有新增违规。
- 待桌面确认：大窗口各分组卡片等宽、搜索少量结果不拉伸，缩窄窗口按固定列宽换行。

## 续作完成：扩大终端外观预览

- 根因：设置页的两个独立小示例无法呈现实际输出层次，且字体示例混用了应用背景与终端文字色，浅色应用搭配深色终端时出现浅底浅字；修复落在设置页预览组件及布局层。
- 将示例统一为 `TerminalAppearancePreview.tsx`，背景、正文、ANSI 色、选区与光标取自当前终端主题；沿用文字覆盖、字体和字号。展示提示符、分级日志、Diff、选区、中英文、粗体与完整 16 色。
- 内容区宽度达到 1160px 时使用 480px 吸顶侧栏；不足时在终端主题库上方整行展示。输出区高 420–620px，长行与大字号在内部滚动。
- 发现清单：`ThemeSettingsPage.tsx` 两处预览共用同一组件；`terminal-appearance-preview.css` 经 `components.css` 有序导入；中英文设置字典补齐 10 项文案；主题与设置解析继续复用既有入口。实际 xterm 生命周期、PTY、IPC、持久化协议均确认无须修改。
- GitNexus 文件 impact：LOW，直接调用入口为 `SettingsModal.tsx`，两层共 5 个文件；函数与新增组件返回 UNKNOWN，已通过源码引用确认使用点。索引仍落后 3 个提交，沿用上文已记录的刷新失败限制；文件节点不提供完整执行流程判定。
- `npx tsc --noEmit`、`npm run build`、`git diff --check` 通过。构建保留既有大 chunk 和混合动态/静态导入提示。
- 15 项定向测试通过（`colorSchemes`、`terminalPreviewTheme`、`settingsPresentation`），新增实际组件渲染验证覆盖六套明暗配色、中英文、主题背景/正文/选区、16 色、键盘可聚焦的滚动区，以及 24px 字号和自定义文字色。
- Chrome 静态验收使用实际 React 组件和 CSS（仅语言状态替身，未启动应用）：宽屏侧栏实际 480px；窄布局隐藏侧栏并展示内联预览；342px 内容容器下预览保持在容器内，24px 英文长行只在输出区滚动，无整页横向溢出。浅色主题正文与背景正确配套，翻译键无泄漏。
- 严格架构检查仍只有前文记录的 `StatsPanel.tsx` 超长与 `TerminalStatusBarSettingsPage.tsx` 跨功能导入两处既有问题，本次预览无新增违规。
- 待人工桌面确认：真实设置页切换语言、主题、字体与字号，确认热更新；宽窄窗口布局与滚动体验。静态组件检查不等于 Tauri 桌面验收。
