# Kimi Code CLI 与 Hook 集成设计

## 1. 设计原则

1. source 支持必须端到端一致：installer、hidden client、receiver、frontend typing、binding 与通知消费不能有遗漏。
2. Hook capability 与 history capability 分离：`kimi` 是可用 CLI/Hook source，但不是本次支持的 history source。
3. 本地和 SSH 复用同一 Kimi TOML planner；调用方只注入 executable-specific command，不复制结构化编辑规则。
4. 所有配置变更保持显式失败、精确 owner conflict 和原子写入语义；SSH 保留 preview fingerprint/journal，本地采用同目录 candidate、写前重验和原子替换；不增加 fallback 或 fake success。

## 2. 类型与 capability seam

```ts
type SshToolSource = "claude" | "codex" | "kimi";
type SshHistorySource = Extract<SshToolSource, "claude" | "codex">;
```

- `resolveSshToolSource` 负责 CLI/Hook source。
- `resolveSshHistorySource` 只接受 Claude/Codex。
- `projectCapabilities` 和 `buildSshAgentHistoryContext` 使用 history resolver。
- history result/resume/context 与 history RPC payload 全部使用 `SshHistorySource`。
- terminal SSH launch、config root、Hook report 与 source binding 使用 tool resolver。
- installation record 的 `historySourceCandidate` 改为 optional：Claude/Codex 必须存在且 source 一致，Kimi 必须缺失。

这样添加未来 Hook-only source 时不会误开启 history UI/API。

## 3. 共享 Kimi TOML planner

放在 `cli-manager-hook-schema` 的 Kimi module，依赖项目已使用的 `toml_edit`。

输入：

- 原始 `config.toml` 文本。
- 全部受管 definitions（native event、bridge event、可选 matcher）。
- 调用方生成的 exact command，包含 `--owner cli-manager-local` 或 `--owner cli-manager-ssh-agent:<installation-id>` 稳定 token。
- 本次 target bridge events 与 operation（inspect/install/uninstall）。

输出：

- 更新后的 TOML 文本。
- exact managed count。
- duplicate/outdated/conflict flags。

规则：

- `hooks` 缺失视为空数组；存在但不是 `ArrayOfTables` 明确报错。
- 先按受限 shell token grammar 解析 command；只有 executable + `__hook` + exact source/event + exact owner token 且无未知尾部参数时才是 CLI-Manager Kimi 候选，禁止 substring ownership。
- exact native event + matcher + command 计为 installed；同 key 多项为 duplicate/outdated。
- owner family、source、bridge event 与 native event/matcher 相符，但 executable path 或 SSH installation id 变化时视为 outdated，可在确认 install 时替换。
- exact owner token 存在但 source/bridge event/native event/matcher 不一致时视为 conflict，拒绝覆盖；仅有相似文本的第三方 command 始终不归 CLI-Manager 所有。
- uninstall 只删除目标 module 的受管条目；空 `hooks` 数组可移除，其他 TOML 原样保留。

## 4. Kimi event contract

| UI 模块 | Kimi native event | Bridge event | matcher |
|---|---|---|---|
| 会话启动 | SessionStart | SessionStart | 无 |
| 运行中 | TurnStarted | UserPromptSubmit | 无 |
| 待审批 | PermissionRequest | PermissionRequest | 无 |
| 审批结束 | PermissionResult | PermissionResult | 无 |
| 完成 | Stop | Stop | 无 |
| 用户中断 | Interrupt | Interrupt | 无 |
| 失败 | StopFailure | StopFailure | 无 |
| 子 Agent | SubagentStart | SubagentStart | 无 |
| 子 Agent | SubagentStop | SubagentStop | 无 |

Kimi 当前 `TurnStarted` 覆盖 user/task/system-trigger turn，较 native `UserPromptSubmit` 更完整；bridge 仍发送 CLI-Manager 已有的 `UserPromptSubmit`。`PermissionResult` 将 attention 恢复为 running 且静默，`Interrupt` 将 running/attention 清为 idle 且不发送成功/失败通知。Kimi `SubagentStart/Stop` 只进入通用 binding、状态、通知和 Replay，`agent_name` 仅展示，`App` 不进入 transcript split-pane 特殊分支。Receiver 与 SSH runtime 只 admission 上表九个 bridge events。

