# `cli-manager-ssh-agent` 实施计划

## 1. 前置依赖和发现清单

当前 `master` 已包含 SSH P1 和 History Index v2。实施直接复用现有 SSH Host/Launch Plan/PTY/daemon/capability router，以及 `HistorySourceDescriptor`、`sourceInstanceId`、`HistorySessionRef`、`rawPointers` 和 `history-catalog.db` v2；不再等待独立 SSH 分支，也不新增平行的本地 SSH 历史数据库。

### 后端/daemon

- `src-tauri/src/claude_hook.rs`：远端 Hook payload 归一化、事件白名单和本地 sink 复用。
- `src-tauri/src/hook_client.rs`：本地 loopback 客户端不可直接复用；提取 payload 解析为 Agent 共享 crate。
- `src-tauri/src/commands/hook_settings.rs`：本地 Hook owner/merge 逻辑可参考，但远端必须使用 installation id、原子写和 journal。
- `src-tauri/src/daemon/protocol.rs`：新增 `agent_bridge` client/daemon 帧，复用 `HookReport`、序列号、ACK、attach 生命周期。
- `src-tauri/src/daemon/client.rs`、`server.rs`：按 host 维护 bridge、广播 Hook、缓存 gap 和重连。
- `src-tauri/src/commands/ssh.rs`、`ssh_launch.rs`、`ssh_proxy.rs`、`ssh_askpass.rs`：抽取共享 `SshTransportSpec`，分别构建 interactive PTY、Agent bridge 和 one-shot exec；保持 Host Key、AskPass、ProxyJump/ProxyCommand 现有安全边界。
- `src-tauri/src/commands/terminal.rs`、`pty/manager.rs`：交互 PTY 与 bridge 分离；由 Rust/daemon 生成并注入可信 `RemoteSessionBinding`，不能由前端伪造。
- `src-tauri/src/commands/history.rs`、`commands/history/catalog.rs`、`commands/history_sources.rs`：复用 v2 adapter/schema/read path；增加 scope-aware source instance、typed session reference、remote materialization/freshness 和 SSH Agent 路由。
- `src-tauri/src/commands/history_backup.rs`：收藏/显式离线快照继续走私有数据与备份边界；首期 remote mutation/restore hard reject。
- `src-tauri/src/commands/git.rs`、`.trellis/spec/backend/git-status-contracts.md`：复用现有 Git DTO/状态语义，提取 NUL porcelain/diff/branch parser；本地/WSL command 保持不变，SSH 只通过 Agent 固定 Git RPC。
- `src-tauri/src/commands/ccusage.rs`：保留本机/WSL provider；远端统计改为 Agent provider，不在该命令内拼 SSH。
- `src-tauri/src/lib.rs`：迁移、Tauri commands、daemon 初始化和 feature flag。
- 新增 `cli-manager-ssh-agent` 独立 Rust crate/二进制：protocol、hook、history、stats、installer、doctor。

### 前端

