# 修复 0.2.7 设置 UI 重构引入的主题色阶 Bug

## 背景

0.2.7 的设置页重构(bbe0000)将设置页面从手写 Tailwind 标记迁移到 Mantine 9 组件,大量按钮/徽章改用 `variant="light"` + `color="cliPrimary"`。

## 问题(根因)

`MantineThemeProvider` 用 `colorsTuple(primaryColor)` 生成主题色,10 个色阶全部是同一个颜色。Mantine 9 在浅色模式下:

- `variant="light"` 背景取色阶 1、文字取色阶 9 → 同色 → **蓝底蓝字,文字不可见**(用户截图中"终端标签切换"的 Alt + 方向键按钮);
- `variant="subtle"` hover 背景取色阶 2 → hover 时同样文字消失;
- `filled` hover 取色阶 7 → 与常态同色,无 hover 反馈。

受影响位置:ShortcutSettingsPage(标签切换按钮)、HookSettingsPage(选择目录按钮)、TemplateSettingsPage(新建模板/徽章)、ThemeSettingsPage、TerminalBackgroundSection 等所有 `variant="light"/"subtle"` + `cliPrimary` 用法。

## 修复方案

`src/components/ui/MantineThemeProvider.tsx`:

1. 移除 `colorsTuple`,新增 `buildPrimaryShades(base)`:基色放索引 6,索引 0-5 向白色按 93%~20% 混合,索引 7-9 向黑色按 12%~38% 混合,生成完整 10 级色阶;
2. 设置 `primaryShade: 6`,保证 `filled` 变体在浅色/深色模式下仍精确使用用户选择的主题色。

## 审查结论(重构回归排查)

逐文件审查 bbe0000 diff:HookSettingsPage、SyncSettingsPage、TemplateSettingsPage、ThemeSettingsPage、TerminalBackgroundSection、GeneralSettingsPage、ShortcutSettingsPage、XTermTerminal — 事件处理、disabled/loading 状态、Select/Switch/Slider/NumberInput onChange 签名转换均忠实;NumberInput 的 NaN 已由 clampFontSize 兜底;XTermTerminal 为独立的 IME 锚点修复且清理完整。除色阶问题外未发现其他功能回归。

## 第二批修复(用户追加反馈)

### 1. 终端键位按钮与"终端标签切换"统一
`ShortcutSettingsPage.tsx`:终端键位的 SegmentedControl 替换为与终端标签切换完全一致的 Button 组(active 态 light/cliPrimary,非 active default/gray,aria-pressed,!active 点击守卫),移除 SegmentedControl 导入。

### 2. 应用主题选中指示器右侧缺一块
根因:`SettingsModal` 内层 dialog 用 `animate-scale-in`(scale 0.95→1,250ms CSS animation)打开;Mantine FloatingIndicator(SegmentedControl 选中指示器)在缩放动画进行中 `getBoundingClientRect()` 测量,得到约 95% 的宽度/偏移,动画结束后无任何事件触发重测(transform 不触发 ResizeObserver,animation 不发 transitionend)→ 指示器永久偏窄、右侧露白。
修复:`SettingsModal.tsx` 内层打开动画改用 `animate-slide-down`(纯平移+透明度,平移下 target/parent rect 差值相消,测量安全);关闭动画移除内层 scale-out,仅靠外层 fade-out。CommandPalette/DiffModal/dialog.tsx 的 scale 动画不含 FloatingIndicator 组件,保持不动。

### 3. 终端设置预览卡 sticky 不跟随到页尾
根因:`TerminalBackgroundSection` 在 grid section 之外,sticky 元素只能在其 grid area(原 row-span-2)内移动,滚到背景设置区域后预览卡停在上方。
修复:`ThemeSettingsPage.tsx` 预览卡改 `xl:row-span-3`,TerminalBackgroundSection 移入 grid 左列第三行(`<div className="min-w-0 xl:col-start-1 xl:row-start-3">`)。<xl 单列 DOM 顺序不变,无窄屏回归。

#### 验收(第二批)
- trellis-check 验收 pass,`npx tsc --noEmit` 通过,diff 无无关改动;
- 待人工 UI 确认:换行快捷键按钮选中态、应用主题指示器右缘对齐、xl 宽度下滚动到底预览持续跟随、设置窗口入场动画(下滑+淡入)。

## 第三批:全项目体检后的清理与快赢(用户选定 1/3/4 项)

### 1. 死代码清理
- 删除 `ui/switch.tsx`(已迁 Mantine Switch,零引用)、`ui/icons.ts`(纯 re-export,零导入);
- npm 移除 `@radix-ui/react-switch`、`@radix-ui/react-dropdown-menu`、`@tauri-apps/plugin-shell`;
- App.css 删除 6 组零引用规则块(ui-surface-inset / ui-primary-gradient / ui-tree-root-drop / mini-btn / ui-sidebar-footer-card / ui-sidebar-sync-actions,共 57 行);保留 `.diff-gutter`(react-diff-view 运行时类)。

### 3. 设置 UX 快赢
- `SettingsLayout.tsx` 滚动容器加 `[scrollbar-gutter:stable]`,消除 tab 切换时滚动条出现/消失导致的横向抖动;
- `SettingsTopBar.tsx` 搜索框由旧 shadcn Input 换为 Mantine TextInput(size=xs,leftSection 保留搜索图标,布局类不变)。

### 4. 移除 tauri-plugin-shell
Rust 侧仅注册未使用(shell.rs 直接用 std::process::Command):删除 lib.rs 的 `.plugin(tauri_plugin_shell::init())`、Cargo.toml 依赖、capabilities 的 `shell:default`;Cargo.lock 同步清掉 5 个孤儿传递依赖。

### 验收(第三批)
- `npx tsc --noEmit` ✅、`cargo check` ✅、全仓 grep 零残留 ✅;
- 待人工确认:设置搜索框新样式(高度 32→30px、圆角 12→8px,与设置页其他输入框统一)。

## 验收(第一批)

- `npx tsc --noEmit` 通过;
- 浅色主题下"终端标签切换"选中按钮显示浅色底 + 深色字;
- 深色主题、各配色方案下 filled 按钮颜色与所选主题色一致。
