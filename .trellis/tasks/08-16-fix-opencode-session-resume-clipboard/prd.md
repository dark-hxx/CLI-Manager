# 修复 OpenCode 会话识别、历史恢复与终端复制粘贴

## Goal

在 Windows 本地终端场景下，修复 OpenCode CLI 的三个相互关联但边界不同的问题，并保证 Claude、Codex、Grok、CC/CX 等其他 CLI 的现有行为不回归：

1. 已打开的 OpenCode CLI 标签页顶部显示的 Session ID 必须对应主会话，而不是 OpenCode 子 Agent / 子会话。
2. 历史会话中的 OpenCode 记录可以通过“继续对话”创建正确的 OpenCode 恢复终端。
3. OpenCode TUI 中，在终端选择文本后，Windows 下 Ctrl+C 复制、Ctrl+V 粘贴可以正常工作；无选中文本时 Ctrl+C 仍保持中断当前任务的语义。

## Requirements

### R1：OpenCode 主会话身份绑定

- OpenCode Hook Bridge 必须按事件类型读取规范的 `sessionID`：
  - `session.created` / `session.updated` / `session.deleted`：优先 `properties.sessionID`，兼容回退 `properties.info.id`；两者不一致时拒绝使用兼容字段覆盖规范字段。
  - `session.status` / `session.idle` / `session.error`：使用 `properties.sessionID`。
  - 父子关系优先读取 `properties.info.parentID`，兼容事件顶层 `properties.parentID`。
- OpenCode 的子会话（事件数据带 `parentID`）不得覆盖当前终端标签页已经绑定的主会话 ID。
- 对根会话创建、状态更新、空闲、错误等事件保持现有状态通知和实时统计能力。
- 处理事件乱序、子会话事件先到、主会话事件后到等生命周期边界；不得因为单个子 Agent 事件改变主标签页身份。
- 其他 Hook 来源（Claude、Codex、Grok、Pi）不改变绑定规则和状态行为。

### R2：OpenCode 历史会话恢复

- `source=opencode` 且 `session_id` 是合法的 OpenCode CLI ID（当前格式 `ses_<alphanumeric>`）时，历史工作区的“继续对话”必须生成 OpenCode 恢复命令：`opencode --session <session_id>`。
- 恢复命令必须使用 `HistorySessionSummary.session_id`，不能读取 `file_ref.path`、SQLite 虚拟 locator 或 `#session=` 拼接字符串作为命令参数。
- 恢复命令必须使用历史会话匹配到的项目/CWD；不能把 OpenCode DB 的虚拟 locator 当作 CLI session ID。
- 恢复失败时仍沿用现有错误提示和无效 ID 防护。
- 项目级 OpenCode CLI 参数如需继承，必须排除 `--continue`、`--session/-s`、`--fork` 等恢复控制参数，避免重复或覆盖目标会话。
- 不改变其他来源的恢复命令。

### R3：OpenCode TUI 专用剪贴板处理

- OpenCode TUI 的 Ctrl+C/Ctrl+V 处理放在独立的 OpenCode 专用模块中，尽量不向大型 `XTermTerminal.tsx` 增加 CLI 特例逻辑。
- 只在当前终端上下文通过结构化 `cliTool/project cli_tool` 明确识别为 OpenCode 时启用该专用处理；启动命令只作严格命令 token 兜底，标题不作为主要判定来源。
- 模块必须复用现有 `systemClipboard.ts`、`readClipboardPasteText()` 和 `wrapTerminalPasteTextForCtrlShiftV`，不得另起一套 Tauri/浏览器剪贴板实现。
- 选中文本时：Ctrl+C 写入系统剪贴板并清除选择；无选择时：Ctrl+C 继续向 PTY 发送中断。
- Ctrl+V 读取系统剪贴板并粘贴到当前 OpenCode TUI 输入框；Ctrl+Shift+V 保持现有多行粘贴语义。
- 不改变 Claude、Codex、Grok、CC/CX、Pi 等其他终端的快捷键、鼠标报告或输入转发行为。

### R4：验证与交付

- 增加针对 OpenCode 会话身份、历史恢复命令和专用剪贴板处理的自动化测试，Hook 测试必须验证生成 JS 的真实行为或可执行纯函数。
- 补充跨 CLI 回归验证，至少覆盖 Claude、Codex、Grok、CC/CX、Pi；分别验证 OpenCode 专用模块启用/未启用、Ctrl+C 无选择中断、Ctrl+V/Ctrl+Shift+V 不改变。
- 在 Windows 上记录可复核的 OpenCode 版本、Hook 安装路径、主/子会话事件、顶部 ID、恢复命令及剪贴板操作结果。
- 更新 `CHANGELOG.md` 与 `docs/功能清单.md`，版本号使用 `1.3.7`。
- 不修改用户本机数据库或 OpenCode 配置；仅修改仓库代码和测试/文档。

## Constraints

- 优先根因修复，不在 Session ID 展示层做静态兜底，也不把所有 CLI 的 Ctrl+C/Ctrl+V 逻辑改成 OpenCode 特例。
- 兼容 OpenCode 当前事件结构及历史 DB 中 `ses_...` 格式的会话 ID。
- Windows 路径契约必须在设计与测试中明确：Hook 配置目录和历史数据库目录分别依据 OpenCode 实际运行环境使用 `XDG_CONFIG_HOME`/`HOME` 或 `USERPROFILE`/平台数据目录；本次不擅自迁移用户数据，若发现现有 Hook 与 DB 目录不一致必须显式记录并保持兼容。
- 遵循项目国际化、GitNexus 影响分析、测试和交付记录规范。

## Acceptance Criteria

- [ ] OpenCode 主会话绑定稳定：子 Agent 事件不会覆盖主 Session ID；根会话事件可正确绑定。
- [ ] OpenCode 历史记录可生成 `opencode --session <id>` 并通过“继续对话”启动终端。
- [ ] OpenCode TUI 选中文本后 Windows Ctrl+C 可复制，Ctrl+V 可粘贴；无选择 Ctrl+C 仍可中断。
- [ ] 专用 OpenCode 处理不会为 Claude、Codex、Grok、CC/CX、Pi 开启。
- [ ] 自动化测试、TypeScript 检查、Rust 检查/测试按可用环境通过。
- [ ] Windows 手工验收记录包含 OpenCode 版本、启动方式、Hook 重装、主/子会话 ID、历史恢复命令、Ctrl+C/Ctrl+V/Ctrl+Shift+V 结果及其他 CLI 回归结果。
- [ ] `CHANGELOG.md` 和 `docs/功能清单.md` 已记录 `1.3.7` 变更。