- `src/lib/types.ts`、`src/stores/sshHostStore.ts`、SSH Host/项目 schema：hostId/remotePath/environmentType/session binding、每 Host 的 Claude/Codex `toolConfigRoot`、Agent discovery/installation metadata 和删除解绑状态。
- `src/stores/terminalStore.ts`：SSH PTY/bridge 生命周期、restore、split、multi-window ownership。
- `src/lib/historySources.ts`、`src/stores/historySourceSettingsStore.ts`：descriptor 继续复用；configured local/WSL active instance 与 SSH managed instances 分离，支持同一 source 多个 remote scope 同时 active。
- `src/lib/historyPathArgs.ts`、`src/stores/historyStore.ts`：从 `file_path`/`makeSessionKey` 迁移到 `HistorySessionRef`；`history-catalog.db` remote summary/materialization/freshness、取消和去重。
- `src/components/HistoryWorkspace.tsx`、`HistoryResumeProjectDialog.tsx`：远端 resume identity/preflight、同 Host 项目过滤和“使用原远端目录”。
- `src/components/terminal/TerminalStatsPanel.tsx`：SSH session id 严格匹配、实时 snapshot/降频。
- `src/stores/fileExplorerStore.ts`、`components/files/*`、`components/sidebar/index.tsx`：拆分 FileProvider/capability；SSH 只读 tree/read/search，禁止本地 path commands、Explorer/Finder 和 Git/write 操作。
- `src/stores/gitStore.ts`、`src/components/git/GitChangesPanel.tsx`、`GitChangesTree.tsx`、`DiffViewerModal.tsx`、`TerminalTabs.tsx`：从 `projectPath` 迁移到 `GitTargetRef/GitProvider`；SSH 首期只显示 status/Diff/branch read controls，所有 mutation/network actions 隐藏且 store/backend/Agent 硬拒绝。
- `src/components/HistoryWorkspace.tsx`、StatsPanel：主机/远端项目筛选和断线状态。
- `src/components/settings/pages/SshHostsSettingsPage.tsx`：CLI 集成、Agent 安装来源、Hook 预览/安装/doctor。
- `src/lib/projectCapabilities.ts`、`src/components/ConfigModal.tsx`、`src/stores/projectStore.ts`、项目树/Tab/批量菜单：SSH 永久禁用 provider switching；环境转换、通用更新、导入和 Worktree badge 路径都要清理/拒绝残留 override，不能只隐藏单一入口或只在启动时忽略。
- `src/stores/ccSwitchStore.ts`、供应商设置页、`src-tauri/src/commands/ccswitch.rs`：确认 provider 查询范围仅为 local/WSL；不得枚举 SSH hosts 或新增 Agent RPC。
- `src/lib/i18n.ts`：所有设置、状态、错误和降级文案双语。
- `src/stores/syncStore.ts`：过滤 installation path、cursor、spool、remote cache、credentials 和 SSH provider overrides。

### 文档和发布

- `README.md`、`README.zh-CN.md`、`README.en-US.md`：用户安装、Hook/历史/统计、只读文件/Git 能力、连接和限制，明确 SSH 不支持供应商切换且供应商设置不扫描远端。
- `CHANGELOG.md`：`[TEMP]` 只记录已交付阶段。
- `docs/功能清单.md`：保留 2.5 为“当前已交付 SSH 终端 MVP”；规划阶段只在 Roadmap/“规划中”小节描述 Agent，实际交付后再分散更新 SSH、Hook、历史、统计、只读文件/Git、供应商、设置、数据层、安全和覆盖总览，避免把未实现能力写成已发布。
- `.github/workflows/release.yml`：Agent 多 target 制品、manifest、签名、SBOM/provenance。
- 新增 `install.sh`、`install.ps1`、manifest schema、detached signature 和安装测试夹具。

## 2. 阶段和交付物

### Stage 0：当前基线审计与契约冻结

- 以当前 `ssh.rs` / `ssh_launch.rs` / daemon / `projectCapabilities.ts` 为 SSH P1 基线，先冻结共享 `SshTransportSpec`、`AgentBridgeLaunch`、`RemoteEnvironmentContext`、`RemoteFileRef`、`GitTargetRef/RemoteGitRepoRef`、Agent protocol、capability 和 error code。
- 冻结 History v2 接入：`sourceId` 仍为 `claude/codex`；稳定身份为 `(sourceId, sourceInstanceId, sourceSessionId)`；SSH source instance 使用 machine/user/configRoot scope；桌面端只写现有 `history-catalog.db`。
- 设计并迁移 `history_source_instances` 的 scope-aware active 约束，明确 remote summary-only materialization，不让 remote source 与本机 active source 互相停用。
- 冻结公开历史 DTO 从 `file_path` 到 `HistorySessionRef/rawPointers` 的兼容迁移顺序，包含收藏、标签、审计、搜索、统计、Diff、resume 和 snapshot key。
- 修正 SSH Host 删除语义为：活动 PTY/bridge 或 jump target 引用时阻止；其余情况解除项目绑定并保留 SSH 项目/remotePath，删除本地 credential，不远程卸载 Agent/Hook，历史 source/cache 标记 unbound 等待重新绑定。补齐当前 store 与 contract 的偏差及迁移/测试。
- 冻结 config root 生命周期：Host 主目录、项目覆盖目录、活动会话捕获值、per-root HookInstallationRecord/sourceInstanceId、orphaned cleanup 和两阶段切换。
- 冻结持久化：`ssh_hosts` 保存 Claude/Codex Host 主 root，`projects.cli_config_root` 保存当前 CLI 的项目覆盖，`ssh_agent_tool_integrations` 保存可重建的 per-root validation/Hook/source 关联；Host 删除时 integration 的 hostId 可空置并转为 unbound。
- 冻结供应商边界：SSH capability 不包含 provider，Agent protocol 不定义 provider RPC，Terminal Launch Plan provider 字段为 null。
- 运行 GitNexus impact（不可用时记录 contracts + `rg` discovery），确认 `pty_create`/daemon/history/stats 触点。

