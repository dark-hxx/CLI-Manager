# SSH 远程 Claude/Codex Agent、Hook、历史与统计集成方案

## Changelog Target

`[TEMP]`

## Agent 命名

远端组件正式名称为 `cli-manager-ssh-agent`。它是部署在 SSH 目标主机上的轻量无 UI 进程/命令，不安装完整 CLI-Manager 桌面应用。

## Goal

让 SSH 远程项目中的 Claude/Codex 成为 CLI-Manager 的一等会话来源：保留现有终端与 Tab 体验，并以安全、可恢复、低连接开销的方式接入 Hook 通知、会话历史、历史用量分析和当前 Tab 实时统计。

## Confirmed Facts

- SSH 远程终端使用本地 OpenSSH 进程作为 PTY 根进程；远端 Claude/Codex 实际运行在目标主机。
- 当前 Hook listener 绑定本机回环地址，Hook 客户端依赖环境变量中的端口/token；远端 `127.0.0.1` 不能直接访问桌面端 listener。
- 当前历史解析与 `history_get_stats` 面向本机/WSL 文件根目录；当前 `ccusage` 运行目标不包含 SSH。
- Windows 版本的 `cli-manager.exe __hook` 不能直接作为 Linux/macOS 远端 Hook 可执行文件。
- SSH 项目身份必须使用 `sshHostId + normalized remotePath`，不能把远端路径当成本地路径传入文件、Git、历史或统计 API。
- 用户要求本次同时形成详细方案、功能边界、系统兼容矩阵、远端 Hook 安装策略、连接/缓存/性能策略，并更新 README、CHANGELOG `[TEMP]` 和 `docs/功能清单.md`。

## Product Requirements

### 1. Remote Agent

- 远端 Agent 支持 `install`、`upgrade`、`status`、`doctor`、`uninstall`、`hook`、`bridge`、`history`、`stats`、`file`、`git` 子命令或等价版本化 RPC。
- Agent 安装到用户目录，不要求 root，不覆盖系统 OpenSSH/Claude/Codex。
- 安装入口位于“设置 -> SSH 主机 -> 目标服务器 -> CLI 集成”，保存或测试 SSH 主机时不得自动安装。
- 支持由 CLI-Manager 通过 SSH 上传/安装，也支持用户在远端通过 HTTP 拉取官方安装脚本完成安装；两种路径必须使用同一制品、校验和、签名和版本清单。
- 本地通过独立的非 PTY SSH 控制通道与 Agent 通信；交互式终端 SSH 连接与 Agent 控制连接分离。
- 控制协议必须有版本协商、能力探测、序号、确认、超时和断线重连语义。
- Agent 版本与目标主机系统/架构不匹配时，不得安装或不得宣称能力可用。

### 2. Hook

- 支持 Claude 与 Codex 的已安装 Hook 模块；保持现有统一事件模型、通知、Tab 状态、审批状态和子 Agent 事件。
- Hook 事件必须附带 `hostId`、远端项目身份、远端 CLI session id、事件 id 和远端路径；不得把远端路径当作本地文件路径处理。
- Hook 安装不得在用户仅保存 SSH 主机时静默修改远端全局配置；安装/升级/卸载必须有明确入口、状态、预览和失败诊断。
- Agent 内置 Hook 执行能力；用户在 SSH 主机设置页分别选择安装/启用 Claude Hook 和 Codex Hook，项目首次启动不得隐式写入 Hook 配置。
- 安装必须原子更新、保留第三方 Hook、支持仅安装 Claude 或仅安装 Codex，并能检测“未安装/部分安装/版本过期/配置冲突”。
- Hook 进程必须快速退出；Agent/控制通道不可用时，Hook 不得阻塞或影响 Claude/Codex，可进入有界远端 spool 并在重连后补发。

### 3. Session History

