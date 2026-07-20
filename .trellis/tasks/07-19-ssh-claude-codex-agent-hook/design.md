# `cli-manager-ssh-agent` 总体设计

## 1. 决策摘要

1. 远端组件正式名称为 `cli-manager-ssh-agent`。
2. Agent 内置 Hook、历史索引和统计能力，但安装/启用由“设置 -> SSH 主机 -> CLI 集成”显式触发。
3. 保存 SSH 主机、测试连接和首次打开项目都不得静默修改远端 Claude/Codex 配置。
4. 每个活跃 SSH 主机复用一条非 PTY Agent bridge；每个终端 Tab 保留独立交互式 SSH PTY。
5. 历史、详情、搜索、历史用量和实时统计全部在 bridge 协议内复用，不能为每次 UI 请求启动 SSH。
6. Hook 使用远端用户级 IPC；bridge 不在线时进入有界 spool，重连后补发。
7. 历史/统计基线由 Agent 内置增量解析器提供，远端 `ccusage` 是可选增强，不是硬依赖。
8. Agent 使用用户级按需运行模型；首期不默认安装 systemd/launchd/Windows Service。
9. 提供桌面端 SSH 上传安装和用户 HTTP(S) 拉取脚本安装，两者共享签名 manifest 与制品。
10. 首期正式承诺 Windows 客户端连接 Linux x64/aarch64；macOS target 和 Windows SSH target 分阶段验证后开放。
11. SSH 项目不支持供应商切换；供应商设置和 Agent 都不扫描、解析或管理 SSH 服务器供应商。
12. SSH Git 面板纳入首期必选交付，只开放远端仓库状态、Diff 和分支只读信息；Git 写入、网络和破坏性操作按独立 capability 后续开放。

## 2. 功能边界

### 2.1 本期方案覆盖

- Agent 制品、安装、升级、回滚、卸载、doctor 和 capability probe。
- Claude/Codex 远端 Hook 安装、状态检测、事件转发和离线补发。
- 远端会话历史列表、搜索、详情、子 Agent、Diff/变更和删除/编辑能力的权限边界。
- 历史用量分析与当前 Tab 实时 Token/模型/上下文/成本统计。
- SSH 连接池、缓存、并发、心跳、重连、磁盘配额和资源限制。
- SSH 内部只读文件侧边栏，以及独立的只读 Git 状态/Diff/分支面板。
- Windows/macOS/Linux 目标系统与认证/代理/受限环境兼容矩阵。
- README、CHANGELOG `[TEMP]` 和 `docs/功能清单.md` 的产品说明计划。

### 2.2 首期明确不做

- 不自研 SSH 协议栈，不绕过系统 Host Key 校验。
- 不默认安装常驻系统服务，不要求 root/sudo。
- 不使用公网 HTTP/WebSocket 让 Agent 回连桌面端。
- 不把远端历史目录挂载/伪装成本地路径。
- 不在无明确能力探测时宣称 Windows SSH target、极简容器或非 POSIX shell 完整支持。
- 不把 `ccusage`、Bun/npm 作为远端统计的硬前提。
- 不在 Hook 中执行网络请求、启动 SSH 或阻塞 Claude/Codex。
- 不读取远端 cc-switch/provider 数据库，不生成远端 Claude settings/Codex profile，不注入本机 provider secret。
- 首期不写回远端历史原文件；历史编辑、删除、插入、备份还原后续单独设计。
- 首期不执行远端 Git stage/commit/checkout/fetch/push/pull/discard/revert/stash/rebase/Worktree mutation。

## 3. 领域模型

```text
SshHost
  id, connection profile, auth strategy, capabilities
  agentInstallation: AgentInstallationState
  hookInstallations: { claude, codex }

RemoteProject
  environmentType = ssh
  sshHostId
  remotePath

RemoteAgentConnection
  hostId
  clientInstanceId
  installationId
  remoteMachineId
  protocolVersion
  agentVersion
  capabilities
  state
  lastHeartbeatAt
  reconnectAttempt

RemoteSessionBinding
  hostId
  projectId
  normalizedRemotePath
  terminalTabId
  source: claude | codex
  cliSessionId
  bridgeEpoch

RemoteHistorySourceInstance
  sourceInstanceId
  sourceDescriptorId: claude | codex
  scopeKind: ssh
  scopeKey: remoteMachineId + sshUser + configRootHash
  hostId, installationId, remoteMachineId, sshUser
  configRoot, parserVersion, agentIndexGeneration
  freshness, materialization

HistorySessionRef
  sourceId
  sourceInstanceId
  sourceSessionId
  storageKind
  rawPointers

RemoteHistoryCursor
  sourceInstanceId
  indexGeneration
  fileId/inode, mtime, size, offset
  lastSyncedAt
```

唯一会话键：

```text
history:<sourceId>:<sourceInstanceId>:<sourceSessionId>
```

禁止仅凭 `cwd`、项目显示名、`remotePath` 或兼容字段 `file_path` 绑定远端会话。项目路径是筛选/恢复候选信息，不是历史会话主键。

`hostId` 只代表本地连接档案，不能单独代表远端机器。bridge 握手必须返回稳定 `installationId`/`remoteMachineId`；Host 地址、SSH 用户或远端机器变化时，旧 cursor/cache 标记 `machineChanged`，不得静默复用。

## 4. 运行架构

```text
CLI-Manager WebView
  | Tauri invoke/events
CLI-Manager Rust / PtyHost daemon
  |-- SSH PTY #1 ------ ssh -tt ------ Remote shell / Claude/Codex
  |-- SSH PTY #2 ------ ssh -tt ------ Remote shell / Claude/Codex
  `-- Agent bridge ---- ssh -T ------- cli-manager-ssh-agent bridge --stdio
                                              |
                                      user-only IPC socket
                                      /       |        \
                               hook one-shot history   stats/tailer