验收：没有把远端路径传入本地 fs/Git/history API；旧 local/WSL 行为无变化。

### Stage 1：Agent crate 与制品供应链

- 新建 `cli-manager-ssh-agent` crate，完成 `version`、`doctor`、`status`、`bridge --stdio` 骨架。
- 实现 protocol major/minor、hello/capabilities、长度帧、最大帧、request id、heartbeat、cancel。
- 实现 release manifest schema、Ed25519/Sigstore 验签、SHA-256、target 白名单。
- 构建 Linux x64/arm64 制品；CI 增加签名和 manifest 发布。

验证：Agent 单测、协议 roundtrip、错误帧、恶意大帧、manifest 篡改、`cargo check/test`。

### Stage 2：安装、升级、卸载和 doctor

- SSH/SFTP 上传 staging、远端自检、原子 current、previous 回滚、安装锁。
- POSIX `install.sh` 与后续 `install.ps1`，支持 `--version`、`--channel`、`--install-dir`、`--dry-run`、`--json`、`--uninstall`、`--purge`。
- 标准 state 目录 `installation.json` discovery record；Host 支持 explicit Agent absolute path、检测并关联、自定义 install root 原地升级和安全迁移。
- SSH 主机设置页 CLI 集成状态、来源选择、doctor 输出和失败诊断。
- 默认 HTTPS；普通 HTTP 只作为显式签名镜像/风险路径。

验证：默认/自定义 install dir、缺失/损坏 discovery、explicit path 关联、权限/noexec/未知架构/中断/并发升级/回滚/卸载 Hook 残留；不记录秘密。

### Stage 3：远端 Hook

- 从本地 Hook parser 抽取共享 stdin 归一化逻辑。
- Agent `hook` one-shot + Unix socket/named pipe + spool。
- clientInstanceId/installationId namespace，普通远端 CLI 无绑定环境时 no-op，多桌面端不串事件。
- Claude/Codex 配置 dry-run、owner/install id、原子合并、journal、第三方保留。
- `hook_inspect/preview/install` 接收当前 Host/工具唯一的 `toolConfigRoot`，返回 canonical config root、实际配置文件路径/fingerprint 和 `HookInstallationRecord`；前端记录并展示，不把 Agent binary path 当 Hook/history root。
- SSH 设置页按 Host、按工具提供“CLI 配置目录（Hook 与历史）”、远程目录选择、恢复默认、预览、安装、升级、卸载和 Hook 配置冲突状态；默认分别为当前 SSH 用户的 `$HOME/.claude` 与 `$HOME/.codex`，不读取远端 cc-switch/provider 数据。
- daemon bridge 接收 `hook_event/gap`，复用现有 HookReport/Tab/toast/subagent 路由。

验证：Claude/Codex 单独启停、第三方配置、非法 JSON/TOML、symlink、并发修改、spool 溢出、断线补发、重复事件、多窗口/分屏。

### Stage 4：远端 History Source 接入