- 支持远端 Claude/Codex 原生历史目录的列表、搜索、详情、消息、工具调用、子 Agent、Diff/文件变更和会话关联。
- 历史解析在远端执行或通过远端增量读取完成；禁止全量复制历史目录或把远端路径传入本地文件 API。
- 远端历史必须复用现有 `HistorySourceDescriptor`、`sourceInstanceId`、`HistorySessionRef` 和 `rawPointers` 契约；稳定会话身份为 `(sourceId, sourceInstanceId, sourceSessionId)`，不得继续以 `hostId + remotePath + file_path` 作为主键。
- SSH source instance 由 SSH 主机的 CLI 集成配置管理，可与本机/WSL Claude/Codex source instance 及其他 SSH 主机实例同时存在；不得新增 `ssh-claude` / `ssh-codex` 来源 id。
- 桌面端派生缓存必须写入现有 `history-catalog.db` v2，按 source instance 隔离并标记 fresh/stale/disconnected/asOf/materialization；不得新增第二个本地 SSH 历史 SQLite。
- 远端 Claude/Codex 原始 JSONL 始终是事实源；CLI-Manager 默认不完整复制远端历史目录。
- Agent 可在远端保存可重建的派生索引：文件指纹/游标、会话摘要、有限搜索文本、usage facts 和删除 tombstone；不得把原始 JSONL 改写为第二份长期事实源。
- 同一远端用户的多个 CLI-Manager 客户端共享同一个 `(source, configRootHash)` 派生索引，但不能并发重复全量扫描：Agent 使用跨进程文件锁/租约保证单写多读，其他 bridge 复用 generation 或排队。Hook socket/spool 和活动 session ownership 仍按 clientInstanceId 隔离。
- 本地 `history-catalog.db` 对 SSH source instance 默认只保存会话摘要、截断标题/预览、usage/daily facts、freshness 和同步游标；完整消息/工具/Diff 详情默认只进内存 LRU。离线时只承诺列表、摘要和已同步统计，不承诺全文搜索、完整详情或 Diff。
- 只有“收藏快照”或未来用户显式选择“离线保存”时，才允许在本地持久化完整标准化会话详情，并明确显示来源、快照时间和占用空间。
- SSH 历史会话支持“恢复会话”：必须恢复到同一远端机器、SSH 用户和 config root，不得将远端 cwd 传给本地/WSL terminal。
- 恢复前复用 Agent bridge 校验 sessionId、source、config root、原始会话和 cwd；随后创建新的交互式 SSH PTY 执行 Claude/Codex 原生 resume，历史查询本身不新增 SSH 连接。
- 同一远端 session 已在当前客户端运行时跳转已有 Tab；被另一个客户端占用时首期阻止并发恢复。
- 项目缺失但 Host/远端机器身份仍有效时，允许“使用原远端目录”创建无项目 SSH terminal；Host 丢失或机器变化时必须重新绑定验证。
- 收藏/离线快照不等于可恢复源；远端原始会话已删除时只能查看快照，不能自动上传或 resume。
- 自定义 `CLAUDE_CONFIG_DIR` / `CODEX_HOME` 必须随恢复计划安全注入。
- 首次打开某 SSH 主机历史时允许按需建立该主机唯一 Agent bridge；后续列表/详情/统计复用同一 bridge 或 `history-catalog.db` 缓存，不为每个 UI 请求新建 SSH 进程。
- 连接断开时可查看最近缓存；明确显示数据时间和“远端不可达”状态，重连后按游标增量同步。

### 3A. Remote History Location