```

交互 PTY 与 bridge 必须分离：

- PTY 输出只进入 xterm。
- bridge stdout 只承载协议帧，stderr 单独进入脱敏诊断日志。
- 同一主机的所有项目/Tab 共享一个 bridge。
- bridge 由 daemon 持有；UI 退出但后台 PTY 继续时，Agent/Hook/统计仍可工作。
- Windows 不依赖 ControlMaster；Unix 客户端可在后续能力探测后选择底层复用，但产品语义不依赖它。

## 5. Agent 进程与目录

### 5.1 进程模型

- `bridge --stdio`：由本地 SSH 进程按需启动，生命周期受连接池管理。
- `hook ...`：Claude/Codex 触发的一次性快速命令，目标执行时间小于 250ms。
- `doctor/status/version`：短生命周期结构化命令。
- 首期不常驻；当 bridge 不在线时，Hook 只写 spool 后退出。

### 5.2 用户目录

POSIX：

```text
$XDG_DATA_HOME/cli-manager-ssh-agent/versions/<version>/
$XDG_STATE_HOME/cli-manager-ssh-agent/{state,spool,index}/
$XDG_STATE_HOME/cli-manager-ssh-agent/installation.json
$XDG_RUNTIME_DIR/cli-manager-ssh-agent/bridge.sock
~/.local/bin/cli-manager-ssh-agent -> current launcher
```

没有 XDG 变量时分别回退到 `~/.local/share`、`~/.local/state`、`~/.cache`。目录权限 0700，文件 0600。

macOS 使用 `~/Library/Application Support/CLI-Manager/ssh-agent/` 存放版本和状态，但稳定入口仍采用安装时解析出的绝对路径。Windows target 使用 `%LOCALAPPDATA%\CLI-Manager\ssh-agent`，首期仅设计兼容。

Hook 配置必须写稳定入口的绝对路径，不依赖 PATH、`~` 或登录 shell 初始化。

自定义 Agent 安装目录：

- `install.sh --install-dir /custom/path` 或桌面端自定义路径只改变 binary/version/current launcher 的位置，不改变标准 state/runtime 目录，也不改变 Claude/Codex config root。
- installer 在标准 state 目录写 `installation.json`，包含 installationId、canonical executable/current path、install root、version、target、签名 key id 和更新时间；不包含凭据。目录 0700、文件 0600。
- `~/.local/bin` symlink 只是可选便利入口，bridge/Hook 不依赖 PATH；Hook 写入 discovery record 中经过验证的 stable absolute current path。
- 桌面端探测顺序为：Host 已保存的 explicit Agent path -> 标准 discovery record -> 默认 stable path。探测到路径后必须运行 `<path> version/status --json`，核对 installationId、协议和远端用户，不能只相信 JSON 文件。
- discovery record 缺失、被移动或使用 `--no-register` 时，用户可在“CLI 集成 -> Agent 路径”填写绝对路径并执行“检测并关联”。关联只保存 canonical path/identity，不移动或重装 Agent。
- Agent 升级继续在原 install root 内原子切换 current；普通升级不能悄悄迁回默认目录。用户主动更换 install root 时先验证新 Agent/identity，再更新 discovery/Hook owner entries，失败保持旧路径。

同一服务器的不同 SSH 用户拥有独立安装目录、installation id、Hook 配置、历史索引和 spool，不允许跨用户发现或合并数据。

`installationId` 存在 state 目录而不是版本目录，升级和普通重装必须保留；只有 `--purge` 生成新身份。`remoteMachineId` 只发送不可逆的 opaque hash，不回传原始 `/etc/machine-id`/hostname；机器标识不可用时回退到低置信度 installation identity，并禁止跨 Host 档案自动合并缓存。

## 6. 安装、升级和卸载

### 6.1 SSH 主机设置页

新增“CLI 集成”区：

1. Agent 状态：未安装、已安装、可升级、协议不兼容、损坏、无法检测。
2. 安装来源：桌面端上传、官方 HTTP(S) 脚本、自定义签名镜像。
3. Agent 路径：自动发现或显式绝对路径，显示 canonical path、安装来源和签名/验证状态。
4. Claude/Codex 命令与 config root：每个工具提供一个“CLI 配置目录（Hook 与历史）”，按 SSH Host 独立保存；Hook 配置文件和历史制品路径只读展示。
5. Hook 状态：Claude、Codex 独立安装/升级/卸载/预览。
6. 能力状态：Hook、历史、实时统计、Git、ccusage、spool、索引。
7. doctor：远端 OS/arch、安装目录权限、exec/noexec、配置目录、磁盘空间、CLI/Git 版本和连接诊断。

### 6.2 桌面端上传安装

```text
fetch manifest -> verify signature -> select target artifact
-> verify size/SHA-256 -> SFTP/SSH upload to random staging dir
-> remote agent self-check --json
-> atomic promote current -> bridge handshake
-> success keep current + previous / failure rollback
```

远端参数必须结构化传递并经过 POSIX/PowerShell 专用引用；不允许前端拼完整 shell 命令。

### 6.3 HTTP(S) 脚本安装

发布：

- `install.sh`：POSIX sh，不要求 Bash。
- `install.ps1`：Windows target 后续使用。
- `release-manifest.json`：schema、channel、version、protocolMin/Max、target、URL、size、SHA-256。
- manifest detached signature / Sigstore bundle，桌面端和脚本内置受信公钥。

推荐文档是“两步下载、审阅、执行”，而不是盲目 `curl | sh`。UI 可提供一键复制命令，但默认 URL 必须是 HTTPS。

脚本默认只安装/升级 Agent，不修改 Claude/Codex Hook。Hook 仍需在“设置 -> SSH 主机 -> CLI 集成”中逐工具预览并确认；脚本若提供 `--with-claude-hook` / `--with-codex-hook`，必须是用户显式参数并复用同一 dry-run/owner/journal 安装器。

普通 HTTP 仅允许以下路径：

- 桌面端先通过 SSH 上传内置可信 installer/public key，再由 installer 从 HTTP 镜像下载并验签；或
- 用户显式提供可信公钥指纹/签名，并接受风险提示。

直接通过未认证 HTTP 下载并执行脚本无法建立供应链信任，不能宣称安全。

### 6.4 升级和回滚

- 安装锁防止多个桌面端或脚本并发升级。
- 默认禁止降级；显式 `--allow-downgrade` 才允许。
- staged artifact 先执行 `version --json`/`doctor --self`，确认 target、version、protocol。
- 原子切换 `current`；新 bridge 握手失败则恢复 previous。
- 保留当前和上一版本，旧版本按 TTL 清理。
- 不静默自动升级；协议不兼容时阻止 bridge 并引导用户升级。

### 6.5 卸载

- 默认“移除 Agent 及其管理的 Hook”，先精确卸载 owner 条目再删除制品。
- 若仍存在已管理 Hook，“仅删除 Agent”需要危险确认，否则会留下失效 Hook。
- 普通卸载保留有界备份；`--purge` 才删除索引、spool、备份和状态。

## 7. Hook 安装设计

### 7.1 所有权和配置合并

安装入口的完整流程：

```text
用户选择 Claude/Codex + config root(auto/custom)
  -> desktop 调 Agent hook_inspect/hook_preview
  -> Agent 展开并 canonicalize config root
  -> 返回实际配置文件、现有 Hook、fingerprint 和 patch preview
  -> 用户确认
  -> Agent hook_install(expected fingerprints)
  -> 远端锁/备份/journal/原子合并/reread verify
  -> 返回 HookInstallationRecord + history source candidate
  -> desktop 持久化并注册/验证 remote HistorySourceInstance
```

实际配置位置：

- Claude：`${canonicalConfigRoot}/settings.json` 中的 Hook 配置；config root 默认远端当前用户的 `$HOME/.claude`。
- Codex：`${canonicalConfigRoot}/hooks.json`，并在需要时合并 `${canonicalConfigRoot}/config.toml` 的 hooks feature；config root 默认 `$HOME/.codex`。
- CLI 版本改变配置格式时以 Agent adapter capability/preview 返回为准，前端不能硬拼文件路径或 JSON/TOML 内容。

Agent 安装响应必须返回：

```text
HookInstallationRecord {
  source, installationId, ownerId,
  configuredConfigRoot, canonicalConfigRoot,
  configFiles[{ role, canonicalPath, beforeFingerprint, afterFingerprint }],
  managedEntries, adapterVersion, installedAt,
  historySourceCandidate{ source, canonicalConfigRoot, configRootHash }
}
```

桌面端记录的是该 SSH Host/工具的 canonical config root 与实际配置文件地址，不是简单保存“安装成功”布尔值。该 `canonicalConfigRoot` 同时是远端历史 source 的 config root：Claude adapter 再读取其 `projects/...`，Codex adapter 再读取其 `sessions/...` 和共享状态制品。

首期不提供 Hook root 与 history root 分离配置。Hook 安装状态与 History Source 状态仍是两个独立能力状态：卸载 Hook 不删除该主机保存的 config root、History Source 或历史缓存；修改唯一 config root 时走两阶段验证/索引切换，新路径成功前保留旧历史实例。

每条远端 Hook 命令包含：

```text
cli-manager-ssh-agent hook
  --source claude|codex
  --event <event>
  --managed-by cli-manager-ssh-agent
  --installation-id <uuid>