- 将现有 Claude/Codex v2 adapter/parser contracts 提取到桌面端与 Agent 可共享的 Rust crate，保持 `HistorySourceDescriptor` 能力语义一致。
- Agent 增量索引、FTS/摘要、cursor/generation、分页和详情分块；自定义 config root、remoteMachineId 和项目范围索引隔离。
- Agent index 按 user/source/configRootHash 共享，使用跨进程 writer lease + generation 原子提交；多客户端 bridge 单写多读，writer 崩溃可接管，Hook/session namespace 仍保持 client 隔离。
- 复用 SSH Host CLI 集成中 Claude/Codex 唯一的 `toolConfigRoot`；首期不增加独立 history root 输入。项目级 config root override 优先，Agent 只从 root 派生 source artifacts，不从 Agent/CLI binary 路径推断历史。
- `toolConfigRoot` 验证成功后注册 pending remote source instance；Hook 是否安装不影响注册，Hook 卸载不删除 source instance、Host 路径设置或缓存。
- config root validate/dry-run + 两阶段激活；同 machine/user/source/canonicalRoot 复用 sourceInstanceId，多 config roots 可通过不同 Host 或项目级 override 同时 active。保存/验证不创建目录，显式 Hook 安装确认后仅可创建缺失的标准默认目录。
- Rust 通过 `sourceInstanceId` 路由 Agent adapter；remote summary/usage/cursor/freshness 写入现有 `history-catalog.db` v2，禁止另建本地 cache DB，禁止返回可本地打开的远端 path，普通完整 detail 只进内存 LRU。
- v2 增加 remote scope/transport/materialization/asOf 字段；summary-only session 不写完整 messages/FTS，离线全文搜索、详情和 Diff 返回明确的 `onlineRequired`/partial 状态。
- History UI 支持主机/项目筛选、fresh/stale/disconnected、远端 Diff/子 Agent 引用。
- 首期历史写操作在 UI/store/backend 三层硬拒绝；只开放列表、搜索、详情、Diff、收藏快照和同主机 resume。
- 远端原始 JSONL 保持唯一事实源；Agent 索引可删除/重建，本地只有收藏/显式离线保存才落完整快照。
- 新增 `RemoteResumePlan`、Agent preflight、同 Host project selector、已有 session 跳转/跨客户端占用阻断和原 config root 注入。

验证：本机 Claude 与多台 SSH Claude 同时 active、source instance 切换不互相停用、legacy `file_path` metadata 迁移、summary-only 离线边界、首次扫描、append/rotate/truncate、跨主机同路径、断线缓存、分页取消、sessionId 绑定和远端恢复。

### Stage 4A：SSH 只读文件侧边栏

- 拆分 `ProjectCapability.files` 为 browse/read/search/watch/write/delete/move/openExternal 等细粒度能力。
- 抽象 `FileProvider`，保留 local/WSL 行为，新增 `SshFileProvider` 和 `RemoteFileRef`。
- Agent 实现受 rootId 限制的 list/stat/read/search RPC、分页、分块和 symlink/root 安全校验；watch 是否首期开放按 NFS/overlayfs 和资源预算单独 capability probe，不作为 browse/read 的硬依赖。
- FileExplorerSidebar 对 SSH 隐藏写入、拖拽、剪贴板、Git 和本机 Explorer 操作；保留只读树/预览/路径复制。
- 历史 Diff/恢复会话使用 RemoteFileRef 定位同 Host 文件侧边栏；无项目恢复创建临时只读 remote root。

验证：大目录懒加载、文件大小/MIME 限制、watch 上限、断线 stale、symlink 逃逸、Host identity 变化和本地文件功能零回归。

### Stage 4B：SSH 首期只读 Git 面板（本次交付必选）

- 将 `ProjectCapability.git` 拆分为 read status/diff/branches/watch、index write、commit、worktree write、network fetch/push 和 destructive 等能力；SSH 首期只开 read。
- 抽象 `GitProvider`，保留 Local/Wsl provider 行为，新增 `SshGitProvider`；`gitStore` 不再用空 `project.path` 或远端绝对路径调用本地 Tauri Git commands。
- Agent 实现 `git_probe/list_repositories/get_changes/get_file_diff/branch_status/list_branches/subscribe` 固定 RPC；只接受 rootId/repoId/relativePath，禁止任意 argv/shell/config override。
- 远端 Git status 使用 NUL porcelain，Diff 禁用 external diff/textconv；设置 optional-lock-free、timeout、条目/字节/行数上限和 generation/HEAD 校验。
- `GitChangesPanel` 对 SSH 隐藏 stage/unstage/commit/discard/delete/checkout/create/fetch/push/pull/rebase/revert/Worktree 等入口；点击文件复用 `SshFileProvider`。
- watcher 只发 invalidation，面板可见时合并 refresh；watch 不可用时低频 polling，隐藏/失焦停止。