- 远端历史读取位置与 Agent 安装目录、Hook 是否安装彻底分离。Agent 安装目录只用于执行 bridge/hook binary，不能作为 Claude/Codex 历史根目录。
- 路径模型明确区分三项：`agentExecutablePath`、`cliExecutable/command`、`toolConfigRoot`。Agent 自定义安装位置或 Claude/Codex 自定义二进制位置都不改变 Hook/历史位置；只有 `CLAUDE_CONFIG_DIR`/`CODEX_HOME` 对应的工具配置根目录才决定 Hook 配置与历史来源。
- 每一条 SSH Host 配置都独立保存 Claude 和 Codex 的 `toolConfigRoot`，入口为“设置 -> SSH 主机 -> 目标主机 -> CLI 集成”。新建主机默认使用当前远端 SSH 用户 HOME 下的标准目录：Claude `$HOME/.claude`，Codex `$HOME/.codex`；UI 显示 Agent 解析后的绝对路径，例如 `/home/dev/.claude`。
- 每个工具首期只提供一个可编辑的“CLI 配置目录（Hook 与历史）”，支持恢复默认值、选择远程目录或填写自定义绝对 POSIX 路径。不得在首期暴露彼此独立的 Hook root 与 history root 输入。
- 用户只配置 config root，不配置 `projects`、`sessions`、`history.jsonl`、`state_5.sqlite` 等派生文件。Agent adapter 按 source/version 从根目录发现实际制品。
- Claude adapter 从 config root 派生 `projects/**/*.jsonl` 及当前版本支持的 transcript/session index 制品；Codex adapter从 config root 派生 `sessions/**/*.jsonl`、`history.jsonl`、`session_index.jsonl`、`state_5.sqlite` 等当前版本支持的混合制品。
- UI 在该唯一输入下分别只读展示 Agent 派生出的“Hook 配置文件”和“历史数据位置/制品摘要”。用户未安装 Hook 时仍可验证同一个 `toolConfigRoot` 并使用历史/统计。
- `toolConfigRoot` 验证成功后即可独立注册 remote History Source instance，不依赖 Hook 是否安装。通过 CLI-Manager 安装 Hook 成功后，Agent 必须返回 canonical config root 和实际读取/修改的配置文件清单，并与同一 config root 的 History Source 对账。
- Hook 安装状态与 History Source 状态在内部独立：卸载 Hook 只删除本 Agent owner 条目，不删除该主机已保存的 `toolConfigRoot`、History Source 或历史缓存。
- 路径优先级固定为：项目级显式 CLI config root -> 当前 SSH Host 的自定义 `toolConfigRoot` -> 当前 SSH 用户的标准默认目录。普通 startup command 中临时 `export` 的未知路径不猜测、不全盘扫描，要求用户显式配置。
- 同一 Host/SSH 用户可存在多个项目级 config root；每个不同的 `(machine, user, source, configRoot)` 注册为独立 remote `sourceInstanceId`，相同 root 的多个项目共享实例。
- Host 级 Claude/Codex 卡片始终只有一个可编辑主目录；项目级 config root 在项目设置中编辑，并在 Host 的 CLI 集成页以“项目覆盖目录”只读列表展示引用项目、Hook/历史状态和显式安装/卸载 Hook 操作。不得因项目覆盖而增加第二个 Host 主目录输入。
- 修改 Host 主目录或项目覆盖目录不得静默迁移/卸载旧目录 Hook，也不得重定向已运行 Tab。活动会话固定使用启动时捕获的 config root；新目录验证和首轮索引成功后仅影响新会话。旧目录若仍被项目/活动会话引用则继续保留；不再引用时进入可显式清理状态。
- 新路径采用两阶段启用：Agent validate/dry-run 返回 canonical path、权限、CLI/version、候选会话数和制品摘要；首轮索引成功后才激活。失败时保留旧实例和缓存，不把空扫描解释为远端删除。保存/验证路径不得创建目录；用户显式执行 Hook 安装时，预览确认后才允许创建缺失的标准默认目录和配置文件。
- 自动探测只检查确定的默认位置和显式环境/项目配置，不递归扫描整个 HOME、挂载盘或其他用户目录。
- HTTP/SSH 安装 Agent 使用自定义 `--install-dir` 时，installer 仍在标准用户 state 目录写入权限 0600 的 discovery record；桌面端通过该记录获得 canonical executable path，并执行 `version/status` 二次验证。用户也可在 SSH 主机 CLI 集成中显式填写 Agent 绝对路径。