```

安装、升级、卸载只处理“稳定入口 + owner + installation id + source/event”完全匹配的条目。不能沿用“命令包含 `__hook` 就属于我们”的宽匹配。

写配置事务：

1. 获取安装锁并记录原始指纹、权限、symlink target。
2. 结构化解析并生成 dry-run diff。
3. 仅合并/删除本 Agent 条目，保留未知字段、第三方命令、matcher 和数组顺序。
4. 同目录临时文件，flush/fsync，保留 mode/owner，原子 replace。
5. reread 验证；发现外部并发修改则有限重试，不能覆盖。
6. 多文件写入使用 install journal；部分失败时按写入指纹安全回滚。

Codex `hooks` feature 若原本由用户/第三方开启，卸载不得关闭；journal 记录安装前值。

### 7.2 Hook 数据路径

```text
Claude/Codex -> agent hook stdin parser
-> user-only IPC socket
-> bridge HookEvent frame
-> local daemon HookReport sink
-> existing tab state / toast / system notification / subagent tree
```

bridge 不在线：

- Hook 写入 append-only spool 后立即成功退出。
- spool 默认上限 10,000 事件或 32MB，TTL 24 小时；先到者生效。
- 溢出删除最旧事件并写 `gap` 标记。
- bridge 使用 `eventId + sequence` 至少一次投递，本地去重；ack 后 Agent 删除已确认记录。
- Hook 失败永远不能阻塞 Claude/Codex。

### 7.3 会话绑定

SSH 启动计划向远端 shell 注入非敏感绑定信息：

```text
CLI_MANAGER_SSH_HOST_ID
CLI_MANAGER_SSH_CLIENT_INSTANCE_ID
CLI_MANAGER_PROJECT_ID
CLI_MANAGER_TAB_ID
CLI_MANAGER_BRIDGE_EPOCH
```

Hook 从 stdin 获取 CLI `session_id`、cwd 和 transcript path，再与环境绑定合并。缺少 `CLI_MANAGER_SSH_CLIENT_INSTANCE_ID`、`CLI_MANAGER_TAB_ID` 或 bridge binding 时必须立即 no-op，不写 spool、不上报；这样远端用户从普通 SSH、IDE、tmux 或其他终端启动的 Claude/Codex 不会被 Hook 采集。历史索引与 Hook 独立，但首期历史也只返回已绑定项目范围。

同一远端用户被多条 SSH Host 配置或多个 CLI-Manager 桌面端连接时，每个 `hostId + clientInstanceId + installationId` 使用独立 bridge endpoint 和 spool namespace。Hook 只投递到启动该会话的 Host/客户端；一条 Host 配置或一个客户端断线不得把事件广播给其他 Host 档案或桌面端。

远端 payload 增加：

```text
eventId, sequence, hostId, clientInstanceId, installationId,
projectId, tabId,
source, event, cliSessionId, remoteCwd,
remoteTranscriptRef, agentVersion, protocolVersion, occurredAt
```

`remoteTranscriptRef` 是远端引用，不是本地路径；子 Agent transcript 通过 Agent RPC 获取。

## 8. Bridge 协议

### 8.1 传输

- `ssh -T <host> <absolute-agent-path> bridge --stdio --protocol <n>`。
- 长度前缀帧优先；调试模式可使用 JSONL。
- 单帧默认上限 1MB；大详情/补发分块并有 requestId/chunkIndex。
- stdout 仅协议，stderr 独立采集且脱敏。
- Agent 启动后先输出带 protocol major 和随机 nonce 的固定 magic preamble。客户端最多忽略 preamble 前 8KB 的登录 banner/profile stdout，找到 preamble 后立即进入严格帧解析；超限、超时、伪造/重复 preamble 或帧间混入文本均关闭连接。doctor 单独报告 `bridge_stdout_contaminated`，ForcedCommand/受限 shell 返回明确不支持。

当前 `SshLaunchPlan` 固定 `-tt`、进入项目目录并启动交互 shell，只能作为 terminal PTY 基线，不能直接复用为 bridge。Rust 需要把当前 `ssh_launch.rs` 与 `commands/ssh.rs` 重复的认证/跳板/代理参数抽成共享 `SshTransportSpec`，再生成三种 launch：

```text
InteractivePtyLaunch  -> ssh -tt + project shell/startup
AgentBridgeLaunch     -> ssh -T  + absolute agent bridge --stdio
OneShotExecLaunch     -> ssh -T  + install/doctor/path probe
```

bridge key 至少包含 hostId、SSH user 和 resolved connection fingerprint。主机地址、SSH Config alias、认证、跳板、代理或凭据引用变化时，daemon 必须使旧 bridge 失效；安装/doctor 短连接不占用常驻 bridge lease。

### 8.2 帧类型

客户端到 Agent：

```text
hello, ping, cancel
bind_session, unbind_session
session_claim, session_release
history_list, history_get, history_search, history_refresh, history_resume_preflight
stats_get, stats_subscribe, stats_unsubscribe
file_probe, file_list, file_stat, file_read, file_search
file_subscribe, file_unsubscribe
git_probe, git_list_repositories, git_get_changes, git_get_file_diff
git_branch_status, git_list_branches, git_subscribe, git_unsubscribe
hook_ack, cursor_ack
shutdown
```

Agent 到客户端：

```text
hello_ok, pong, response, error
hook_event, gap
history_changed, history_progress
stats_snapshot, stats_delta
file_changed
git_changed
capabilities_changed
```

所有异步帧包含 `protocolVersion`、`bridgeEpoch`、`sequence`、`hostId` 和 `occurredAt/asOf`。未知帧类型返回版本化错误但保持连接；协议主版本不兼容时拒绝运行。

### 8.3 心跳与重连

- `ConnectTimeout=10s`。
- `ServerAliveInterval=15s`、`ServerAliveCountMax=3`，约 45 秒判死。
- 应用层 ping/pong 10 秒；连续 3 次失败进入 disconnected。
- 退避：1/2/5/10/30/60 秒，±20% 抖动；稳定 30 秒后复位。
- 全局同时重连不超过 2 个主机。
- 首期可后台自动建立/重连 bridge 的认证模式限定为可非交互完成的 `ssh_config`、SSH Agent、identity file 和可用的 `credential_ref`。设置页必须把“终端可连接”和“CLI 集成 bridge 可连接”分开诊断。
- `password_prompt` / `interactive` / 多轮 MFA 当前只能保证交互终端能力。一次前台 PTY 认证不能被独立 `ssh -T` bridge 复用；在没有多轮 AskPass broker、原生 SSH 库或可靠 multiplexing 设计前，bridge 返回 `authenticationRequired`，停止后台重试并要求用户前台重新认证，不能宣称 daemon 可自动重连。
- Host Key 信任继续由系统 OpenSSH 管理；安装、doctor 和 bridge 均不得使用 `StrictHostKeyChecking=no` 绕过验证。
- Agent hello 返回 UTC wall-clock 和 monotonic tick；doctor 对超过 5 分钟的远端/本地时钟偏差给出警告。事件顺序以 sequence/cursor 为准，不以跨机器 timestamp 为准。

## 9. 连接池和服务器性能

### 9.1 连接模型

每个活跃主机：

```text
1 x bridge SSH connection
N x interactive PTY SSH connections (N = active terminal sessions)
```

历史、统计、Hook 补发和 doctor 不额外建立常驻连接。设置页的安装/测试可使用短连接，结束立即关闭。

默认限制：

- 每主机最多 1 bridge。
- 全局 bridge 上限 4，可配置 2-8。
- 每主机同时 1 个历史索引任务 + 1 个统计/tail 任务。
- 每主机最多 watch 8 个活跃 CLI session，其余降为低频索引。
- 无 PTY、无实时订阅、无待发 Hook 且空闲 5 分钟后关闭 bridge。

这样服务器额外成本约为每个活跃主机 1 个 sshd 会话和 1 个按需 Agent 进程。无文件变化和 UI 请求时近零 CPU；不会随着历史列表滚动次数增加连接数。

### 9.2 不依赖 ControlMaster

Windows OpenSSH 对 ControlMaster/ControlPath 的兼容性不能作为产品承诺。首期明确使用独立 bridge 进程保证确定性。Unix 客户端后续可选探测 ControlMaster，但它只能优化底层 TCP/认证，不改变上层“每主机一个 bridge”的生命周期。

## 10. 远端历史设计

### 10.0 历史根目录配置与发现

远端历史的配置对象是“远端工具 config root”，不是 Agent binary path，也不是 Hook command path：

路径语义必须分成三层：

| 路径 | 示例 | 用途 | 是否决定历史位置 |
|---|---|---|---|
| Agent executable | `/opt/user-tools/cli-manager/current/cli-manager-ssh-agent` | bridge/hook/doctor/Git RPC | 否 |
| Claude/Codex executable | `/opt/claude/bin/claude`、`~/bin/codex` | 启动 CLI、版本探测 | 否 |
| Claude/Codex config root | `/data/dev/.claude`、`/srv/state/codex` | Hook 配置、历史与状态制品 | 是 |

因此，自定义安装 Agent 或把 Claude/Codex binary 放到其他目录，都不会改变历史扫描位置。只有用户实际设置的 `CLAUDE_CONFIG_DIR` / `CODEX_HOME` 或 CLI 集成中的 config root 覆盖才改变历史 source instance。

```text
RemoteToolIntegration {
  integrationId, hostId?, installationId, remoteMachineId, sshUser, source,
  scopeKind: hostPrimary | projectOverride,
  projectIds[],
  configRootMode: default | hostCustom | projectOverride,
  defaultToolConfigRoot,
  configuredToolConfigRoot?, canonicalToolConfigRoot?,
  hookConfigFiles[], historyArtifactSummary[],
  historySourceInstanceId?, referenceCount,
  validationState, cleanupState, lastValidatedAt
}