验证：无 Git/旧 Git、普通/嵌套仓库、Git Worktree `.git` file、staged/untracked/conflict/rename、Unicode、二进制/超大 Diff、dubious ownership、NFS watcher 降级、bridge 断线和本地 Git 零回归。

### Stage 5：远端实时统计和历史分析

- Agent transcript usage parser、snapshot/delta、parserVersion、partial/asOf。
- `stats_subscribe` 绑定 active Tab；hidden Tab 降频/取消。
- Ssh realtime provider 接入现有 TerminalStatsPanel；本地价格表估算 cost。
- 自定义远端供应商仅显示 transcript model/token；不读取 provider 数据，价格未知进入 unpriced tokens。
- 历史分析按缓存优先、全局并发限制、可取消刷新和未更新主机标记。
- 可选远端 ccusage provider，只做增强/校验。
- Hook 未安装时：历史/历史统计保持可用；已知 resume session 可精确 tail；新建未知 sessionId 的 Tab 只显示候选/项目级统计，不能宣称精确绑定。

验证：Token 累积 delta、模型切换、context window、reasoning effort、子 Agent 聚合、无 ccusage、同项目多 session、服务器性能。

### Stage 6：多平台与发布

- Linux musl x64/arm64 真机矩阵；macOS signed/notarized；Windows target 设计验证。
- CI 构建 Agent 制品和 desktop release manifest，加入 SBOM/provenance。
- README、CHANGELOG `[TEMP]`、功能清单和双语设置文案更新。

验证：Windows OpenSSH + Linux target 端到端；macOS/Windows target 仅在矩阵通过后改变产品状态；HTTP/HTTPS 安装演练。

## 3. 连接/缓存参数初值

| 参数 | 初值 | 说明 |
|---|---:|---|
| `ConnectTimeout` | 10s | bridge/短连接。 |
| `ServerAliveInterval` | 15s | SSH 层保活。 |
| `ServerAliveCountMax` | 3 | 约 45s 判死。 |
| bridge idle timeout | 5min | 无 PTY/订阅/spool 时关闭。 |
| 全局 bridge 并发 | 4 | 可配置 2-8。 |
| 全局重连并发 | 2 | 防止网络恢复峰值。 |
| history scan / host | 1 | 其余请求排队/共享结果。 |
| stats watch / host | 8 | 超出降频。 |
| Hook spool | 10k 或 32MB，24h | 有界 at-least-once。 |
| Agent index quota | 128MB | 不删除原始历史。 |
| remote rows in `history-catalog.db` | 256MB | 共享 v2 库内按 SSH scope 做 LRU/TTL，不创建新 DB。 |
| local detail memory LRU | 64MB 或 20 sessions | 不默认持久化完整 detail。 |
| realtime snapshot | 2s | UI 250-500ms 节流。 |
| Git status timeout | 10s | 超时返回 partial/error，不阻塞 bridge。 |
| Git status entries | 10k | 超限截断并提示。 |
| Git diff response | 2MB / 20k lines | 超限分块或截断，不持久化。 |

## 4. 质量与安全检查

- 每修改 Rust symbol 前执行 GitNexus impact；MCP 不可用时使用相关 contract + `rg` 并把 discovery 写入本文件。
- 安装边界：路径/NUL/CR/LF/`..`、symlink、权限、原子写、并发指纹、日志脱敏。
- 网络边界：Host Key、ProxyJump/ProxyCommand、MFA、断线、重连、帧上限、取消和 backpressure。
- 数据边界：远端 path/ref 不进入本地 fs/local Git；秘密不进入 SQLite/store/cache/spool/sync。
- File 边界：remote file RPC 只接收 rootId + relativePath；首期所有写操作和本机 Explorer 在 UI/store/Rust/Agent 四层拒绝。
- Git 边界：remote Git RPC 只接收 rootId/repoId/relativePath 和版本化选项；首期 mutation/network/任意 argv/global config write 在 UI/store/Rust/Agent 四层拒绝。
- Provider 边界：设置页不扫描 SSH；SSH 项目菜单/批量操作/启动/导入都不能调用 provider API；Agent 无 provider RPC。
- Hook 边界：事件白名单与版本能力探测，第三方配置保留；冲突只依据 Hook 文件，不探测远端 cc-switch/provider。
- Identity 边界：clientInstanceId、installationId、remoteMachineId、SSH user、configRoot 和 UTC/sequence 不串数据。
- 历史边界：inode/offset/generation、完整 JSONL、sessionId 严格匹配、缓存失效协同。
- 统计边界：Hook 非 Token 权威，delta 去重，model/context/effort 缺失字段安全归一化。
- UI 边界：窗口焦点、分屏、Workspan、托盘、隐藏 Tab、多窗口广播和中英文/24 小时制。

