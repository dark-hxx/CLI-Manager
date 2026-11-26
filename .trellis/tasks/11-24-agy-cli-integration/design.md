# 技术路线：一份原生会话身份，两条数据通道

启动走现有 PTY，不嵌入 SDK，不把交互会话换成 `agy -p`。运行态经 Hook 送达 Tab；持久化历史和统计走历史索引。两条通道以**运行环境 + 来源 antigravity + 原生 conversationId**核对；Tab ID 解决事件应落到哪个终端。cwd 帮助校验项目，不用作唯一身份。

## 已核对的外部契约（2026-11-24）

| 主题 | 可采用 | 不承诺 |
|---|---|---|
| 启动/恢复 | [官方入门](https://antigravity.google/docs/getting-started?tab=cli)、[恢复命令](https://antigravity.google/docs/cli/commands/resume/)：项目 cwd 启动 `agy`；按 ID 用 `agy --conversation <id>`，本机 1.3.5 帮助亦支持。 | `-c/--continue` 只指目录最近一条；`/resume` 是选择器。[1.5.16 新增的 -r/--resume 别名](https://github.com/google-antigravity/antigravity-cli/blob/bb5c8da497ef2eb2e2b98e6a092baed90c567938/CHANGELOG.md#L7-L9) 不能作为旧版基线。 |
| Hook | [CLI Hooks](https://antigravity.google/docs/hooks/?tab=cli#managing-hooks-in-antigravity-cli)：支持用户级 `~/.gemini/config/hooks.json`、项目 `.agents/hooks.json` 或插件；stdin camelCase，包括 `conversationId`、`workspacePaths`、`transcriptPath`、`modelName`。入口可在 `/hooks` 检查。 | 不是 Gemini CLI 的 settings 内嵌 hooks；全局配置可被 App 共用。1.3.5 不假设有新版 `hookEventName`、`cwd`、`toolCall.id`。不可将 absent 字段合成为身份。 |
| 历史 | 官方 Hook 给出 CLI transcript 目录形状及绝对路径；以已授权 CLI 根校验后消费，文件可能晚于事件出现。 | 历史会话存储、最后会话缓存和 transcript 不是同一种数据；不把 GUI 导入、SDK、ACP 或未经证实的原始格式当成离线 transcript 导出协议。 |
| 用量 | [状态栏](https://antigravity.google/docs/cli/statusline/)公开交互状态 `context_window.total_input_tokens/total_output_tokens` 等；[headless](https://antigravity.google/docs/cli/headless/)可输出 `usage`。 | 二者都不是已保存交互日志的字段契约。配额、上下文百分比、状态栏估算费用不是离线账单；不为补统计改写用户的 statusLine；用户主动配置的显示功能见 R6。 |

## 五个接点

1. **命令与恢复（R1、R3）。** [CLI 描述表](../../../src/shared/lib/cliTools.ts#L38-L173)有 Antigravity 历史图标但没有 agy 启动项；[项目命令组装](../../../src/features/projects/api/projectStartupCommand.ts#L194-L217)现有优先级保持不变。识别可执行命令而非参数正文中出现的“agy”；覆盖 `agy.exe`、带参数和含空格路径。历史入口 [buildHistoryResumeCommand](../../../src/features/history/api/historyResumeCommand.ts#L147-L176) 与 [终端恢复](../../../src/features/terminal/lib/terminalLaunch.ts#L124-L179)共用精确恢复语义：校验原生 UUID，保留明确兼容的普通参数，排除已有选择会话/启动一次性提示等冲突参数，无 ID 不退到“最近”。明确区分用户自己输入的 `agy -c`。
2. **Hook 安装、适配、绑定（R2）。** [本地 Hook 契约](../../spec/backend/cli-hook-contracts.md#L7-L41)涵盖安装器、隐藏 `__hook`、服务端来源×事件白名单、前端类型、运行环境和 Tab 绑定，不能只改设置页。[共享归一化](../../../src-tauri/hook-schema/src/lib.rs#L222-L236)已有 `transcriptPath`，但不取 `conversationId`；为 agy 单独映射，而不改变旧源 ID 优先级。沿用已有本机桥鉴权、幂等和环境隔离。全局配置仅管理唯一标记条目；同名非本应用配置报冲突，保留用户配置。只在本应用目标 PTY 且有有效回调上下文时上报；外部终端/App 不投递。按事件返回合法的不干预响应，不审批、不改工具参数、不延长会话。仅传必要身份和状态，不记录原始 prompt、工具参数或完整 Hook stdin。
3. **历史发现与读取（R3）。** [Rust 来源](../../../src-tauri/src/features/history/sources.rs#L227-L237)和[前端描述符](../../../src/shared/lib/historySources.ts#L221-L232)已存在；[根选择](../../../src-tauri/src/features/history/roots.rs#L290-L302)优先 CLI 的 `brain`，不存在才回退旧 `antigravity` 根，不同时全扫。保留旧记录可读，但未证明来自 CLI 的旧记录不能只凭 UUID 允许恢复。核对[目录 ID 与工作区映射](../../../src-tauri/src/features/history/source_metadata.rs#L55-L110)、[原生解析器](../../../src-tauri/src/features/history/transcript_parsers.rs#L73-L145)：当前仅对 DONE 的指定角色/记录型提取消息，统计命名工具调用，没有用量解析。沿用现有 FTS、详情、原始行号、收藏与仅删除所选 transcript 的边界。解析改变时通过现有[索引版本机制](../../../src-tauri/src/features/history/catalog.rs#L1172-L1185)重建衍生数据，不修改原始日志。
4. **两种统计界面（R4）。** [会话侧栏](../../../src/features/terminal/components/TerminalStatsPanel.tsx#L493-L539)以 Tab 绑定的原生 ID 精确查历史详情，[历史分析契约](../../spec/backend/history-stats-contracts.md#L7-L18)则从索引聚合，不要求 Hook。让启动识别、面板打开条件、当前会话查询、来源能力表一致。无可靠数据时区分“未绑定”“等待记录”“此记录未提供”，停止只因 0 而触发的[快速轮询](../../../src/features/terminal/components/TerminalStatsPanel.tsx#L562-L626)。同一日志增量只算一次；部分会话无用量时展示已知小计及覆盖提示，不能把缺失变成免费，也不能将一次用量分配给没有证据的模型或日期。

5. **工具内状态栏设置（R6）。** 在现有「设置 → 状态栏」与 Claude、Codex 并列增加 Antigravity CLI，复用[编辑器的工具隔离、方案与预览契约](../../spec/frontend/statusline-editor-contracts.md#L16-L29)。协议更接近 Claude（命令经 stdin 接收 JSON、stdout 输出多行 ANSI），不是 Codex 的原生字段列表；独立适配 agy 字段，预览和实际输出共用渲染逻辑，不执行外部命令作预览。首批可选项为模型、工作目录、运行状态、上下文占用和输入/输出 Token，缺字段不补零。

   [官方自定义指南](https://antigravity.google/docs/cli/statusline/)规定在目标环境的 `~/.gemini/antigravity-cli/settings.json` 写 `statusLine` 对象（`type: command`、`command`、`enabled`、`padding`、`stack_with_default`）。区分原生默认、CLI-Manager 自定义、与原生叠加；停用自定义不等于删除原命令。[官方命令](https://antigravity.google/docs/cli/commands/statusline/)亦支持用户自行修改，因此应用或撤销前应重读当前值。首次只读；遇已有外部命令须明确确认，保留应用前的原始块（含原本不存在的情况），仅在当前块仍为本应用管理的版本时恢复。保留无关设置与未知字段。状态栏只渲染，不持久化载荷或写入统计，不要求 Hook。

## Hook 到 UI 的最小映射

| agy 原始事件 | CLI-Manager 行为 | 边界 |
|---|---|---|
| `SessionStart` | 建立 Tab ↔ conversationId；检验 transcript 线索。 | 新建时触发，恢复时是否重发须实测；有明确 Tab 的后续事件可补绑定，旧事件不能抢回已切换的会话。 |
| `PreInvocation` | 幂等标记当前会话工作中。 | 每次模型调用均可触发；不冒充新用户消息、不重复发通知。 |
| `Stop` | 有错误/明确失败原因映射失败；正常且 `fullyIdle=true` 才标记整个会话已空闲。 | `fullyIdle=false` 仍有后台工作；字段缺失或未知原因降级，不把一次循环停止当作进程退出。区分后台失败与全局状态。 |
| 工具前后、`PostInvocation` | 第一版无需为了基础状态全部启用；仅在有已验收的观测用途时加。 | 工具调用不等于权限请求，模型返回不等于任务成功。无原生对应的审批/通知事件不模拟。 |

## 运行环境边界（R5）

- **Windows：** PowerShell/pwsh/CMD、可执行文件带空格、已有项目/自定义命令和权限提示均要验证。官方 [changelog 中 1.5.8](https://github.com/google-antigravity/antigravity-cli/blob/bb5c8da497ef2eb2e2b98e6a092baed90c567938/CHANGELOG.md#L188)有双引号 Hook 命令修复；先用本机 1.3.5 验证路径及回调。某能力若需要较新版本，单独标版本要求，不以能启动充当 Hook 已通。
- **macOS：** 在用户实际 shell / GUI PATH 中定位 agy，正确引用 app bundle 内 helper 路径和用户 home；不执行 Windows 脚本。覆盖 ARM/Intel 路径不写死、权限和 PTY 下的回调；由 macOS 测试机验证。
- **WSL：** 按所选发行版解析 Linux home、CLI、Hook 命令、回调连通性和日志根；在 distro 内访问 Linux 路径，保留宿主可识别的 distro 身份，不混用 Windows home，不依赖全盘 UNC 递归。已有其他源的 roots/WSL 代码是参考，不等于 Antigravity 已经走通。跨发行版同路径、同 ID 及 worktree 需要隔离。
- **能力与回退：** 将启动、Hook、历史读取、定点恢复、实时统计和 Token 分开声明；协议探测/用户配置冲突只关闭相应能力，不影响 PTY 或已有历史。没有可信 Hook 时保留 Shell 状态，不推断模型任务已经结束。