SshHostToolPreference {
  hostId, source, configuredToolConfigRoot, updatedAt
}
```

`SshHostToolPreference` 只保存 Host 卡片唯一可编辑值，空值表示默认目录；`hostPrimary` integration 是验证后产生的实际 root 记录。`projectOverride` 由项目的 `cliConfigRoot` 生成，在 Host 页只读聚合。修改 preference 不覆盖旧 integration；`hostId` 删除后 integration 可保留为空并进入 unbound，依靠 installationId/remoteMachineId/sshUser/config root identity 支持安全重新绑定。

默认位置：

| Source | 用户配置值 | Agent 派生输入 |
|---|---|---|
| Claude | config root，默认 `$HOME/.claude` | `projects/**/*.jsonl`，以及 adapter/version 支持的 transcript、session index、subagent 制品 |
| Codex | config root，默认 `$HOME/.codex` | `sessions/**/*.jsonl`、`history.jsonl`、`session_index.jsonl`、`state_5.sqlite`/`sqlite/state_5.sqlite`，以及版本支持时的 archived sessions |

用户只选根目录。派生文件路径属于 adapter contract，不能在 UI 逐项填写，否则 CLI 升级后容易形成不一致配置。

入口位于“设置 -> SSH 主机 -> 目标主机 -> CLI 集成 -> Claude/Codex”。配置属于当前 SSH Host，不是全局值，也不会同步覆盖其他主机：

- 每个工具提供一个可编辑字段“CLI 配置目录（Hook 与历史）”。Claude 初始默认 `$HOME/.claude`，Codex 初始默认 `$HOME/.codex`；Agent 按该 Host 的 SSH 用户解析并显示绝对路径，例如 `/home/dev/.claude`。
- 字段旁提供“选择远程目录”和“恢复默认”操作。默认模式不是全盘探测，而是使用该 SSH 用户的标准 CLI 配置目录；用户自定义后只影响当前 Host/当前工具。
- 自定义允许绝对 POSIX 路径和 `~/...` shorthand；Agent 按当前 SSH 用户展开并 canonicalize。禁止 `$VAR`、命令替换、换行、NUL、相对路径和 `..`。
- 字段下方只读展示“Hook 配置文件”和“历史数据位置/制品摘要”。Claude 通常显示 `${root}/settings.json`；Codex 通常显示 `${root}/hooks.json` 与按版本需要的 `${root}/config.toml`。历史制品由 adapter 返回，前端不硬编码为可编辑项。
- 保存或测试 Host、验证配置目录、首次打开项目均不创建远端目录。只有用户显式点击“安装 Hook”并确认 preview 后，Agent 才可创建缺失的默认 config root/配置文件；自定义目录不存在时默认阻止并要求用户先创建或重新选择。
- Hook 和 history 始终消费同一个 Host 级 `toolConfigRoot`，但能力状态独立；未安装或卸载 Hook 不影响历史读取。
- 项目设置可提供可选“CLI 配置根”覆盖。项目显式字段优先；已知项目环境变量中的 `CLAUDE_CONFIG_DIR`/`CODEX_HOME` 可迁移为该字段。startup command 内动态 export 无法可靠推断，必须由用户显式填写。
- Host 卡片下增加只读“项目覆盖目录”列表：按 canonical root 合并显示引用项目、History Source、Hook 状态和显式 Hook 操作。覆盖值仍只在项目设置中编辑，不能在 Host 页面产生第二个主目录输入；多个项目引用同一 root 时共享安装记录和 source instance。
- 修改 Host 主目录或项目覆盖目录时，已运行 Tab 继续使用启动时捕获的 config root。新 root 先 validate/index，再切换新会话默认值；旧 root 的 Hook 不静默删除，仍被项目或活动会话引用时保留，不再引用时显示 orphaned/cleanupAvailable 并要求显式清理。

Agent discovery/validation 返回：

```text
configuredPath, canonicalPath, exists, readable,
sourceDetected, sourceVersion?, artifactKinds,
estimatedSessions, scanTruncated, warnings,
machineId, sshUser, configRootHash
```

规则：

1. `auto` 只探测当前 SSH 用户的确定默认根，不遍历整个 HOME 或磁盘。
2. 自定义根不存在时，历史验证不自动创建目录；Hook 安装若需要创建配置必须单独确认。
3. 同一 machine/user/source/canonicalRoot 复用一个 `sourceInstanceId`；不同项目指向同一 root 不重复索引。
4. Host 默认 root 与项目 override 可以同时 active，历史列表按 host/project/source instance 过滤。
5. 路径切换是 pending -> validate -> initial index -> active 两阶段流程；旧实例在新实例成功前保持可读。
6. 完整枚举成功前不产生 delete tombstone；权限失败、目录离线、扫描超时和取消只标记 stale/partial。
7. Host 地址或别名改变但 machine/user/root identity 相同，可在用户确认后复用；machine/user/root 变化时旧实例不自动合并。

### 10.1 Agent 索引

- 解析远端 Claude/Codex 原生配置根目录。
- 使用 file id/inode + mtime + size + offset 增量读取，仅提交完整 JSONL 行。
- 文件截断/旋转生成新 generation，旧 cursor 失效并发 `gap/reset`。
- Agent 索引仅保存摘要、FTS 文本、usage fact、游标和远端文件引用；详情按需解析。
- 默认 Agent 索引配额 128MB，可配置；按 LRU/TTL 清理，不删除原始 Claude/Codex 历史。
- 默认索引范围是 CLI-Manager 已绑定到该 hostId/configRoot 的远端项目目录；不自动枚举或导入远端用户的其他 Claude/Codex 项目。未来“扫描整台主机历史”必须是独立显式开关和权限说明。
- 派生索引按 `(sshUser, source, configRootHash)` 存放在权限 0700/0600 的共享状态目录。同一远端用户的多个 bridge 采用跨进程 lock/lease 保证单写多读：只有持有 writer lease 的进程执行 scan/compact/rebuild，其他进程读取已提交 generation 或返回 queued/retryAfter，不能各自重复扫描大历史。
- writer 使用短事务和 generation 原子提交；崩溃后的过期 lease 可安全接管。Hook spool、bridge epoch 和 session ownership 不共享，继续按 clientInstanceId 隔离，避免共享历史索引破坏事件归属。
- `CLAUDE_CONFIG_DIR` / `CODEX_HOME` 可由 SSH Host 或项目绑定显式配置；`sourceInstanceId` 绑定 `installationId + remoteMachineId + sshUser + source + configRootHash`，索引、Hook 状态和 cursor 均按该实例隔离。
- 路径匹配同时保留 configured/logical cwd 与可用时的 canonical cwd，处理 symlink/大小写差异；项目身份仍以配置的 hostId + remotePath 为准，不能因 realpath 相同合并两个项目。

建议把现有历史 parser 提取成共享 Rust crate，由桌面后端和 Agent 共用，避免 Claude/Codex 格式修复只落一边。

### 10.2 History Source 路由

```text
HistorySourceDescriptor (claude / codex)
  -> HistorySourceInstance
       local/WSL configured instance
       SSH managed instance(sourceInstanceId, host identity, config root)
  -> HistorySessionRef + rawPointers
  -> history-catalog.db v2
```

SSH 不新增 `ssh-claude` / `ssh-codex` source id，也不建设与 History Source 平行的 Provider 注册表。`HistorySourceDescriptor` 继续描述 Claude/Codex 格式和通用能力；source instance 再叠加 environment/transport/materialization 能力。Rust 根据 `sourceInstanceId` 的 scope 路由到本地 adapter 或 Agent bridge。

现有公开 DTO、`makeSessionKey`、详情/搜索/收藏/审计接口仍大量依赖 `file_path`，必须先升级为 typed `HistorySessionRef`。`file_path` 仅可作为本地兼容显示字段；SSH raw locator 必须放入 `rawPointers`/artifact locator，不能构造一个看似本地可打开的路径。远端项目文件引用使用 `RemoteFileRef`，不得进入本地 `PathBuf` command。

当前 `history_source_instances` 的唯一 active 约束是 `(source_id)`，会导致“本机 Claude”和“多台 SSH Claude”互相停用。v2 schema 必须增加 activation scope：

```text
scope_kind = configured | ssh
scope_key  = desktop | remoteMachineId:sshUser:configRootHash
UNIQUE(source_id, scope_kind, scope_key) WHERE activation_state = 'active'
```

`historySourceSettingsStore` 继续只管理用户选择的本机/WSL configured instance；SSH 主机 CLI 集成负责注册/停用该主机的 managed instance。查询读取所有 active scope，并提供 host/project/sourceInstance 过滤。

“设置 -> 历史来源”不承担 SSH 连接、Agent 安装或远端 config root 编辑；最多只读展示“由 SSH 主机管理”的实例摘要并跳转对应主机。“设置 -> 供应商”仍完全不知道这些实例。

### 10.3 何时建立 SSH

| 场景 | 连接策略 |
|---|---|
| App 启动 | 不为历史自动连接所有服务器；显示本地缓存。 |
| 打开某 SSH 项目历史 | 复用该主机 bridge；若不存在则建立一条按需 bridge。 |
| 列表滚动/分页/搜索 | 在现有 bridge 内请求，不启动新 SSH。 |
| 打开详情/Diff | 复用 bridge，按需分块读取。 |
| 历史用量分析 | 先聚合本地缓存；用户刷新时按全局并发 2 连接目标主机并增量同步。 |
| 面板关闭 | 停止轮询，保留空闲连接直到 idle timeout。 |
| 远端不可达 | 返回最近缓存，显示 `stale` 和 `asOf`，不连续重试 UI 请求。 |

本地缓存身份必须包含 `sourceId + sourceInstanceId + sourceSessionId`；同步状态再包含 parserVersion/indexGeneration。`hostId`、remotePath 只用于连接和筛选，不能替代稳定 source instance。SSH 派生行默认配额 256MB，但必须在共享 `history-catalog.db` 内按 remote scope 清理，不能创建第二个本地历史数据库。

### 10.4 编辑、删除和恢复

- 首期远端历史明确只读：支持列表、搜索、详情、Diff、收藏本地快照和同主机 resume；编辑、删除、批量删除、插入消息、撤销和备份还原入口隐藏并由 store/backend 硬拒绝。
- 后续开放写操作时必须由 Agent 在远端执行，与现有本地历史编辑一样采用指纹校验、同目录临时文件和原子替换，不复用本地文件 command。
- 从远端历史恢复必须选择同一 hostId 的 SSH 项目，并在远端 cwd 执行 `claude --resume`/`codex resume`；禁止恢复到同名本地目录。
- 收藏仍可保存本地只读快照，并记录远端来源，不允许快照路径触发本地文件打开。

### 10.5 三层存储模型

```text
Layer 1: 远端 Claude/Codex JSONL
  唯一事实源，不由 Agent 重写或完整复制