### 4. Realtime Stats

- 当前 Tab 的 Hook 状态和实时 Token/模型统计必须支持 SSH 项目。
- 实时统计采用长生命周期 Agent 控制连接，不能每次刷新启动一次 `ssh` 或重复全量扫描。
- Agent 支持远端 transcript 增量解析并作为 Token 基线来源；若远端存在兼容的 `ccusage`，只作为可选校验/报表增强，缺失时不影响核心统计。
- 统计输出统一为现有前端模型：输入/输出/cache token、当前模型、上下文窗口、成本、reasoning effort、工具/子 Agent 用量和更新时间。
- Hook 事件只作为生命周期和会话绑定信号，不能假设 Hook 本身提供完整 Token 用量。

### 5. Connection, Cache and Performance

- 每个活跃 SSH 主机最多维护一个复用的 Agent 控制连接；交互式 PTY 连接按终端会话独立存在，历史/统计请求不得创建连接风暴。
- 非活跃 Tab 的实时统计可降频或暂停；历史面板关闭后不持续轮询详情。
- 控制通道支持心跳、指数退避重连、服务端不可用分类、连接上限和本地关闭时的优雅清理。
- 远端 Agent 对历史游标、Hook spool 和统计缓存设置大小上限、TTL 和磁盘配额，避免长期占用服务器资源。
- `history-catalog.db` 应记录远端 source instance 的最后同步游标、materialization 和时间，不缓存密码、私钥、代理凭据或远端安全凭据。
- 当前 v2 的“每个 source 仅一个 active instance”约束必须升级为 scope-aware activation：本机/WSL 用户配置仍保持单 active 选择，每个 SSH machine/user/configRoot scope 可独立 active；`historySourceSettingsStore` 不负责枚举或切换 SSH 实例。

### 6. Compatible System Categories

首期正式支持：

- Windows 客户端 + 远端 Linux x64/aarch64 + OpenSSH。
- 远端 Bash/sh，Claude/Codex 使用其原生配置目录。
- 终端支持 SSH Config、SSH Agent、私钥和交互式密码/MFA（密码不落盘）；Agent bridge 首期只正式支持可非交互完成的 SSH Config、Agent、私钥和有效 `credential_ref`，临时密码/多轮 MFA 需要前台重新认证且不承诺后台自动重连。

设计兼容但需要独立验证：

- macOS x64/arm64。
- Linux 非 glibc 发行版、BusyBox/极简容器、非 Bash 登录 shell。
- ProxyJump、ProxyCommand、跳板链路和网络断开重连。

首期不承诺：

- Windows 作为 SSH 目标主机的远端 Agent 二进制兼容。
- 无法执行用户目录二进制、无持久化目录、禁止 `exec`/端口转发的受限 SSH 账号。
- 仅有 SFTP、没有 shell 执行权限的账号。

### 7. Documentation

- README 增加 SSH 远程 Claude/Codex、Agent 安装、Hook、历史、实时统计、权限和不支持场景说明。
- `CHANGELOG.md` 的 `[TEMP]` 增加本次行为变化摘要。
- `docs/功能清单.md` 增加 SSH Agent、远端 Hook、远端历史、远端统计及能力限制。
- 新增用户可见文案必须同步 `zh-CN` 与 `en-US`。

### 7A. Remote Project Folder Sidebar

- SSH 项目支持通过侧边栏“打开项目文件夹”进入内部远端文件浏览器，根目录固定为项目 `remotePath`。
- 首期能力为只读：懒加载目录树、刷新、文件名搜索、文本/图片预览、复制远端路径和从历史/终端定位远端文件。
- 首期文件面板不支持创建、重命名、删除、移动、粘贴、拖拽、保存编辑、Worktree 文件操作或用本机 Explorer/Finder 打开远端 POSIX 路径；Git 状态由独立的 SSH Git 面板提供，不在 FileProvider 内执行。
- 远端文件操作通过 `SshFileProvider` 和现有 Agent bridge RPC 完成，不为每个目录/文件请求创建 SSH 进程，也不把 `remotePath` 传入本地文件 commands。
- 目录按展开节点懒加载并分页；文件内容按需分块读取，默认只进内存 LRU，不递归下载或持久化整个项目。
- Agent 在远端边界 canonicalize 并校验所有相对路径；默认阻止通过 symlink 逃出项目根目录。

