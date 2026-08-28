# Kimi Code CLI 与 Hook 集成

## Changelog Target

TEMP（等待用户指定版本号）

## Goal

把已有的当前版 Kimi Code CLI 工具选项扩展为一等 CLI/Hook source：SSH 主机“CLI 集成”可配置、检查、安装和卸载 Kimi Hook；设置“Hook”页可管理本地、Windows 与 WSL Kimi Hook；事件能够进入现有标签状态、通知、Replay 和远程 session binding 链路。旧 `kimi-cli` 明确不受支持且不自动迁移。

## Requirements

### 1. 远程 CLI 集成

- `SshToolSource` 支持 `kimi`，默认 root 为 `$HOME/.kimi-code`，命令解析支持 `kimi` / `kimi.exe` 及带路径形式。
- SSH CLI 集成页与项目级 config root 均显示 Kimi，并支持 host primary、project override、retained root 的 inspect / preview / apply / uninstall。
- 启动 Kimi SSH 终端时注入 `KIMI_CODE_HOME`，沿用现有远程 home-path 校验和 shell quoting。
- SSH Agent 原生读写 `<root>/config.toml` 的 `[[hooks]]`，不得套用 Claude/Codex 文件格式。
- SSH inspect/install 通过当前 Kimi Code 的 `kimi doctor config` capability 与 candidate validation；旧 `kimi-cli` 或缺少该能力时明确报告 unsupported。
- 新增 Agent 版本承载 Kimi adapter；旧 Agent 的真实 `hook_source_invalid` 等错误必须显式暴露，不伪造成功或静默回退。

### 2. 本地 Hook 设置

- Hook 设置页新增 Kimi Code bridge section、启用开关、状态、目录选择/手填、路径说明、全量安装/删除和模块级开关。
- 默认目录为 `${KIMI_CODE_HOME:-~/.kimi-code}`；支持 native Windows、macOS/Linux 和 WSL UNC 目录。
- 六个 UI 模块管理九个 definition：`SessionStart`；`TurnStarted` 映射到 `UserPromptSubmit`；attention 模块包含 `PermissionRequest` + `PermissionResult`；stop 模块包含 `Stop` + `Interrupt`；以及 `StopFailure`、`SubagentStart` + `SubagentStop`。
- `PermissionResult` 清除 attention 并恢复 running，不产生 Toast；`Interrupt` 结束 running/attention 并回到 idle，不伪装为成功或失败，也不产生完成通知。
- Kimi Subagent 事件只进入通用 binding、状态、通知和 Replay；`agent_name` 仅作展示，不创建 transcript split pane。
- Kimi 配置必须结构化更新 TOML，重复安装幂等；受管 command 带精确 owner token，卸载仅删除 owner/source/event/installation identity 完整匹配的条目，保留相似命令、用户 Hook、第三方 Hook、未知字段、注释和顺序。
- inspect/install 必须识别当前 Kimi Code，并在替换 live config 前以 `kimi doctor config <candidate>` 验证临时文件；旧 `kimi-cli` 明确显示 unsupported，绝不读写或迁移 `~/.kimi`。
- 本地自定义 Kimi root 仅作为 Hook 配置管理目录，不自动给 CLI-Manager 启动的本地 Kimi 注入 `KIMI_CODE_HOME`；UI 明确说明该边界。写入采用同目录临时文件、写前重验和原子替换，失败保留原文件。
- Kimi bridge enable/config-dir/section state 按现有设置持久化规则保存；disabled source 仍可 refresh status，但不参与健康灯、重装、Hook env 或实时统计可用性判定。

### 3. Source admission 与消费

- hidden `__hook` client、HTTP receiver、frontend source type、terminal target binding、Replay、应用通知、系统通知及第三方通知统一识别 `source=kimi`。
- source/event pair 严格验证；未知事件返回 HTTP 400，不进入任何 sink；hidden process 仍保持现有“不打断 CLI”行为。
- Local 与 SSH 事件继续使用 exact Tab、legacy primary、bound session、unique source/path、recent output 的绑定优先级；不能因 Kimi 新增而放宽歧义绑定。

### 4. 能力边界

- 新增 `SshHistorySource = claude | codex` 或等价独立 resolver，并用于所有 history-facing 类型/API；Kimi CLI/Hook 支持不得自动启用远程历史、history sync、history metadata、history resume 或 parser。
- SSH Hook installation record 的 `historySourceCandidate` 仅 Claude/Codex 必填；Kimi 必须为 `null`/缺失，且不得写入 `history_source_instance_id`。
- Provider switching、cc-connect handoff、statusline、Kimi history parser 不在本任务范围。
- 所有新增或修改的用户可见文案兼容 `zh-CN` / `en-US`，英文界面时间仍保持 24 小时制。