Layer 2: 远端 Agent 派生索引
  session summary / file cursor / usage facts /
  bounded search text / tombstone / index generation
  可删除、可重建，不是事实源

Layer 3: 本地 CLI-Manager 缓存
  现有 history-catalog.db v2 中的 remote source instance
  summaries / usage & daily facts / freshness / materialization /
  sync cursor / local favorite snapshot
```

Agent 远端索引建议使用独立 SQLite：

```text
remote_session_index(
  source, config_root_hash, session_id, project_key,
  remote_file_ref, file_id, size, mtime, indexed_offset,
  title_preview, message_count, current_model, updated_at,
  input_tokens, output_tokens, cache_tokens, index_generation
)

remote_usage_fact(
  session_id, occurred_at, model,
  input_tokens, output_tokens, cache_read, cache_creation
)

remote_search_text(
  session_id, bounded_normalized_text
)
```

- `remote_search_text` 按单会话设上限并受 Agent 总配额控制；它留在远端当前用户目录，权限 0600，不进入同步/导出。
- Agent 不存完整结构化消息、工具 payload、图片或完整 Diff；详情请求时直接读取事实源 JSONL 并标准化返回。
- Agent 索引记录 `parserVersion/schemaVersion`；解析语义升级时标记旧索引 stale 并分批重建，不能把旧 cursor 直接当作新 parser 的完整结果。
- 桌面端只使用现有 `history-catalog.db` v2，不新增 `ssh-history.db`、`remote-history-cache.db` 或其他竞争性索引。远端 Agent 自己的 SQLite 位于远端用户目录，只是 Agent 的可重建工作索引。
- `history-catalog.db` 对 SSH source instance 只持久化 summary/usage/daily facts/cursor/freshness。标题/预览必须截断；完整 detail 默认进入内存 LRU，关闭应用即释放。
- v2 增加 `transport_kind`、`scope_key`、`materialization_level`、`freshness_state`、`as_of` 和远端 identity metadata。remote summary-only session 不写入完整 `history_messages`/FTS；离线全文搜索、完整详情和 Diff 明确不可用，UI 不能把 partial materialization 显示成完整缓存。
- 收藏继续复用本地完整只读快照能力；未来离线保存必须是用户显式操作，具备单项删除、主机级清理和空间统计。
- 远端索引删除不会影响原始历史；本地缓存删除不会影响远端索引或原始 JSONL。

### 10.6 加载与同步流程

打开远端历史时：

1. 立即从 `history-catalog.db` v2 读取该 remote source instance 的 summary/usage/freshness，先显示列表和 `asOf`，不等待 SSH。
2. 如果已有 host bridge，发送 `history_sync(sinceGeneration)`；没有 bridge 时，仅因用户打开该主机历史才按需建立一条。
3. Agent 先检查目录级 generation，再只处理新增/mtime/size/file-id 变化的文件。
4. Agent 返回带 `HistorySessionRef/rawPointers` 的 upsert/delete/tombstone delta，不返回整个历史目录。
5. 本地在 `history-catalog.db` 单个事务中应用 delta、更新 cursor/freshness/materialization，再刷新 UI。
6. 用户打开详情时发送 `history_get(sourceInstanceId, sourceSessionId)`；Agent 按需解析单会话并分块返回，详情放入内存 LRU。

只有一次完整目录枚举成功且对应 config root 可读时，Agent 才能产生 delete tombstone。SSH 断线、权限错误、config root 暂时不可用或扫描取消都只能标记同步失败/stale，不能把“没有扫描到”解释成远端删除。

搜索分两级：

- 本地离线搜索：session id、项目、来源、标题/截断预览、标签和收藏。
- 在线全文搜索：复用 bridge 查询远端 `remote_search_text`；点击结果后按需加载详情。

历史用量分析不读取完整消息：Agent 增量维护 usage facts，本地缓存日/会话事实后完成跨主机聚合。这样远端断线时仍可查看最近统计，刷新时只传新增 usage facts。

### 10.7 性能调度

- 每主机仅一个低优先级 history index worker，重复 refresh 共享同一任务。
- 活跃 CLI session 的 transcript tail 使用 1-2 秒增量读取；后台历史目录只在 watcher 事件或低频 30-60 秒 fingerprint 检查时更新。
- watcher 不可用、NFS/overlayfs 不可靠时降级为 fingerprint polling，不做持续全树内容扫描。
- 扫描按字节预算和文件数量分批执行，支持 cancel/backpressure；终端 PTY 和 Hook 事件优先级高于历史索引。
- 本地 detail LRU 建议默认 10-20 个会话或 64MB；远端 Agent 索引默认 128MB，`history-catalog.db` 内 SSH 派生行默认预算 256MB，均可在设置页按主机/source instance 清理。
- App 启动不连接全部 SSH 主机；全局历史分析默认使用缓存，只有用户刷新时按并发上限同步远端。

### 10.8 SSH 会话恢复

远端恢复不是本地 `cwd + resumeCommand` 的复用，而是独立的结构化流程：

```text
History session selection
  -> resolve remote identity
  -> Agent resume preflight over existing bridge
  -> choose exact SSH project or original remote location
  -> create interactive SSH PTY
  -> inject binding/config-root env
  -> run native Claude/Codex resume command
  -> Hook returns same cliSessionId and binds realtime stats
```

建议协议：

```text
RemoteResumeDescriptor {
  hostId,
  installationId,
  remoteMachineId,
  sshUser,
  source,
  cliSessionId,
  configRoot,
  remoteCwd,
  remoteFileRef,
  projectId?,
  parserVersion,
  indexedAt
}

