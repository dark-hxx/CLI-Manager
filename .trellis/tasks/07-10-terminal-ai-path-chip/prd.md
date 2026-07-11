# terminal-ai-path-chip

## Changelog Target

V1.2.7

## Goal

把终端输入行里的 `@path` 引用（拖入文件 / 编辑器发送 / 手打）在原位置视觉上渲染成"文件图标 + 文件名（+行号）"的圆角 chip，纯视觉覆盖，回车照常把原始 `@path` 发给 CLI。全屏 TUI（Codex）下也生效。

## Background

- xterm.js 是真实 PTY 字符网格，无法把字符替换成富元素；chip 只能作为 absolute overlay 覆盖在原字符上。
- 采用"扫屏 + rAF 合帧 + 结果 diff"路线：扫描可见行找 `@token`，按 cell 坐标叠 HTML；位置未变则不 setState，TUI 高频重绘下零抖动。
- 复用现有 `getTerminalRenderedCellSize` + cursor 像素换算（与 ghost 建议同源），图标用 `@baybreezy/file-extension-icon` 的 `getMaterialFileIcon`。

## Requirements

### 渲染（XTermTerminal.tsx）
- 正则 `@([^\s@]+)(?:\s+(L\d+(?:-L?\d+)?))?`：匹配 `@path`，吞掉空格行号后缀，使 chip 完整覆盖 `@path L2-L5`。
- label = 文件名（去 `#L..`/`:12` 后缀、取路径末段）+ 归一化行号（`L2` / `L2-L5`）。
- chip 填满底下整段路径宽度（`min-width=spanWidth`），不透明底色（终端背景色 + 面板色调）盖住裸路径，避免露黑块。
- 跨行（自动换行）token：按屏幕行拆成多段；首段显示 icon+文件名，续行段仅遮罩（`maskOnly`）。
- 门控只看 `isVisible`（失焦不消失）；`onRender`/`onCursorMove` 走 rAF 合帧；sessionId 变化清空；effect cleanup 取消 rAF。

### 注入格式
- 拖入（FileExplorerSidebar）：`@path` 末尾补空格，避免多路径粘连 `@a@b`。
- 编辑器发送（FileEditorPane）：右键"发送到终端"，`formatAiPathAnchorBlock`（`@相对路径 L2-L5`，不含选中代码文本）+ 末尾空格；右键在选区外时用 mousedown 选区快照保行号。

### 编辑器分屏（terminalStore）
- `openFileEditorPane` 新建编辑器默认左右分屏（`splitPaneEmpty` horizontal），终端左、编辑器右。

### 发送到当前终端（terminalFileDrag）
- `sendTextToTerminal(text, preferredId?)`：preferred → 最近激活终端（`setLastActiveTerminalId`，在 `setActive` 里记录真实终端）→ 唯一可见终端兜底。

### 退格删整段（XTermTerminal.tsx）
- 光标紧邻 `@token` 末尾时，退格删掉整段 `@path`（含行号）。TUI 里也强行整段删（用户确认，接受偶发删多/删少风险）——基于扫屏检测边界，不依赖 inputBuffer。

## Acceptance Criteria

- [ ] claude 拖入 / 编辑器发送 → 终端出现 icon+文件名(+行号) chip，完整盖住裸路径，无黑块、无截断。
- [ ] Codex 加载/对话时 chip 不抖动。
- [ ] 焦点切到其它终端，原终端 chip 仍在。
- [ ] 多路径连续拖入不粘连、不重叠。
- [ ] 长路径 chip 不被撑长；换行时覆盖完整。
- [ ] 编辑器选中代码右键发送带正确行号（选区外右键也对）。
- [ ] 打开文件编辑器自动左右分屏。
- [ ] 光标在 `@path` 末尾退格删掉整段。
- [ ] `npx tsc --noEmit` 通过。
- [ ] CHANGELOG.md（V1.2.7）与 docs/功能清单.md 更新。

## Notes

- 运行态 UI 验收由用户人工完成（AI 不启动应用）。
- 只识别 `@xxx`；codex 拖入的裸相对路径不带 `@`，不渲染；绝对路径不做。
- 不主动 commit，等用户明确指示。