## Scenario Matrix

| 维度 | 预期 |
|---|---|
| 窗口焦点 | 本窗口、其他窗口、应用未聚焦均复用现有通知/任务栏策略，Kimi 不新增抢焦点逻辑。 |
| 分屏 | 当前 pane、同窗其他 pane、深层 split tree 均按 source/session/path 精确绑定；歧义时拒绝猜测。 |
| 最小化 / 托盘 | Hook 状态仍更新；Toast、系统通知、任务栏提醒分别服从现有开关。 |
| Sidebar 模式 | expanded、collapsed、compact 下共享 Hook health 统计包含已启用 Kimi。 |
| 多会话 / Workspan | 同 path 多 Kimi session 必须依赖 session owner 或唯一 recent output，不能绑定第一个候选。 |
| Focus mode | 开/关不改变 Hook admission 与 Tab 状态。 |
| Runtime | Windows PowerShell/CMD/Pwsh、macOS/Linux Bash、WSL UNC、本地自定义 root、SSH Linux 均使用正确 executable/config path。 |
| Worktree | main repo、存在 Worktree、已删除 Worktree 均沿用现有 path matching；缺失路径不伪造绑定。 |
| Hook 状态 | 未安装、部分安装、已安装、重复/陈旧、无效 TOML、disabled bridge、仅 Kimi 安装、仅其他 source 安装均可区分。 |
| Kimi 身份 | 当前 Kimi Code 且 doctor 可用时允许管理；旧 `kimi-cli`、缺少 doctor、candidate 校验失败均显式失败且不修改原配置。 |
| SSH root scope | host primary、project override、retained root、空默认 root、自定义 root、外部编辑后的 stale preview 均保留现有事务与冲突语义。 |
| Agent 版本 | 新 Agent 支持 Kimi；旧 Agent 明确失败并可通过现有 Agent 更新流程升级。 |

## Acceptance Criteria

- [ ] SSH CLI 集成页稳定渲染 Claude、Codex、Kimi 三项，Kimi 图标、默认路径、browse/reset、Hook action 均可用。
- [ ] SSH project 的裸命令、带路径命令和带引号 executable path 中的 `kimi` / `kimi.exe` 会识别 Kimi source；非空 host/project effective root 注入 `KIMI_CODE_HOME` 并建立 source-bound Hook bridge，空 root 保留远端原生环境；本地 Hook root 不自动改变本地 CLI Home。
- [ ] Kimi SSH Hook inspect/preview/install/uninstall 对临时真实 TOML 文件通过；用户/第三方条目和注释保留，stale fingerprint 被拒绝。
- [ ] 本地 Hook 页可检查、安装、按模块切换和卸载 Kimi Hook；重复操作幂等，invalid TOML、旧 `kimi-cli`、doctor/candidate failure 明确失败且原文件不变。
- [ ] Kimi 九个受管 Hook definition 全部通过 backend admission（其中 `TurnStarted` 上报为 `UserPromptSubmit`），未知 source/event 被拒绝；`PermissionResult`/`Interrupt` 完成状态闭环。
- [ ] Kimi Subagent 事件可安全绑定、记录与展示，但并发同名事件不会创建或误合并 transcript split pane。
- [ ] disabled Kimi bridge 不参与 health/reinstall/env/stats；启用后状态恢复且不自动安装。
- [ ] Kimi SSH history 仍明确 unsupported，不发 history sync/preflight/resume RPC、不产生 history metadata；Claude/Codex history 无回归。
- [ ] 精确 owner identity 可收敛 stale executable/installation，任何仅包含相似 `__hook --source kimi` 文本的第三方 command 都不会被认领或删除。
- [ ] zh-CN / en-US 文案完整；无硬编码单语新增文案。
- [ ] `CHANGELOG.md` 与 `docs/功能清单.md` 已更新。
- [ ] focused Node/Rust tests、TypeScript、Rust check、format/diff checks 通过；任何已知无关失败单独报告。

## Notes

- 项目契约禁止 AI 启动 Tauri desktop 做 UI 验收；自动化验证覆盖配置文件事务、IPC shape、source admission 与绑定逻辑，最终 PR 保留中英文界面手动检查项。
- 研究与触点见 `research/`；技术决策见 `design.md`。
- 发布清单仍要求独立 check 与 PR 标准 review 无 P0/P1；实际 `git push` 前另行取得用户明确确认，再创建 Draft PR。
