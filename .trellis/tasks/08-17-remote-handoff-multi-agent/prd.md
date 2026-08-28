# 桌面宠物远程托管多 Agent 适配

## Goal

在不修改 cc-connect 源码和全局安装的前提下，把现有仅支持 Codex 的桌面宠物远程托管扩展到本地 Claude Code、Pi 和 OpenCode。托管必须保持原 CLI Session、项目/Worktree、工作目录、平台与可用 Provider 语义，取消后能在 CLI-Manager 中恢复同一会话。

## Confirmed scope

- 支持：本地 Codex、Claude Code、Pi、OpenCode。
- Codex 保持现有本地与 SSH 托管行为。
- Claude Code、Pi、OpenCode 首版仅支持本地项目和本地 Worktree。
- Grok Build 明确不做；普通终端不得误识别为 Agent。
- WSL 继续不支持远程托管；SSH Claude/Pi/OpenCode 留作后续独立阶段。
- Telegram、飞书、微信、企业微信继续复用 cc-connect 已有平台链路。

## Product decisions

- 项目登记的 `cli_tool` 是 Agent 类型的主要来源，启动命令仅作为兼容补充；二者明确冲突时失败关闭，不猜测。
- Codex 与 Claude 使用 CLI-Manager 已登记的 Native Provider；Pi 与 OpenCode 首版跟随各自本地配置，不能伪装成 CLI-Manager Provider。
- Pi 必须使用 cc-connect RPC 模式，以保留权限和问题卡片转发能力。
- OpenCode 按 cc-connect 实际能力运行；审批能力不等同于 Codex/Claude 时，桌宠候选和托管确认必须显示本地化限制说明。
- 仍保持全局同时只允许一个托管会话，托管期间本地会话锁定。

## Requirements

### R1 - Agent 识别与资格判断

- 建立共享托管 Agent 类型：`claude | codex | pi | opencode`，前后端字段和值一致。
- 复用 `resolveAgentRuntimeKind()` 的识别规则，移除远程托管私有的 Codex 正则分支。
- 仅登记为受支持 Agent 且能获得合法 `cliSessionId` 的 PTY 会话进入候选。
- Grok、普通 Shell、伪会话、无项目、无路径、运行中、状态未知等继续以稳定原因拒绝。
- 本地 Worktree 必须仍存在且属于原项目；SSH Worktree 和 WSL 保持拒绝。

### R2 - cc-connect 项目配置

- Rust `CcConnectAgent` 增加 Pi 与 OpenCode，并按 cc-connect 契约生成：
  - Claude：`type = "claudecode"`；
  - Codex：`type = "codex"`，保留 app-server backend；
  - Pi：`type = "pi"` 且 `rpc = true`；
  - OpenCode：`type = "opencode"`。
- 安全模式和 YOLO 模式必须按各 Agent 支持的值映射，不能复用 Codex 常量。
- 项目清单必须明确解析 `cli_tool`，不能再把所有非 Codex 项目归为 Claude。
- 未识别/Grok 项目可继续显示在 CLI-Manager，但不得被 cc-connect 托管链路选中。

### R3 - 会话连续性与取消恢复

- 托管请求、状态和持久化记录保存 Agent 类型；cc-connect Session 注入的 `agent_type` 必须动态生成。
- 托管必须绑定原 `cliSessionId`，不能静默创建或切换到另一个会话。
- 取消托管时按 Agent 构造恢复命令：
  - Codex：`codex resume --no-alt-screen <id>`；
  - Claude：`claude --resume <id>`；
  - Pi：`pi --session <id>`；
  - OpenCode：`opencode --session <id>`。
- 恢复继续使用原项目、Worktree、目录、Shell 和 Agent；失败时保留锁定与可重试状态，不打开空白新会话。
- 旧版无 Agent 字段的活动托管记录按 Codex 读取，升级后可正常取消。

### R4 - Provider 与配置隔离

- Codex 沿用现有登记 Provider、app-server proxy 和密钥隔离链路。
- Claude 本地托管必须复用 `provider::scope` 生成的项目/Worktree Provider 快照，通过受管启动边界向 cc-connect 的 Claude 子进程注入 `--settings`，并正确持有/释放快照。
- Claude 跟随全局时使用真实 Claude Home 的已应用配置；项目覆盖不得退回本机其他全局 Provider。
- Pi/OpenCode 的 Provider 文案明确为“跟随 Pi 配置”/“跟随 OpenCode 配置”，不读取或注入 Claude/Codex Provider 密钥。
- Provider 密钥不得出现在 WebView、命令文本、普通日志、托管记录或 cc-connect 配置中。

### R5 - 预检、启动与回滚