## 5. 验证命令

```bash
npx tsc --noEmit
cd src-tauri && cargo check
cd src-tauri && cargo test
```

禁止在未得到用户明确请求时主动运行 `npm run dev/build`、`npm run tauri dev/build`。

手工必须覆盖：Windows OpenSSH + Linux x64/arm64、SSH Config/Agent/私钥/密码/MFA、首次/变更 Host Key、ProxyJump、网络断开恢复、Hook 部分安装、第三方配置、历史断线缓存、实时统计多 Tab、远端 Git status/Diff/branches、zh-CN/en-US。

## 6. 风险和回滚点

| 风险 | 回滚点 |
|---|---|
| History v2 单 active/source 与多 SSH 实例冲突 | 先迁移 scope-aware activation；未完成前不接入远端历史读路径。 |
| 公开 DTO/store 仍依赖 `file_path` | 分阶段引入 `HistorySessionRef`，remote locator 永不伪装成本地路径。 |
| Agent 协议不兼容 | capabilities 降级；major 不兼容拒绝连接。 |
| 制品/脚本供应链 | manifest 验签失败即停止；保留上一版本。 |
| Hook 多文件部分写入 | journal + 指纹条件回滚，冲突时不覆盖用户修改。 |
| 远端历史解析差异 | provider 标记 partial/stale，不调用本地 parser 假装成功。 |
| 远端 resume 错主机/错 cwd/并发 session | identity + preflight + active binding 检测，禁止本地路径回退。 |
| FileExplorer 误调用本地命令 | FileProvider/capability 分流，RemoteFileRef 不可转为本地 PathBuf。 |
| GitStore 误把 remote path 传给本地 Git/libgit2 | GitTargetRef/GitProvider 分流，SshGitProvider 只走 Agent repoId RPC。 |
| 只读 Git 意外执行 hook/textconv/credential helper/写锁 | 固定 allowlist、no external diff/textconv、optional locks off；首期不开放网络/mutation。 |
| Git 状态过大或 watcher 频繁 | 条目/时间/Diff 上限、invalidation debounce、可见时刷新和低优先级调度。 |
| Host 档案指向新机器 | installationId/remoteMachineId 变化，旧缓存停止复用。 |
| 多客户端/普通远端 CLI 被全局 Hook 捕获 | client namespace + 缺绑定环境 no-op。 |
| SSH provider 残留字段触发本机供应商 | capability/Rust 启动双重忽略，编辑/导入清理。 |
| 连接过多/服务器压力 | per-host/global gate、idle close、降频和取消。 |
| 密码/MFA 终端可用但 bridge 无法后台认证 | 设置页分开诊断；首期 bridge 限定非交互认证，返回 `authenticationRequired` 后停止重试。 |
| Windows/macOS target 不稳定 | 保持 feature disabled，Linux 首期不受影响。 |
| 用户关闭 SSH 能力 | 停止新建 bridge，保留 PTY/缓存和配置。 |

## 7. 进入实现条件

- [x] 用户确认 `[TEMP]`。
- [x] 用户确认名称 `cli-manager-ssh-agent`。
- [x] 用户确认 SSH 主机设置页显式安装/启用 Hook。
- [x] 用户确认增加 HTTP(S) 脚本安装路径。
- [x] 用户审阅并批准 `research.md`、`design.md`、`scenario-matrix.md`、`implement.md`。
- [x] SSH remote project 前置实现已合入当前 `master` 基线。
- [x] 用户明确要求进入实现后，再执行 `task.py start`。
