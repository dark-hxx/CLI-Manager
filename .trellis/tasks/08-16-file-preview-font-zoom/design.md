# 技术设计

## 数据流

```text
settingsStore.uiFontFamily/uiFontSize
  → FileEditorContent / TerminalMarkdownPreview 窄选择器
  → 字体规范化 + 当前临时字号
  → Monaco options / 两类 Markdown 预览容器样式

settingsStore.language
  → configureMonacoLocale
  → Monaco Unicode 歧义字符提示资源

Ctrl + wheel / 字号控件操作
  → 终端：现有 useTerminalDisplay 更新持久化 terminal fontSize
  → 文件 / CLI Markdown 预览：1px 步进并限制到 8px～32px
  → FontSizeControl 显示当前字号，并在最后一次操作 2 秒后隐藏
```

## 实现边界

- 终端复用 `useTerminalDisplay` 的 Ctrl+滚轮持久化逻辑；不新增第二个终端滚轮监听器。
- `FontSizeControl` 是三处使用的无状态 UI 控件，避免重复按钮、tooltip 与 aria 文案。
- 文件预览和 CLI Markdown 预览保留局部字号；终端继续使用 `settingsStore.fontSize`。
- 不新增设置项、依赖、IPC、数据库字段或持久化协议。
- 不抽取新的共享缩放状态：终端 Markdown 预览和文件预览均保留各自的局部字号状态。
- 字体缩放状态属于当前组件；通用设置仍是唯一基础字体来源。

## 发现清单

- [x] `src/components/files/FileEditorContent.tsx`：唯一编辑目标；当前 Monaco 字号硬编码为 13，Markdown 预览未显式采用基础字号。
- [x] `src/components/files/FileEditorPane.tsx`：`FileEditorContent` 的直接调用者；在应用语言切换时同步 Monaco 内置文案，不改变 props 契约。
- [x] `src/stores/settingsStore.ts`：已有 `uiFontFamily` / `uiFontSize`、11px～18px 校验和持久化；只读取，确认不编辑。
- [x] `src/lib/systemFonts.ts`：已有 `normalizeFontFamilyStack`；复用以满足持久化字体 CSS 序列化约束，确认不编辑。
- [x] `src/App.tsx`：已有全局 UI 字体 CSS 变量；Monaco 仍需显式 options，确认不编辑。
- [x] `src/components/ui/MarkdownContent.tsx`：现有 Markdown 渲染器；由外层继承字体，确认不编辑。
- [x] `src/components/terminal/TerminalMarkdownPreview.tsx`：改为以通用 UI 字体/字号为基准，并使用共享控件。
- [x] `src/components/XTermTerminal.tsx`：终端字号控件宿主；复用既有滚轮写入，不改变 PTY/渲染链路。
- [x] `src/hooks/useTerminalDisplay.ts`：已有 Ctrl+滚轮与终端字号持久化逻辑，确认不编辑。
- [x] `src/components/ui/FontSizeControl.tsx`：新增三处共享的无状态字号控件。
- [x] `src/styles/components.css`：CLI Markdown 预览字号改为继承控件状态变量。
- [x] `src/lib/i18n.ts`：补齐字号控件的 `zh-CN` 与 `en-US` 可见文案。
- [x] `src/lib/monacoSetup.ts`、`src/lib/monacoEnglishNls.ts`、`src/lib/monacoChineseNls.ts`、`src/lib/monacoTraditionalChineseNls.ts`、`src/components/files/FileEditorPane.tsx`：Monaco 内置 Unicode 提示随应用语言切换；复用安装包自带 `zh-cn` / `zh-tw` 资源，确认不修改 Unicode 高亮规则。
- [x] `src/components/git/diff/GitDiffEditorHost.tsx`：同级 Diff 分支；需求明确排除，确认不编辑。
- [x] `CHANGELOG.md`、`docs/功能清单.md`：按仓库交付规则记录 `V1.3.6`。

## GitNexus 影响分析

- 目标符号：`FileEditorContent`、`TerminalMarkdownPreview`、`XTermTerminal`、`configureMonaco`、`FileEditorPane`
- 风险：LOW
- 直接调用者：`FileEditorPane`、`XTermTerminal`、`PaneLeafView`；`configureMonaco` 有 3 个直接调用点，均为 LOW。
- 已识别受影响执行流：`FileEditorPane` 与 `XTermTerminal` 的既有 UI 流程
- 结论：改动限制在展示层；不改变 PTY、IPC、文件读取或后端数据流。

## 风险与回退

- 风险：Monaco 内部滚轮处理与 WebView 页面缩放竞争。处理方式是在文件预览根容器捕获满足条件的事件并 `preventDefault`。
- 风险：原始字体名包含空格、逗号或 CJK 字符。处理方式是先调用 `normalizeFontFamilyStack`。
- 回退：还原 `FileEditorContent` 的局部状态、滚轮处理和两处字体绑定即可；无数据迁移。