RemoteResumePlan {
  descriptor,
  targetProjectId?,
  useOriginalRemoteLocation,
  initializationCommand?,
  environmentOverrides,
  sourceCliArgs,
  terminalTabId,
  clientInstanceId
}
```

恢复前置校验：

1. `source` 必须是 Claude/Codex，sessionId 非空且满足长度/字符边界。
2. 当前 SSH Host 必须仍指向 descriptor 的 installationId/remoteMachineId/SSH user。
3. Agent 在对应 config root 中确认原始 session 存在、可读，并返回最新 cwd/source/sessionId。
4. remote cwd 必须是安全绝对 POSIX 路径且可进入；路径已移动时不能静默改用项目根目录。
5. 同一 `host + source + sessionId` 若已有本客户端活跃绑定，直接跳转已有 Tab。
6. 若另一个 clientInstanceId 正在运行同一 session，首期返回 `remote_session_active_elsewhere` 并阻止并发 resume。
7. 子 Agent transcript、只读收藏快照、已删除源文件或 source 转换结果不直接支持 resume；只能恢复父会话的原始远端 source。

项目选择：

- 精确匹配 `sshHostId + remotePath/configured/canonical cwd` 时自动使用该 SSH 项目。
- 多个同 Host 项目匹配时，选择框只展示同一 SSH Host 的 SSH 项目，不显示 local/WSL 项目。
- 无项目匹配但 Host/机器身份有效时，提供“使用原远端目录”，创建无项目 SSH terminal；不使用当前本地“使用新窗口”的本地路径语义。
- Host 配置已删除时，允许进入“重新绑定 SSH Host”流程，但新 Host 必须通过 Agent 验证原 session/config root 后才能继续。
- 用户显式选择不同 remote cwd 时必须警告“在不同目录恢复”，首期默认不提供自动改目录恢复。

命令和启动边界：

- Claude 使用 `claude --resume <sessionId>`；Codex 使用版本适配器生成受支持的 `codex resume <sessionId>` 形式。
- Resume 命令替换项目普通 startup command，不能先执行另一个 Claude/Codex 启动命令再 resume。
- SSH Host initialization command 和普通项目环境变量可继续应用；provider override 永远为空。
- config root 通过安全环境注入传递；sessionId、cwd 和 CLI args 由 Rust/Agent 专用构建器引用，前端不拼 shell 字符串。
- 自定义 CLI wrapper 只有通过 capability probe 声明支持 resume args 时才可用，否则回退标准 `claude`/`codex` 或显示 unsupported。

连接和降级：

- preflight、session ownership 和历史校验复用该 Host 现有 bridge。
- 创建恢复终端必然新增一条交互式 SSH PTY，这是实际会话连接，不是历史查询连接。
- Hook 未安装不阻止 resume，且恢复会话已有确定 `sourceSessionId`，可由 Agent transcript tail 继续提供 Token snapshot；生命周期/审批通知显示 Hook unavailable。新建且未知 sessionId 的普通 CLI 会话在没有 Hook 时只能显示项目级或候选统计，不能承诺精确绑定当前 Tab，直到 Agent 唯一识别 transcript 或用户安装 Hook。
- Agent 暂时不可用但有可信缓存时，可提供显式“尝试恢复”降级：只在 Host identity 未变化时创建 PTY，让远端 CLI 自己报告 session not found；默认仍优先要求 preflight。
- 远端原始 session 已删除时，不根据本地收藏快照重建远端 JSONL，首期返回 `remote_session_source_missing`。

## 11. 实时统计和历史用量

### 11.1 数据源优先级

1. Agent 内置 transcript parser：基线和实时权威来源。
2. Hook：会话生命周期、sessionId、reasoning effort 和事件绑定，不是 Token 权威。
3. 远端 `ccusage`：可选校验/历史报表 provider，缺失时不影响核心统计。

### 11.2 实时策略

- 活跃 Tab：文件变化后增量解析，最多每 2 秒推一次 snapshot；UI 250-500ms 节流。
- 非活跃 Tab：暂停高频推送或降为 15 秒。
- 5-10 秒无变化时只发送轻量 heartbeat/asOf，不重复完整 payload。
- snapshot 包含 `cliSessionId`、`indexGeneration`、`parserVersion`、`partial`、`asOf`。
- 本地继续使用模型价格表估算 cost，保证本机/WSL/SSH 价格来源一致。
- CLI-Manager 不读取远端 provider/endpoint/价格。自定义供应商与本地价格表无法匹配时只显示 Token，并计入 unpriced tokens；不得用模型名反推供应商。

### 11.3 历史分析

- Agent 生成 session/daily usage facts，本地按主机/项目/时间范围合并。
- 用户查看全局分析时默认先呈现缓存，再显示每个远端主机同步状态。
- 刷新任务可取消；单主机只运行一个扫描，重复请求共享同一 future/result。
- 服务器未连接不会阻塞本地统计；最终结果标记包含哪些主机未刷新。

### 11.4 供应商能力边界

SSH 环境的 Agent 能力集合固定不包含：

```text
providerList, providerProbe, providerSwitch,
providerReset, providerModelTest, providerConfigSync
```

- `resolveProjectCapabilities(ssh)` 对 `providerSwitch` 永久返回 false，不能因为 Agent 已安装、Hook 已安装或统计可用而开启。
- 项目树、Tab 菜单、批量项目操作、命令面板和 SSH 项目编辑页不显示供应商选择/切换/重置入口。
- local/WSL/SSH 混合批量选择时，provider 操作整体禁用并说明原因；不得静默只修改 local/WSL 子集。
- “设置 -> 供应商”只调用本机/显式 WSL `ccswitch_*` commands；不枚举 SSH hosts，不启动 bridge，不读取远端 `~/.cc-switch` 或 Claude/Codex provider 配置。
- SSH Terminal Launch Plan 的 `claudeProvider` / `codexProvider` 必须为 null；若同步/旧数据库残留 `provider_overrides`，在能力路由和 Rust 启动边界双重忽略，并在下一次 SSH 项目编辑/导入时清理。
- 用户手工填写的 SSH 项目环境变量仍按普通远端环境变量处理，不由 CLI-Manager 解析为 provider；provider-like key 不从本机供应商设置自动填充、不进入 provider UI、不随 SSH Host 扫描，也不转换成 provider 数据；其存储/同步沿用现有项目环境变量策略。
- 项目从 local/WSL 切换到 SSH 时清空 provider override；从 SSH 切回 local/WSL 时重新按本地能力计算，不能恢复或推断远端 provider。
- Agent 协议不存在 provider RPC。任何未知/未来客户端发来的 provider request 返回 `unsupported_capability`，不得透传 shell 执行。
- Agent 安装的 Hook 只负责生命周期桥接，不与远端 cc-switch common_config/provider 数据库联动。远端其他工具重写 Hook 导致丢失时，状态显示 `conflict/outdated`，由用户显式重装；不会为保护 Hook 而扫描 provider 数据库。
- 统计仅消费 transcript 中显式 model/usage；自定义 provider 未知不会出现在供应商设置，只按本机模型价格表计算或标为 unpriced。

## 11A. 远端项目文件侧边栏

### 11A.1 产品边界

“打开项目文件夹”在 SSH 项目中表示打开 CLI-Manager 内部文件侧边栏，而不是调用本机 Explorer/Finder：

| 能力 | SSH 首期 |
|---|---|
| 目录树懒加载 | 支持 |
| 刷新/折叠/展开 | 支持 |
| 文件名搜索 | 支持，Agent 远端查询 |
| 内容搜索 | 可选受限能力，按 size/result 上限 |
| 文本/图片预览 | 支持，按需分块 |
| 复制远端路径 | 支持 |
| 从历史/Diff 定位文件 | 支持，使用 RemoteFileRef |
| 创建/重命名/删除/移动/粘贴 | 首期不支持 |
| 保存编辑 | 首期不支持，只读编辑器 |
| Git 状态/Diff/分支 | 由独立 SSH Git 面板只读支持 |
| Git Stage/Commit/Checkout/Network/Worktree | 首期不支持 |
| 本机 Explorer/Finder 打开 | 不支持 |

现有单一 `files` capability 需要拆分：

```text
filesBrowse, filesRead, filesSearch, filesWatch,
filesWrite, filesDelete, filesMove, filesOpenExternal
```

SSH 首期只开启 browse/read/search/watch；UI 隐藏写操作，store/backend 同时硬拒绝。

Git capability 独立拆分，不能因为 `gitRead=true` 就放开当前 Git 面板的全部操作：

```text
gitReadStatus, gitReadDiff, gitReadBranches, gitWatch,
gitIndexWrite, gitCommit, gitWorktreeWrite,
gitNetworkFetch, gitNetworkPush, gitDestructive
```

SSH 首期只开启 `gitReadStatus/gitReadDiff/gitReadBranches`；`gitWatch` 根据 Agent watcher 能力单独探测，其余全部为 false。

### 11A.2 Provider 与协议

```text
FileProvider
  LocalFileProvider
  WslFileProvider
  SshFileProvider(hostId, installationId, projectId, remoteRoot)