### 7B. Remote Git Panel

- SSH 项目支持打开独立 Git 面板；Git 命令在远端由 `cli-manager-ssh-agent` 执行，复用该主机唯一 bridge，不调用本机 libgit2/Git，也不为刷新、Diff 或分支查询创建新的 SSH 进程。
- 首期为只读 Git 能力：仓库/嵌套仓库发现、工作区状态、staged/untracked/conflict 分类、增删行统计、单文件 Diff、当前分支、upstream、ahead/behind 和已有本地/远端分支列表。
- Git 面板点击文件时复用 `SshFileProvider` 打开远端只读文件；删除文件只显示 Diff，不尝试本地打开。
- 首期不支持 discard、删除 untracked、stage/unstage、commit、fetch、push、pull、checkout、创建分支、Smart Checkout、hunk/line revert、rebase continue、pull abort、stash 或 Worktree snapshot/restore。
- Agent 只允许版本化的结构化 Git RPC 和固定参数白名单，禁止前端传任意 argv/shell。所有 repo/file 参数使用 `rootId + repoId + relativePath`，Agent 校验仓库/worktree 边界、当前身份和 generation。
- 远端必须安装兼容 Git；缺失、版本过低、dubious ownership、仓库不可读或 Agent bridge 不可用时只禁用 Git 面板，不影响 SSH 终端和文件浏览。
- read-only Git 默认设置 `GIT_OPTIONAL_LOCKS=0`，Diff 禁用 external diff/textconv，限制执行时间、结果条数和 Diff 字节数；不得自动修改远端全局 `safe.directory` 或 Git 配置。
- Git 状态只在面板可见或存在显式订阅时刷新；优先使用 Agent watcher/debounce，能力不可用时低频 fingerprint/status polling，隐藏面板停止轮询。
- Git 远程凭据、SSH key、credential helper 输出和 access token 不传回、不缓存。后续若开放 fetch/push/pull，必须另行设计非交互认证、冲突恢复和审计边界。

### 8. Provider Boundary

- SSH 项目不支持 CLI-Manager 供应商切换，不显示项目/Tab/右键菜单中的“切换供应商”入口。
- “设置 -> 供应商”只管理本机及既有 WSL/provider 数据源，不连接、不扫描、不解析任何 SSH 服务器上的 cc-switch、Claude/Codex provider、API endpoint、profile 或密钥。
- `cli-manager-ssh-agent` 不提供 provider list/probe/apply/reset/switch RPC，也不读取远端供应商数据库。
- SSH 终端按远端用户已有的 Claude/Codex 配置、shell 环境和启动命令运行；CLI-Manager 不生成远端 provider settings/profile，不把本机 `provider_overrides` 或供应商密钥注入 SSH。
- 若旧数据/同步数据中的 SSH 项目带有 `provider_overrides`，运行时必须忽略并在编辑/导入时清理；不得因为字段存在而调用本机 provider API。
- 远端历史/统计可展示 transcript 中的模型名和 Token，但不得据此推断、注册或切换供应商。费用继续使用本机模型价格表估算；自定义远端供应商价格未知时计入未定价 Token。

### 9. Additional Review Boundaries

