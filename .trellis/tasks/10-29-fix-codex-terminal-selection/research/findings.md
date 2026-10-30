# Codex 文本选择排查（2026-10-29）

## 证据与边界

- 用户场景：SSH 远程 Codex；macOS 非 SSH Codex；共同表现为拖选没有高亮。
- 当前环境是 Windows。使用安装版 xterm 6.1.0-beta.288、真实 Edge 鼠标事件与生产 `createTerminalMouseInteractionOptions()`，在独立夹具中复现选择策略；通过加载 xterm 前覆写 `navigator.platform` 验证 Mac 分支。这不是 macOS WebKit 或真实 Codex/SSH 的实机复现。
- 运行：`node .trellis/tasks/10-29-fix-codex-terminal-selection/research/reproduce-selection.mjs`；结果：`selection-baseline.json`，24 个生产配置基线组合 + 1 个候选配置实验，断言全部通过。
- 不启动桌面应用、不连接远程主机、不读取用户会话；夹具构建及临时配置注入不修改生产文件。

## 根因陈述

缺口位于前端 xterm 鼠标事件所有权边界：应用启用鼠标上报后，普通拖动被交给 TUI；共享配置只设置 `mouseEventsRequireAlt: false`，没有开启 macOS 必需的 `macOptionClickForcesSelection`，因此 Windows/Linux 尚可用 Shift 建立本地选区，而 macOS 连 Option 强制选择入口也没有。

这是已确认的代码缺陷和可复现机制，但尚不能断言用户现场一定已开启鼠标上报。真实 Codex 版本、鼠标模式和 macOS WebKit 仍需验收。SSH Agent 不参与该前端选择策略，因此不能将缺陷归为 SSH Agent 剪贴板协议问题。

## 基线结果

| 场景 | 结果 |
| --- | --- |
| 鼠标上报关闭，Win32/MacIntel 普通拖选 | 新建和快照恢复终端均建立选区并返回文本；没有 PTY 鼠标字节 |
| 上报开启，Win32 普通拖选 | 无选区，7 个鼠标报告 |
| 上报开启，Win32 Shift 拖选 | 有选区、文本正确，选择手势 0 个鼠标报告 |
| 上报开启，MacIntel 普通/Shift/Option 拖选 | 三种方式均无选区，均有鼠标报告 |
| MacIntel 候选实验：`macOptionClickForcesSelection: true` + Option 拖选 | 有选区、文本正确，选择手势 0 个鼠标报告 |

不把“普通缓冲区、无已有锚点时 Shift 点击的增量选择行为”混为本次缺陷：普通选择使用不带修饰键的拖动；上报开启后才验证强制选择修饰键。

## 实施时补充的短手势边界

只开启 macOptionClickForcesSelection 后，真实浏览器短 Option 点击用例在 `MacIntel/normal/x10/DEFAULT` 失败：鼠标报告虽被抑制，xterm 的 `SelectionService._handleMouseUp` 仍因默认 `altClickMovesCursor: true` 发出多次 `ESC[D`。按既有“不支持点击重定位光标”的契约，同一策略明确关闭 altClickMovesCursor；不添加 mouseup 拦截兜底。该负向用例纳入最终 109 组浏览器回归。

历史基线研究脚本仅在隔离构建中显式恢复修复前的两个默认值，因此生产修复后仍可复现 `selection-baseline.json` 的旧行为；最终回归则直接使用未替换的生产配置。

## 代码触点清单