RemoteFileRef {
  hostId, installationId, projectId,
  rootId, relativePath, kind, size, mtime,
  fileId?, symlinkTarget?, contentVersion?
}
```

Agent RPC：

```text
file_list, file_stat, file_read, file_search,
file_watch_start, file_watch_stop, file_changed
```

- 所有请求复用 host bridge，不启动新的 SSH。
- RPC 只接收 rootId + relativePath，Agent 在远端 canonicalize；禁止客户端提交任意绝对路径。
- symlink 默认只能展示；解析后逃出 project root 时禁止读取/进入，并显示安全状态。
- remote file ref 永远不能传给 `open_folder_in_explorer`、本地 file commands 或 local Git APIs。

### 11A.3 加载与性能

- 打开侧边栏只请求根目录第一层，不递归扫描。
- 展开目录时分页加载；超大目录显示继续加载，不一次返回全部条目。
- 只 watch 当前展开/可见目录，单主机 watch 数有上限；不可用时低频 fingerprint polling。
- 文本预览按 chunk/size limit 读取；大文件先显示 metadata 和手动加载选项。
- 图片/二进制按 MIME/大小限制读取，禁止把任意远端文件注册成本地 asset path。
- 目录 metadata 可短期缓存；文件内容默认只进内存 LRU，不持久化完整项目副本。
- bridge 断线时可显示最后目录结构的 stale 状态，但新文件内容必须重连后读取。

### 11A.4 与历史恢复联动

- 从 SSH 历史详情点击变更文件时，使用 RemoteFileRef 在同 Host 的文件侧边栏定位/预览，不调用本地 opener。
- 恢复远端会话后，文件侧边栏默认绑定恢复计划的 target project；无项目“使用原远端目录”会创建临时 remote root，只读浏览该 cwd。
- Host/installation identity 变化时，历史详情、恢复和文件侧边栏必须同时失效旧 RemoteFileRef。

## 11B. SSH 只读 Git 面板

### 11B.1 产品能力

当前 Git 面板不是单纯查看器，它同时包含 status/Diff、stage/unstage、commit、discard、删除 untracked、分支切换、Smart Checkout、fetch/push/pull、冲突中止和 hunk/line revert。SSH 不能直接把现有单一 `git` capability 打开。

首期 SSH Git 面板能力：

| 能力 | SSH 首期 |
|---|---|
| 根仓库/受限深度嵌套仓库发现 | 支持 |
| tracked/staged/untracked/conflict 状态 | 支持 |
| 增删行统计、单文件 Diff | 支持，受字节/行数上限 |
| 当前分支、upstream、ahead/behind | 支持 |
| 已有本地/远端 refs 列表 | 支持，不自动 fetch |
| 点击变更文件 | 使用 SshFileProvider 只读打开 |
| stage/unstage/commit | 不支持 |
| discard/delete untracked/hunk revert | 不支持 |
| checkout/create branch/Smart Checkout/stash | 不支持 |
| fetch/push/pull/rebase/abort | 不支持 |
| Worktree snapshot/restore/fork | 不支持 |

“远端分支列表”只表示当前仓库已经存在的 remote-tracking refs；由于首期没有 fetch，它不承诺是服务器最新状态。

### 11B.2 Provider 与引用模型

现有 `gitStore`/`GitChangesPanel` 以本地 `projectPath: string` 调用 Tauri Git commands，并会联动本地 file store。需要改为 typed target 和 provider：

```text
GitProvider
  LocalGitProvider
  WslGitProvider
  SshGitProvider(hostId, installationId, projectId, rootId)

GitTargetRef {
  environment, projectId,
  localPath?,
  hostId?, installationId?, rootId?, repoId?
}

RemoteGitRepoRef {
  hostId, installationId, projectId,
  rootId, repoId, relativeRoot,
  worktreeIdentity, gitDirIdentity,
  headOid?, generation, gitVersion
}
```

`repoId` 由 Agent discovery 产生，客户端不能把任意绝对目录当仓库提交。项目根下嵌套仓库使用 `relativeRoot`；Git Worktree 的 `.git` file 可以指向项目根外的 common dir，但 Agent 必须确认 worktree root 是已授权 root/子仓库、目标由 Git 自己解析且属于当前 SSH 用户，不能把 common dir 变成通用文件访问入口。

### 11B.3 Agent RPC 与执行边界

首期协议：

```text
git_probe
git_list_repositories(rootId)
git_get_changes(repoId, generation?)
git_get_file_diff(repoId, relativePath, status, expectedGeneration?)
git_branch_status(repoId)
git_list_branches(repoId)
git_subscribe(repoId) / git_unsubscribe(repoId)
```

- RPC 是固定结构，不接受 shell 字符串、任意 argv、环境变量或 Git config 覆盖。
- Agent 使用远端系统 Git 和固定 allowlist 生成命令；首期不复用桌面端 libgit2，因为仓库和文件都在远端。
- status 使用稳定的 NUL 分隔 porcelain 格式并返回结构化 DTO；分支名、rename path、Unicode 路径不能依赖换行切割。
- 只读命令设置 `GIT_OPTIONAL_LOCKS=0`；Diff 使用 `--no-ext-diff --no-textconv`，避免执行仓库配置的 external diff/textconv。命令设置 timeout、stdout/stderr 上限、状态条目和 Diff 字节/行数上限。
- 不自动执行 `git config --global --add safe.directory`。遇到 dubious ownership 返回可诊断状态，由用户在远端终端自行确认/处理。
- 首期不运行任何需要远端网络凭据或交互提示的 Git 命令，不读取 credential helper 输出，不转发本机 SSH key/token。
- 每次响应包含 repo generation、HEAD OID 和 `asOf`；面板对 stale generation 的 Diff 重新刷新，不把旧 Diff 当当前工作区结果。

### 11B.4 刷新与性能

- 打开 Git 面板复用现有 host bridge；每个状态/Diff 请求不创建 SSH。
- 面板可见时订阅 repo changes；Agent watcher 对 worktree 和必要 `.git` metadata debounce 后只发 invalidation，不持续推送完整 status。
- watcher 不可用、NFS/overlayfs 或仓库过大时降级为面板可见期间的低频 status polling；隐藏、失焦或关闭后停止。
- 同一 repo 的并发 refresh 合并为一个任务，Diff 请求有每主机并发上限；Git 扫描优先级低于 PTY、Hook 和实时统计。
- 本地只缓存最近 status/branch metadata 和少量 Diff 内存 LRU；不持久化整个远端仓库、对象库或工作区。

### 11B.5 后续写能力边界

后续开放顺序建议为：`stage/unstage` -> `commit` -> `checkout/create branch` -> `fetch` -> `pull/push` -> destructive/revert。每一级都必须独立 capability、用户确认、expected HEAD/index/worktree fingerprint 和审计。

commit 还需要处理远端 user.name/email、commit signing 与无 TTY 签名提示；fetch/push/pull 还需要处理远端 credential helper、SSH agent、MFA、冲突和取消。它们不应作为只读 Git 面板上线的前置条件。

## 12. 系统兼容设计

### 12.1 首期正式支持

| 客户端 | 远端 | Agent target | 说明 |
|---|---|---|---|
| Windows 10/11 x64 | Ubuntu/Debian/RHEL 系 x64 | `x86_64-unknown-linux-musl` | 主验收组合。 |
| Windows 10/11 x64 | Linux arm64 | `aarch64-unknown-linux-musl` | 需要真机 CI/验收。 |
| Windows 10/11 x64 | Alpine x64/arm64 | musl target | 需验证文件监听与 CLI 可用性。 |

### 12.2 设计兼容、后续开放

| 远端 | 难点 |
|---|---|
| macOS x64/arm64 | 签名/公证、LaunchAgent 非基础依赖、默认 shell 和目录。 |
| Windows Server/Windows 11 SSH target | PowerShell/cmd 默认 shell、路径引用、exe 文件锁、Defender/ExecutionPolicy、named pipe。 |
| 非 glibc/极简 Linux | noexec、缺少标准 shell/证书、只读 HOME、无持久状态目录。 |

### 12.3 明确不支持状态

- 仅 SFTP、禁止 exec 的账号。
- 用户目录禁止执行且没有可用替代目录。
- 32 位/未知架构。
- SSH 服务禁止所有非 PTY exec channel。
- 没有可访问的 Claude/Codex 配置目录。
- 多个远端用户共享同一 Hook 配置但要求跨用户汇总。
- `sudo`/`su` 后切换用户运行 Claude/Codex、容器内 CLI、远端 tmux/screen 长期会话自动接管。
- 远端配置目录位于当前用户不可安全读取的 NFS/只读/跨权限路径。

## 13. 安全边界

- 继续由系统 OpenSSH 管理 Host Key，禁止自动设置 `StrictHostKeyChecking=no`。
- Agent 不监听公网端口；bridge 只走 SSH stdio，Hook IPC 只允许同一远端用户。
- bridge 每次启动生成 epoch/nonce，远端 IPC 目录和 socket 权限限制为当前用户。
- 安装 manifest 必须签名；SHA-256 只负责完整性，不能替代签名。
- Agent 安装、Hook diff、doctor 日志不得包含密码、私钥、passphrase、代理凭据、Prompt 或响应正文。
- Hook spool 默认保存结构化生命周期数据；Prompt/终端输出不进入 spool。
- 第三方通知不得包含远端绝对路径、remote transcript ref、SSH host/user、session/tab id 或 Prompt。
- 历史缓存属于敏感本地数据，默认不进入 WebDAV/导出；未来开放同步需要独立产品确认。
- 所有远端路径在 Rust/Agent 边界验证，禁止 NUL/CR/LF、相对路径和 `..` 逃逸。
- Git RPC 不接受任意 argv/shell/config；repoId/rootId 由 Agent discovery 产生。首期禁用 external diff/textconv、global config 写入、credential/network 和全部 mutation。
- Git status/Diff 可能包含源码与路径，只在现有 SSH 加密通道内返回，默认不进入 SQLite、WebDAV、Hook spool 或诊断日志；本地仅保留有界内存缓存。
- 协议有最大帧、分页、超时、取消和速率限制，避免远端恶意/损坏 Agent 耗尽本地内存。

## 14. 状态与错误模型

Agent：

```text
notInstalled | installing | installed | outdated |
incompatible | corrupt | unreachable | unsupported
```

每工具 Hook：

```text
disabled | notInstalled | partial | installed |
outdated | conflict | unreadable
```

bridge：

```text
idle | connecting | authenticating | connected |
reconnecting | disconnected | failed
```

数据 freshness：

```text
live | fresh | stale | partial | unavailable
```

Git：

```text
available | gitMissing | versionUnsupported | notRepository |
dubiousOwnership | scanning | fresh | stale | partial | unavailable
```

所有错误返回稳定 code + 中英文 UI 映射；底层 stderr 只进入脱敏日志。

## 15. 多窗口、分屏和恢复

- bridge 属于 daemon/主机连接池，不属于某个 React 组件或窗口。
- Hook 广播到多个窗口时，只有拥有 `terminalTabId + bridgeEpoch` 的窗口处理绑定事件。
- 同一主机多 Tab 共用 bridge，但统计严格按 cliSessionId 隔离。
- 同一远端用户的多条 SSH Host 配置与多个 CLI-Manager 客户端按 `hostId + clientInstanceId + installationId` 隔离 bridge/spool；不同 SSH 用户仍由各自 Agent installation 隔离历史和 Hook。
- 窗口关闭或 Tab 隐藏只取消该订阅，不关闭仍被其他 Tab/窗口使用的 bridge。
- App/daemon 重启后重新建立 bridge，使用 cursor 补发 Hook/历史；不得重启仍存活的远端 Claude/Codex。
- 已退出 PTY 只恢复 replay/断开信息；历史仍可从 Agent/缓存查看。

## 16. 数据库与同步

Agent 生命周期可新增本地元数据表，不存秘密：

```text
ssh_agent_installations(host_id, installation_id, agent_version,
  remote_machine_id, protocol_version, target, install_path, status, checked_at)