- Hook 配置虽然位于远端用户级 Claude/Codex 配置，但只有存在 CLI-Manager 注入的 client/tab/session 绑定环境时才上报；用户在普通 SSH、tmux 或其他终端启动的 CLI 不进入 Hook spool，不被误绑定到 CLI-Manager Tab。
- 同一远端用户允许多个 CLI-Manager 客户端存在，但 bridge/socket/spool 必须按 `clientInstanceId + installationId` 隔离；事件只送给启动该会话的客户端，不能广播给其他桌面端。
- 同一服务器不同 SSH 用户视为不同 Agent 安装、不同历史和不同缓存，禁止跨用户扫描。
- 历史默认只索引 CLI-Manager 已绑定的远端项目路径；“扫描该主机全部 Claude/Codex 历史”需要未来独立显式开关，首期不自动导入未管理项目。
- 首期远端历史为只读：支持列表、搜索、详情、Diff、收藏快照和同主机 resume；编辑、删除、插入消息、原文件还原和远端备份写回不在首期范围。
- 支持自定义远端 `CLAUDE_CONFIG_DIR` / `CODEX_HOME`，索引和 Hook 状态按 `hostId + source + configRoot` 隔离，不能假设每台服务器只有一套 `~/.claude` / `~/.codex`。
- Agent handshake 必须返回 `installationId`/远端机器身份；SSH Host 地址、用户名、Host alias 或远端机器发生变化时，旧缓存不得直接复用，必须标记 machineChanged 并要求重新确认。
- Hook/历史事件以 sequence/cursor 保序，远端时间只用于展示；Agent 统一发送 UTC 时间，doctor 检测明显时钟偏差，避免跨时区/时钟漂移导致乱序和日期统计错误。
- `sudo`/`su`、容器内 Claude/Codex、tmux/screen 持久会话、不同用户 HOME 和只读/NFS 配置目录不属于首期正式支持；检测到时明确降级，不跨权限边界扫描。
- UI 退出但 daemon 保留后台 PTY 时，host bridge 也由 daemon 持有；只有该主机没有后台 PTY、实时订阅、历史任务或待 ACK spool 时才进入 idle 关闭。
- 远端 Hook 触发的第三方通知继续使用安全摘要，不发送远端绝对路径、transcript ref、host/user、session/tab id 或 Prompt。

## Recommended Scope Boundary

本任务完成“方案设计与文档落地”，并定义后续实现的协议和阶段，不在未经批准的情况下直接实现完整远端 Agent 二进制、远端 Hook 修改或历史/统计生产代码。

建议后续实现分为：

1. Agent bootstrap/status 与版本协商。
2. Agent 控制通道和 Hook bridge。
3. 远端 History Source 与 `history-catalog.db` v2 增量派生数据。
4. SSH 只读文件侧边栏与 RemoteFileRef。
5. SSH 首期只读 Git 面板，包括 status、Diff 和分支信息。
6. 远端实时统计 adapter 与历史分析。
7. 多平台发行、升级、回滚和压力验证。

## Acceptance Criteria