`SessionEnd` 暂不接入，因为本任务只要求 turn/session 活动状态，不把 CLI 进程退出语义与 Hook session archive 混合；Heartbeat、Task、Tool、Compact 等事件同样留待独立能力设计。

## 5. 本地链路

- `hook_settings_get_status` 增加可选 `kimiSelectedDir` 并返回 `kimi` status。
- 新增 `hook_settings_install_kimi` / `hook_settings_uninstall_kimi`，复用 `ClaudeHookModule` 六模块枚举与 Kimi definition selector。
- directory resolver 优先显式目录，其次进程已有 `KIMI_CODE_HOME`，最后 `~/.kimi-code`；inspect 不创建，install 可创建默认/显式目录。该目录仅供 Hook 管理，不向本地 terminal launch 自动注入 `KIMI_CODE_HOME`。
- inspect/install 先用 `kimi doctor` capability 区分当前 Kimi Code 与旧 `kimi-cli`；install 将 candidate 写入同目录临时文件并执行 `kimi doctor config <candidate>`，通过后再写前重验并原子替换，失败保留 live config。
- 安装成功文案提示新 session 自动生效，活动 Kimi TUI 需执行 `/reload`；不读取或迁移旧 `~/.kimi`。
- Hook settings store 增加 `kimiHookBridgeEnabled`、`kimiHookConfigDir` 和 `kimi` section state，默认 enable=true、config=null、section collapsed。
- App、terminal startup、Sidebar health 只在 enabled + status installed 时把 Kimi 计入 shared Hook 环境。

## 6. SSH 链路

- desktop root persistence command 增加 `kimiRoot`；数据库 schema 不变。
- remote Agent `Source::Kimi` 默认目录 `.kimi-code`，config file role 为 `kimiConfig`，只规划 `config.toml`。
- Kimi 继续使用既有 per-root lock、preview fingerprints、transaction journal、atomic replace、rollback 与 installation record；candidate commit 前执行远端当前 Kimi Code 的 `doctor config`。
- Kimi installation record 不携带 history candidate，desktop validator 强制该字段缺失且不持久化 history source metadata。
- Agent runtime admission Kimi 九事件；spool 与 daemon binding 不新增专属格式。
- SSH launch validator 接受 source `kimi` 和 env `KIMI_CODE_HOME`，沿用 remote home path 格式化；仅非空 host/project effective root 注入该变量，空 root 保留远端登录环境和 Kimi 原生默认值。
- Agent crate 从 `0.1.8` 递增为 `0.1.9`，protocol 维持 `1.11`；这是新 Hook adapter 的发布身份，不改变 bridge frame contract。

## 7. UI 与文案

- SSH source metadata 使用集中映射（label/icon），避免二元条件在第三个 source 下误显示 Codex。
- HookSettingsPage 按现有 source section pattern 新增 Kimi；不重构整页组件，以控制当前 PR blast radius。
- 新文案使用 `pickByLanguage` 或现有 i18n key；跨页面公共说明更新 `src/lib/i18n.ts` 的两种语言。
- Replay、Toast、第三方通知显示 `Kimi Code`，不显示 raw `kimi`。

## 8. 测试策略

- hook-schema：TOML comments/user hooks preserved、exact owner install、similar-command isolation、duplicate convergence、module uninstall、conflict/invalid shape。
- local backend：directory resolution、status、full/module install/uninstall、source admission。
- SSH Agent：Kimi default root/config path、doctor capability/candidate failure、preview/apply/uninstall、runtime event allowlist、history-less installation record。
- SSH launch：裸命令、路径/引号 executable resolver、source + `KIMI_CODE_HOME` validation/quoting。
- frontend Node：resolver、history capability split、PermissionResult/Interrupt 状态、Kimi Subagent no-split、terminal binding；TypeScript 覆盖所有 status/settings/IPC shape。
- 不启动 Tauri desktop；PR 手动清单要求在 zh-CN/en-US 下检查 Hook 页、SSH CLI 集成页和 24 小时时间格式。

## 9. 回滚

- 单次 config apply 自带 journal rollback。
- PR 回滚只需撤销 source/code changes；用户配置中的 CLI-Manager Kimi entries 可由设置页或 SSH CLI 集成页显式卸载。
- 不引入数据库 migration，因此代码回滚不会留下不可读 schema。
