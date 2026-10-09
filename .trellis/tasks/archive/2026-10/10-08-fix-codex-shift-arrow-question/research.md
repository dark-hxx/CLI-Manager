# 2026-10-08 只读定位

## 状态

- 当前工作区 `F:/github/cli-m/CLI-Manager`，`master` / `origin/master` 均为 `ff4dd3c3`，初始工作区干净。
- 无 `.codegraph`，按规则跳过。GitNexus 索引已通过 `npx gitnexus analyze` 刷新，但 FTS 扩展缺失，query 无结果，context 无法解析 `useXTermController`、`isCodexSession`、`isCodexTerminalContext`、`forwardTerminalInput`；不能把空结果解释为无影响。暂用契约和定向源码检索，尚未修改任何业务符号。
- analyze 生成的 AGENTS.md / CLAUDE.md 变化已撤回，只保留本任务文件。
- 用户同意建任务并指定 V1.4.2，尚未完成规划评审 / task start。

## 发现清单

| 触点 | 证据与结论 |
| --- | --- |
| 桌面按键回调 | `src/features/terminal/hooks/useXTermController.ts:1276` 已在 Codex 判定后 clear selection / return true，shell 走原选区分支。 |
| Codex 识别 | 同文件 `:489` 汇合稳定元数据、会话级 latch 和 `hasCodexTuiViewport`；`:541` 从输出签名更新 latch。 |
| 元数据识别 | `src/features/terminal/browser/TerminalCliContext.ts:54` 检查 projectTool/sessionTool/titleTool/startupCmd。 |
| 视口识别 | `src/features/terminal/lib/terminalTuiDisplay.ts:60` 只扫描可见行，匹配 `openai codex` / `/model to change`。 |
| 输入转发 | `src/features/terminal/hooks/useTerminalInput.ts:791` 经 IME 去重及选区处理后原样 write；`:822` 订阅 onData。IME 去重明确不抑制以 ESC 开头的控制序列。 |
| xterm 编码 | `node_modules/@xterm/xterm/src/common/input/Keyboard.ts:119` 将 Shift+Left 编为 ESC `[1;2D`。CoreBrowserTerminal 在 custom handler 返回 true 后仍经过 compositionHelper 和 KeyboardService。 |
| 协议选项 | xterm 6.1.0-beta.288 支持可选 kitty/win32InputMode，默认 false；桌面和 Web 创建选项均未开启。尚未证明这是此次故障原因，不预先扩大协议改动。 |
| Windows PTY | `src-tauri/src/infrastructure/pty/platform/windows.rs:379` 保留 `PSEUDOCONSOLE_RESIZE_QUIRK | PSEUDOCONSOLE_WIN32_INPUT_MODE`。未改。 |
| 全局快捷键 | `src/features/workspace/api/useKeyboardShortcuts.ts:65` 为 capture handler，精确匹配设置中的组合键；默认上一标签为 Alt+Left，未发现默认 Shift+Left 冲突。 |
| Web | `apps/web/src/WebTerminal.tsx:175` 仅拦剪贴板组合键，其他按键返回 true；未发现对应应用层选区冲突。 |
| 历史修复 | `.trellis/tasks/09-23-desktop-file-codex-input-reliability/verification.md:3` 记录 2026-09-30 修复提交 `1fbfaf08`，旧测试只覆盖真实 callback 返回值，未覆盖 xterm/ConPTY。 |

## 已执行检查

`node --test scripts/codexQueuedQuestionShortcut.test.mjs scripts/terminalNewlineShortcut.test.mjs scripts/codexManualInput.test.mjs`：29/29 通过。

未启动 CLI-Manager、Tauri 或服务。`.trellis/spec/frontend/quality-guidelines.md:248` 要求真实桌面/UI 由人工验证；独立无服务测试夹具可参考现有浏览器回归测试。

## 运行来源

- 安装版：`F:/soft/CLI-Manager/cli-manager.exe`，ProductVersion 1.4.1，LastWriteTime 2026-09-24 16:52:36，早于 9 月 30 日修复。主窗进程 12932；其 daemon 20128。
- 开发版：`F:/github/CLI-Manager/src-tauri/target/debug/cli-manager.exe`，ProductVersion 1.4.2，LastWriteTime 2026-10-08 10:15:17。主窗进程 34752；其 daemon 35040。该 checkout HEAD `f2e532f6`、分支 `pr-273-local`，也有同样的 Shift+Left/Right 让行逻辑，另有 ZCode 支持任务的 dirty files。
- 本机 `codex --version` 为 `codex-cli 0.161.0`。
- 不停止、安装覆盖、修改上述运行程序或其他 checkout。
- 用户后续确认所有当前版本均有问题，因此旧安装版只能解释部分情况；继续验证 xterm 编码、ConPTY 转换及 Codex 运行时按键接收。

## 补充实验与收敛

1. 将真实 `attachCustomKeyEventHandler` 回调接到独立、无服务的 Edge/xterm 页面，配置 Codex 判定成功：按 Shift+Left，默认协议发出且仅发出 `ESC [1;2D`；启用 Win32 的对照组发出包含 Shift 状态的按下/抬起记录。未启动 CLI-Manager。
2. 用临时 Python ctypes 子进程打开 CONIN$，在与应用一致的 `CreatePseudoConsole` flags=6 下读取真实 INPUT_RECORD。系统 ConPTY 和仓库 `src-tauri/resources/conpty/x64/conpty.dll` 均把 `ESC [1;2D` 转为 VK_LEFT=37、scan=75、mods=272（SHIFT=16 | ENHANCED=256）；右箭头对应 VK=39。原生 Win32 输入序列同样保留修饰位。临时测试进程均终止，测试目录清理。
3. 只读检查当前任务所属安装版会话：cliTool=codex、startupCmd 包含 codex、本地环境；没有证据支持本会话被元数据识别成其他 CLI。设置文件读取当时没有发现 Shift+Arrow 绑定；文件不能代替各运行实例当前的内存设置。不能据此断言用户当前每个窗口的设置值。
4. 用户指出 Tab 切换 Shift 预设。抽取并运行 `useKeyboardShortcuts` 的实际全局 handler、eventToCombo 和 isShortcutMatch，在 xterm textarea 目标上设置 Shift+ArrowLeft/Right：一个会话触发 preventDefault；两个会话触发 preventDefault、getNextSessionIdForShortcut(-1/+1)、setActive。该配置下的全局冲突已确定。
5. 结论：修复全局捕获入口的终端 Shift 方向键所有权。只有存在相应绑定时才触发此条冲突；不能把“设置页提供选项”本身说成触发原因，也不把 preventDefault 说成 stopPropagation。

### GitNexus 补充

同名仓库存在多个注册路径；对本任务使用 `F:\github\cli-m\CLI-Manager`。命名符号 context/impact 仍未解析；文件 UID `File:src/features/workspace/api/useKeyboardShortcuts.ts` 的上游分析成功，报告 CRITICAL、4 个直接导入者、59 条关联流程、20 个模块。4 个导入者是 App、useXTermController、useFileEditorShortcuts、ShortcutSettingsPage；后三者使用共享 eventToCombo。已在编辑业务代码前向用户报告 CRITICAL 风险，设计保持公共函数语义不变。

规划产物已收敛。下一步是用户评审终端内保留 Shift 箭头、终端外保留原绑定的规则；尚未 start 或编辑业务代码。