- [ ] 形成并经用户确认 `design.md`，覆盖架构、协议、安装、Hook、历史、统计、缓存、性能、安全、恢复和回滚。
- [ ] 形成并经用户确认 `implement.md`，列出代码触点、实施阶段、验证命令、风险和提交边界。
- [ ] 形成系统/架构/认证/网络/窗口/分屏/Workspan/Hook 状态/断线/缓存等场景矩阵。
- [ ] 明确远端 Hook 是“按主机显式安装、按项目/会话绑定”的产品行为，并覆盖保留第三方配置和冲突诊断。
- [ ] 明确历史与统计的连接复用、缓存和服务器资源上限，证明不会为每个 UI 请求创建 SSH 进程。
- [ ] 本机/WSL 与多台 SSH 的同一 Claude/Codex source 可同时 active；远端会话使用 `HistorySessionRef/rawPointers`，不新增本地历史 DB，不把远端 locator 放入本地 `file_path` command。
- [ ] README、`CHANGELOG.md` `[TEMP]`、`docs/功能清单.md` 同步描述本能力和限制。
- [ ] 所有新增用户可见文案具备中英文版本；文档中的支持矩阵与实际承诺一致。
- [ ] SSH 项目在供应商设置、项目菜单、批量操作、Terminal launch 和同步/导入各层都不能触发 provider 扫描或切换。
- [ ] 普通远端 CLI 会话、另一个 CLI-Manager 客户端、另一个 SSH 用户和替换后的远端机器不会收到或复用当前客户端的 Hook/历史/统计数据。
- [ ] 首期远端历史只读边界、自定义 config root、项目范围索引、时区/时钟偏差和后台 daemon 生命周期均有明确验收项。
- [ ] 每台 SSH 主机分别保存 Claude/Codex 的唯一 `toolConfigRoot`；默认值为该 SSH 用户的 `$HOME/.claude` 与 `$HOME/.codex`，支持恢复默认、远程目录选择和自定义路径，且首期没有独立 Hook/history root 输入。
- [ ] SSH 历史恢复严格校验 Host/machine/user/config root/cwd，支持同 Host 项目选择与原远端目录，不允许本地路径回退或并发恢复同一 session。
- [ ] SSH 项目“打开项目文件夹”进入内部只读远端文件侧边栏，所有目录/文件请求复用 Agent bridge，写操作及本机 Explorer 在各层硬拒绝。
- [ ] SSH Git 面板只读展示远端仓库状态、Diff 和分支信息，复用 Agent bridge；所有 Git 写操作、网络操作、任意 argv 和本地 Git/path fallback 在 UI/store/Rust/Agent 各层拒绝。

## Implementation Defaults

- Agent 可以在未启用 Claude/Codex Hook 时独立提供历史/统计；三项能力独立探测和降级。
- 未安装 Hook 时，历史和历史用量仍可用；已知 sessionId 的 resume 可继续精确 tail。新建且尚未识别 sessionId 的 Tab 只显示候选/项目级统计，不承诺精确实时绑定。
- 远端 `ccusage` 是可选增强，内置 transcript parser 为统计基线，避免把 Bun/npm 安装作为硬前提。
- 首期远端历史只读；收藏本地快照和同主机 resume 可用，远端写操作后续单独设计。
- 首期默认只索引已绑定 SSH 项目目录，不自动扫描远端用户的全部 Claude/Codex 历史。
- 完整远端会话默认不落本地磁盘；收藏/显式离线保存除外。
- SSH 文件侧边栏首期只读；完整远端文件编辑/管理在后续独立阶段开放。
- SSH Git 面板首期只读；stage/commit/branch mutation/network/destructive 操作后续按独立 capability 分阶段开放。

## Confirmed Product Decisions

- Agent 正式名称为 `cli-manager-ssh-agent`。
- Changelog 目标为 `[TEMP]`。
- Agent 内置 Hook 执行能力，Hook 写入由 SSH 主机设置页显式触发。
- 用户可分别安装/启用 Claude Hook 和 Codex Hook。
- 支持 HTTP 拉取官方脚本安装，并与桌面端 SSH 安装路径共享制品与安全校验。
- SSH 项目不支持供应商切换；供应商设置不扫描或解析 SSH 服务器。
- SSH Git 面板纳入本次首期交付，不推迟到后续版本；首期范围固定为远端仓库发现、状态、Diff、当前分支/upstream/ahead-behind 和已有分支列表。
- SSH Git 首期不包含 stage/unstage、commit、discard、分支切换/创建、fetch/push/pull、rebase、stash、hunk revert 或 Worktree mutation。
- 每台 SSH Host 分别配置 Claude/Codex 的“CLI 配置目录（Hook 与历史）”；默认使用该 SSH 用户的 `$HOME/.claude` 与 `$HOME/.codex`，首期不拆分 Hook 与历史目录输入。
- 后续需求分支由本任务统一调研、收敛并形成完整方案，用户在方案完成后集中审阅，不再逐项询问。

## Notes

- This is a complex planning task. `design.md` and `implement.md` are required before `task.py start`.
- GitNexus MCP was unavailable during initial discovery; use the existing SSH contracts and repository search as the discovery source, and record the full touchpoint list in `design.md`/`implement.md`.
