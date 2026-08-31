# 修复 Grok Build 本地/WSL 换行

## Goal

Grok Build composer 在本地 PowerShell、WSL 与 SSH 上都能用宿主换行快捷键和原生 Alt+Enter 插入换行，而不会把消息提交出去。Refs #236。

## Root-Cause Statement

根因在宿主终端按键编码层：换行快捷键只给 Codex 写 `\x1b\r`，Grok 一律写 `\n`。Linux SSH 上 `\n` 碰巧能当换行，Windows ConPTY / 本地 Grok 把 `\n` 当提交。未匹配的 Alt+Enter 还被 `managedCombo` 吞掉，Grok 原生键到不了进程。修复落在按键决策与会话识别，不改 PTY、不按环境分流。

## State-Dependency

失败依赖：运行环境（本地 pwsh / WSL / SSH）、CLI 类型（Grok / Codex / Kimi / 普通 Shell）、当前换行快捷键设置。必须按场景矩阵覆盖，而不是只修「默认 Shift+Enter + 本地 Grok」。

## Requirements

* Codex 与 Grok 的 composer 换行序列为 `\x1b\r`；Kimi Code 与普通 Shell 保持 `\n`。
* Grok/Codex 上：匹配到的宿主换行快捷键写 `\x1b\r`；未匹配的 Alt+Enter 放行给 xterm（原生 `\x1b\r`）；未匹配的 Shift/Ctrl+Enter 仍吞掉（漏出去是裸 `\r`，等于提交）。
* 普通 Shell / Kimi：未匹配的 Alt/Shift/Ctrl+Enter 仍吞掉；匹配时写 `\n`。
* 识别 Grok 使用与 Codex 同级的会话上下文（cliTool / cli_tool / 标题 / 启动命令，含 `grokbuild`、`grok.exe`、`wsl grok`），并可用 viewport 签名补上「pwsh 里手动打 grok」。
* 本地、WSL、SSH 走同一决策函数，不写 `if (ssh)` / `if (windows)`。
* 不把 Kimi 加入 `\x1b\r` 特例。

## Acceptance Criteria

- [ ] 默认 Shift+Enter：Grok 写 `\x1b\r`，不再写 `\n`；Alt+Enter 不吞，交给 xterm。
- [ ] 快捷键设为 Alt+Enter：Grok 写 `\x1b\r` 且不双重发送。
- [ ] 快捷键设为 Ctrl+Enter：Grok 写 `\x1b\r`；未匹配的 Shift+Enter 仍吞掉。
- [ ] Codex 行为与现网一致（匹配快捷键写 `\x1b\r`）。
- [ ] Kimi 与普通 Shell 仍写 `\n`；未匹配 Alt+Enter 仍吞掉。
- [ ] `isGrokTerminalContext` 覆盖 grok / grokbuild / grok.exe / wsl grok，不误伤 kimi。
- [ ] 相关 Node 测试与 `npx tsc --noEmit` 通过。
- [ ] `CHANGELOG.md`（TEMP）与 `docs/功能清单.md` 更新对应终端输入板块。

## Definition of Done

* Tests added for newline decision and Grok recognition
* Frontend typecheck green
* Product change records updated
* Unrelated dirty files not included

## Out of Scope

* 不改 ConPTY / SSH 传输。
* 不为 Kimi、Claude、Pi、OpenCode 增加 `\x1b\r`。
* 不改十字光标 / `mouseEventsRequireAlt`。
* 不关闭 GitHub issue（commit 用 `Refs #236`）。

## Technical Notes

* 触点：`src/terminal/browser/TerminalCliContext.ts`、`src/terminal/browser/TerminalNewlineShortcut.ts`（新建）、`src/lib/terminalTuiDisplay.ts`、`src/components/XTermTerminal.tsx`、`scripts/terminalComposerNewline.test.mjs`（新建）、`scripts/terminalNewlineShortcut.test.mjs`。
* 无关：OSC 52、鼠标策略、Kimi hook/history。
