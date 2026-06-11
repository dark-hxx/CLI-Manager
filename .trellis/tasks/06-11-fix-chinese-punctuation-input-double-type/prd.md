# 修复中文符号输入需两次

## Goal

修复内置终端在中文输入法下输入中文符号时需要输入两次才进入终端的问题；英文符号输入保持现有正常行为。

## What I already know

* 用户反馈：中文输入法下输入中文符号需要输入两次才能输入进去。
* 用户反馈：英文符号输入正常。
* 项目是 Tauri 2 + React 19 + xterm.js 的 Windows 桌面应用，终端交互主要在前端 xterm 组件与后端 PTY 写入链路。

## Assumptions (temporary)

* 问题大概率发生在前端终端输入事件处理、IME composition 事件处理、或 xterm key/input 转发逻辑。
* 目标是修复中文标点/符号提交，不改变普通英文键盘输入、不新增依赖。

## Open Questions

* 已收敛：本任务按用户描述优先修复中文输入法下中文符号/标点一次输入；同时不破坏中文文字 composition、英文符号、粘贴和快捷键。

## Requirements (evolving)

* 中文输入法下的中文符号应一次输入即进入终端。
* 英文符号输入行为不能回退。
* 不新增重量级依赖。

## Acceptance Criteria (evolving)

* [ ] 使用中文输入法输入常见中文符号（如 `，`、`。`、`！`、`？`）时，一次按键/提交即可写入终端。
* [ ] 英文符号（如 `,`、`.`、`!`、`?`）输入仍保持正常。
* [ ] 不破坏终端普通键盘输入、粘贴、快捷键等现有流程。

## Definition of Done (team quality bar)

* Tests added/updated where appropriate
* Typecheck / focused validation green where practical
* Docs/notes updated if behavior changes
* Rollout/rollback considered if risky

## Out of Scope (explicit)

* 不重构终端架构。
* 不更换 xterm.js 或终端后端实现。
* 不新增输入法相关第三方库。

## Technical Notes

* 已检查：`src/components/XTermTerminal.tsx` 的 xterm 初始化、`terminal.onData`、自定义快捷键、paste、helper textarea composition anchor 逻辑。
* 已检查 xterm 6.0.0 `CompositionHelper`：IME 激活时的非组合字符（数字/标点）会走 keyCode 229 分支，并在 `setTimeout(0)` 后通过 helper textarea diff 触发 data event；xterm 自身在 composition 定位时也保证 textarea 至少 `1x1`。
* 最小修复：非 composition 状态继续把 `.xterm-helper-textarea` 固定到离屏，避免 TUI 光标 redraw 抖动；但将尺寸从 `0x0` 改为 `1x1`，避免中文输入法符号第一次输入被浏览器/IME 丢弃。
* 影响面：`XTermTerminal` 仅由 `TerminalTabs` 渲染；修改不触碰 PTY 后端、不改 `onData` 数据转发、不改 paste/Enter 快捷键。
* GitNexus MCP/CLI 当前不可用（无 MCP resources，`gitnexus_impact`/`gitnexus_detect_changes` 命令不存在）；已降级为 grep/LSP 可用性检查，LSP 当前也无 TSX server。