ssh_host_tool_preferences(host_id, source, configured_root, updated_at)

ssh_agent_tool_integrations(integration_id, host_id nullable, installation_id,
  remote_machine_id, ssh_user, source, scope_kind, configured_root,
  canonical_root, config_root_hash, hook_record_json, history_source_instance_id,
  validation_state, cleanup_state, checked_at)
```

Host 主 config root 保存到 `ssh_host_tool_preferences`，缺少记录或 configured root 为空即使用远端 SSH 用户默认目录；这样无需在 `ssh_hosts` 重复 Claude/Codex 专用列，也不会在用户改路径时覆盖旧 Hook 安装记录。SSH 项目增加可选 `cli_config_root`，仅作用于该项目选择的 Claude/Codex。运行状态和 per-root 安装记录统一进入 `ssh_agent_tool_integrations`，不把 Hook 指纹/远端 machine identity 塞进通用项目 JSON，也不存任何凭据。

远端历史 cursor/cache/freshness 进入现有 `history-catalog.db` v2 的 remote source instance/state，不创建 `ssh_remote_cursors` 或 `ssh_remote_cache_meta` 竞争表。Git status/branch/Diff 默认只保存在 store 与有界内存 LRU，不写 SQLite；仅持久化用户面板偏好或最后选择的 repoId 时也必须绑定 installation/root identity，并允许失效重建。

SSH Host 删除采用“本地解绑，不触碰远端”的语义：存在活动 PTY/bridge 消费者或被其他 Host 作为 jump target 时阻止删除；否则删除本地 Host/credential，保留 SSH 项目及 `remotePath` 并把 `sshHostId` 置空，项目进入重新绑定状态。Agent/Hook 不远程卸载，历史 source/cache/snapshot 保留并标记 `hostDeleted/unbound`，用户重新绑定并通过 installationId/remoteMachineId/user 校验后才可复用。

跨设备同步：

- 可同步“某项目需要 SSH Agent/Hook 能力”的偏好。
- 不同步 installation id、绝对安装路径、socket、host credential、缓存、spool 或远端历史正文。
- 不同步 SSH 项目的 provider override；导入 SSH 项目时强制清空 provider/worktree machine-specific fields。
- 新设备导入后必须重新绑定 SSH Host 并重新探测 Agent。

## 17. 发布和版本策略

- Agent 与桌面应用独立版本，但 manifest 声明协议兼容区间。
- 协议使用 major/minor：major 不兼容立即拒绝；minor 通过 capabilities 降级。
- CI 构建目标至少包括 Linux x64/arm64；macOS/Windows target 在产品开放前加入签名与真机验收。
- 发布物包含签名 manifest、制品、SHA-256、SBOM/provenance（建议）。
- 设置页显示 desktop version、agent version、protocol、parser version 和更新来源。

## 18. 文档落地

方案批准并进入实现后同步：

- `README.md`、`README.zh-CN.md`、`README.en-US.md`：SSH 远程项目、Agent 安装、Hook/历史/统计、只读文件/Git 面板、连接模型，以及“不支持供应商切换/供应商设置不扫描 SSH”的限制。
- `CHANGELOG.md` `[TEMP]`：按实际完成阶段记录，不提前把设计能力写成已发布功能。
- `docs/功能清单.md` 的 2.5 继续描述“当前已交付 SSH 终端 MVP”，不能直接把规划覆盖成已发布；方案批准但未实现时只新增 Roadmap/“规划中”小节，实现后再迁入正式功能章节。
- 功能清单的 SSH 规划小节必须覆盖 Agent install/upgrade/status/doctor/uninstall、桌面上传与签名 HTTP(S) 安装、每主机一条 bridge、Claude/Codex Hook 独立安装、远端 History Source/cache/freshness/offline、RemoteResumePlan、实时/历史统计、只读文件侧边栏、只读 Git 面板和供应商排除边界。
- 功能清单的 Hook 章节要区分本机 loopback Hook 与远端 Agent 用户级 IPC；历史章节要区分 local/WSL 可写行为和 SSH 首期只读/在线详情；恢复会话中“继承供应商切换参数”明确仅适用于 local/WSL。
- 功能清单的设置、数据层和安全章节补齐当前 master 已有的“SSH 主机”“历史来源”、`history-catalog.db` v2、`history_source_instances`、sessionRef/rawPointers、派生索引不参与同步，以及 Agent 签名/Host Key/rootId+relativePath/remote identity 安全边界。
- 功能清单覆盖总览拆分“SSH 远程终端（已交付）”与“SSH Agent/Hook/历史/统计/只读文件/Git（规划中）”；兼容矩阵明确 Linux x64/arm64 正式目标和 Windows target、SFTP-only、noexec、sudo/su/container/tmux/screen 的不支持/降级状态。
- 设置页 zh-CN/en-US 文案；时间继续使用 24 小时制。

## 19. 回滚策略

- 桌面端功能开关可停止建立新 bridge，但保留 host/agent 元数据。
- Agent 升级失败自动切上一版本。
- Hook 安装 journal/备份支持只恢复本 Agent 写入；绝不覆盖安装后用户的新修改。
- 远端历史/统计不可用时回退为缓存只读，不回退到本地路径扫描。
- 远端 Git capability 可独立关闭；关闭后隐藏 SSH Git 面板并清理内存 status/Diff，不影响终端、文件或远端仓库内容。
- 协议变更保持旧 minor 能力降级；major 不兼容时阻止连接并显示升级指引。

## 20. 方案验收结论

该设计把服务器额外连接控制为“每活跃主机一个 bridge + 用户实际打开的 PTY 数”，历史、统计、文件和 Git 查询不会按 UI 请求数量放大连接；Hook 即使桌面端离线也只做本地 spool，不依赖公网回连。Agent、Hook、历史、统计、只读文件和只读 Git 能力相互独立探测，可逐阶段交付和回滚。