- 预检先验证平台、凭据、会话、项目、目录、Agent 可执行文件和 Agent 专属配置，再关闭原 PTY。
- Codex 继续执行 app-server 预检；Claude/Pi/OpenCode 只做无副作用的可执行文件/配置检查，不加载或恢复目标会话。
- 任一准备、Session 注入、配置写入或 cc-connect 启动失败，必须回滚 cc-connect Session 文档、Provider 快照和托管记录，原本地会话所有权不变。
- 启动/取消/恢复的进程继续使用隐藏窗口，不能弹出残留终端窗口。

### R6 - Hook、审批与跨平台通知

- Hook 事件按托管记录中的 Agent 匹配 `claude/codex/pi/opencode`，不得再写死 `source == codex`。
- 运行、权限、进度、完成、失败和取消通知仍只发送到本次托管选中的平台会话。
- Hook 未安装时不得伪造精确状态；资格判断继续失败关闭或显示可操作原因。
- Pi RPC 的权限/问题卡片通过 cc-connect 原生能力处理；OpenCode 的能力限制必须有明确提示，不能宣称完整审批等价。
- 窗口焦点、最小化、托盘、分屏和多 Workspan 不改变后端托管所有权与通知归属。

### R7 - UX、兼容和可观测性

- 桌宠菜单继续沿用“远程托管 -> 选择平台 -> 选择会话”，候选卡显示 Agent、项目、目录、Provider/配置来源和能力限制。
- 托管蒙层和状态卡显示 Agent 类型；打开已托管会话仍提示先取消托管。
- 错误码从 `codex_only` 泛化为可本地化的 unsupported-agent、agent-mismatch、agent-unavailable、capability-limited 等原因。
- 新增/修改文案同时覆盖 zh-CN 与 en-US，并兼容 zh-TW 回退。
- 日志仅记录 Agent、会话安全标识、阶段与稳定错误码，不记录凭据和消息正文。

## Scenario matrix

| 维度 | 首版行为 |
| --- | --- |
| Agent | Codex/Claude/Pi/OpenCode 可托管；Grok/普通终端拒绝 |
| 环境 | 本地项目/本地 Worktree支持；WSL拒绝；SSH仅 Codex |
| 状态 | done/failed/exited/error 可托管；running/attention/unknown拒绝 |
| Session ID | 合法且与 Agent 一致时绑定；缺失、空白或漂移拒绝 |
| Provider | Codex/Claude锁定登记 Provider；Pi/OpenCode跟随本地配置 |
| Hook | 已安装时状态/通知匹配 Agent；缺失时不伪造完成或权限状态 |
| 权限模式 | 默认模式保留审批；YOLO按 Agent 映射；OpenCode显示能力限制 |
| UI 生命周期 | 主窗聚焦/失焦、最小化、托盘、桌宠独立窗口行为一致 |
| 会话拓扑 | 单/多会话、分屏、跨 Workspan 仍仅一个活动托管 |
| 失败阶段 | 预检、写配置、启动、取消、恢复失败均有确定回滚/锁定状态 |
| 平台 | Telegram/飞书/微信/企业微信只向选中的会话单播 |
| 升级 | schema v1 无 Agent 记录按 Codex兼容，schema v2 持久化 Agent |

## Acceptance criteria

- [ ] 桌宠能列出已停止且身份完整的本地 Claude、Pi、OpenCode 会话，Codex 候选不回归。
- [ ] 各 Agent 托管后，消息继续进入原 `cliSessionId`，目录、项目和 Worktree 不变。
- [ ] Claude 托管使用登记 Provider；Pi/OpenCode 不错误继承 Codex/Claude Provider。
- [ ] Pi 生成 `rpc = true`；OpenCode 显示审批能力限制。
- [ ] 取消托管后按对应 Agent 命令恢复原会话，失败不创建空白会话。
- [ ] Hook 运行/权限/完成/失败通知仅匹配当前托管 Agent 与平台。
- [ ] 旧 Codex 托管记录仍可读取、显示和取消。
- [ ] Grok、普通终端、WSL 和非 Codex SSH 会话保持不可托管。
- [ ] `node scripts/remoteHandoff.test.mjs`、`npx tsc --noEmit`、相关 Rust 单测和 `cargo check` 通过。
- [ ] `CHANGELOG.md` 与 `docs/功能清单.md` 同步更新，新文案覆盖 zh-CN/en-US。
- [ ] 仅构建 NSIS 安装包，跳过 MSI 与更新签名，并复用现有 Cargo/npm 缓存。

## Out of scope

- Grok Build 远程托管。
- SSH Claude/Pi/OpenCode 和 WSL 远程托管。
- 修改 cc-connect 源码、平台协议或全局安装。
- 为 Pi/OpenCode 新增 CLI-Manager Native Provider 域。
- 绕过 OpenCode/平台自身不具备的审批能力。

## Changelog target

- 用户未指定正式版本时使用 `TEMP`。