| 触点 | 证据 / 处理 |
| --- | --- |
| `src/features/terminal/browser/TerminalMouseInteraction.ts:3` | 修复所有者；原选项类型只有 mouseEventsRequireAlt，未包含 macOS 强制选择开关；实施已补充 Option 选择并禁止短手势光标重定位 |
| `src/features/terminal/hooks/useXTermController.ts:904` | 唯一生产调用点，所有桌面 local/WSL/SSH xterm 共用，修复不得按远端 OS 或 CLI 名称推断 |
| `node_modules/@xterm/xterm/src/browser/services/SelectionService.ts:437` | Mac 分支只认 Option 且配置必须为真，非 Mac 分支认 Shift；仅阅读，不修改依赖 |
| `node_modules/@xterm/xterm/src/common/services/OptionsService.ts:42` | macOptionClickForcesSelection 默认 false；与声明和真实库实验一致 |
| `src/features/terminal/hooks/useXTermController.ts:1215` | copySelection 消费现有选区，缺陷发生在此前；保留原剪贴板通道 |
| `src/features/terminal/hooks/useXTermController.ts:1450` | macOS Cmd+C 与 Ctrl+C 中断已有分流，本任务不改变 |
| `src/features/terminal/hooks/useTerminalInput.ts:746` | 鼠标按下只清理输入编辑选区元数据，不清理 xterm 普通选区；确认不是此缺口的来源 |
| `src/features/terminal/components/XTermView.tsx:74` / `src/styles/components/terminal-background.css:170` | 完整应用遮挡仍列实机验收；无背景夹具可重现，不能将背景层当作已确认根因 |
| `src/features/terminal/lib/xTermDiagnostics.ts:66` | 独立可见性分支：搜索打开时选区颜色设为透明。可能表现为有选区但无高亮，与鼠标上报导致无法建立选区不同，实施前回归确认并记录；不直接扩大到搜索重构 |
| `src/shared/lib/terminalSnapshot.ts:10` / `src/shared/lib/terminalSnapshot.ts:29` | 新快照恢复真实上报模式；同一配置下源/恢复终端结果一致，不通过关闭模式或破坏快照绕过选择问题 |
| SSH Launch Plan / SSH Agent bridge | 选择修饰策略由本地 xterm 执行，不需改 Agent、认证、IPC 或数据协议；真实远程回归待用户环境 |
| `apps/web/src/WebTerminal.tsx:162` / `apps/web-tap/src/Terminal.tsx:134` | 各自构造 xterm，未调用桌面策略，也具有默认 Mac 选项；Web/Tap 未在本次用户反馈中确认，记录为同类风险，不默认为本次桌面交付范围 |
| `scripts/terminalMouseInteraction.test.mjs:30` | 当前仅静态断言 mouseEventsRequireAlt=false，无 Mac 行为覆盖 |
| `scripts/terminalSnapshotMouse.browser.mjs:71` | 既有真实鼠标回归只验证非 Mac Shift；需要扩展平台/选区/上报的断言 |
| `.trellis/spec/frontend/component-guidelines.md:1699` | 现有契约要求保留 TUI 普通鼠标上报，但将 Shift 错当跨平台修饰键，需同步修正 |
| `.trellis/spec/backend/terminal-osc-color-contracts.md:103` | 旧描述仍宣称 mouseEventsRequireAlt=true，与实际代码及前端契约矛盾；仅在实施后同步纠正文档，不恢复旧行为 |

## 影响分析

- GitNexus 初始索引过期，已按规则执行 `npx gitnexus analyze`。刷新成功，但 FTS 扩展不可用，query 无关键词结果；context 和 upstream impact 对目标符号均返回 not found / UNKNOWN，不能声称图谱给出了低风险。
- 按规则降级为领域契约 + 精确符号引用：策略函数有 1 个生产调用点（桌面 controller），影响所有桌面终端实例；没有 IPC、数据库、Agent 或 daemon 协议变化。
- 风险为跨平台共享交互回归，需验证正常 TUI 点击/拖动/滚轮仍上报；不能为修复制定全局 mouseEventsRequireAlt=true，后者会使既有 Grok 等 TUI 控件失效。
- 索引工具生成的 AGENTS.md / CLAUDE.md 规则块改写已撤回，仅保留本任务文件与用户原有删除。

## 待用户决定

已由用户“修复 mac os 的缺陷”确认：采用标准终端约定，Windows/Linux 在鼠标上报模式按 Shift 拖选，macOS 开启 Option 拖选，普通鼠标事件仍交给 TUI。不采用无修饰键选择优先策略。
