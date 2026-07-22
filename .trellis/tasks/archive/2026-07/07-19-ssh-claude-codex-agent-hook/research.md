# SSH Claude/Codex Agent 调研记录

## 调研范围

本记录覆盖 `cli-manager-ssh-agent` 的安装供应链、Hook 配置、SSH 连接复用、远端历史索引、实时统计和跨平台边界。调研日期：2026-07-19。

## 仓库证据

| 证据 | 结论 |
|---|---|
| `src-tauri/src/claude_hook.rs:88`、`:1177` | 当前 Hook listener 绑定本机回环地址，使用 bearer token 和有界 HTTP body/header；远端 `127.0.0.1` 不能直接访问桌面端。 |
| `src-tauri/src/hook_client.rs:23` | 当前 Hook 客户端依赖 `CLI_MANAGER_NOTIFY_PORT`、`CLI_MANAGER_NOTIFY_TOKEN`，并直接连接 `127.0.0.1`；Windows 二进制不能直接作为 Linux/macOS 远端 Hook。 |
| `src-tauri/src/daemon/protocol.rs:289`、`:466` | daemon 已有 `hook_report` 主动帧，可作为远端 Hook 事件进入本地状态机的复用边界。 |
| `src-tauri/src/commands/history.rs:751`、`:1042`、`:1558` | 历史列表、详情和统计以本地路径根目录为输入，已有索引、分页、游标/TTL 和统计缓存能力。 |
| `src/stores/historyStore.ts:708`、`src/components/terminal/TerminalStatsPanel.tsx:455` | 实时统计严格优先按 Hook 返回的 `cliSessionId` 绑定，不能只按项目路径匹配。 |
| `src-tauri/src/commands/ccusage.rs:731` | ccusage 当前运行目标是 host/WSL，远端 SSH 需要新增 provider 或 Agent RPC。 |
| `.trellis/spec/backend/cli-hook-contracts.md` | Hook 支持按工具启停、保留第三方配置、子 Agent transcript 和乱序/失败降级；远端方案必须保持这些语义。 |
| `.trellis/spec/backend/history-index-contracts.md`、`history-stats-contracts.md` | 历史索引要求增量扫描、缓存失效协同、缺失字段安全归一化和 sessionId 严格绑定。 |
| `.trellis/spec/backend/ccusage-contracts.md` | 运行目标和缓存 scope 必须显式区分，不能因路径外观自动把 SSH 数据当成本机/WSL。 |
| SSH 远程项目契约（当前 `master`） | SSH P1 只承诺终端；远程历史、Hook、统计属于后续能力，项目身份为 `sshHostId + remotePath`。 |

## 外部一手资料

1. OpenSSH `ssh_config` 手册：<https://man.openbsd.org/ssh_config>
   - `ServerAliveInterval` / `ServerAliveCountMax` 可用于客户端判定连接失效。
   - `ControlMaster` / `ControlPersist` 是可选的连接复用机制，但不能作为 Windows 基线。
2. OpenSSH `sshd_config` 手册：<https://man.openbsd.org/sshd_config>
   - `MaxSessions`、`MaxStartups` 和连接超时策略会限制并发 channel/连接；客户端必须有界并发。
3. Claude Code Hooks 官方文档：<https://code.claude.com/docs/en/hooks>
   - Hook 是 CLI 生命周期配置，安装必须保留用户已有 matcher/command，不能粗暴覆盖整个配置文件。
4. Sigstore Cosign 验签文档：<https://docs.sigstore.dev/cosign/verifying/verify/>
   - 下载制品的完整性校验不能只依赖 SHA-256；发布清单/制品需要签名验证。
5. XDG Base Directory 规范：<https://specifications.freedesktop.org/basedir-spec/latest/>
   - POSIX Agent 的版本、状态、运行时 socket 和缓存路径应遵循用户目录约定。
6. Win32-OpenSSH ControlMaster 兼容性跟踪：<https://github.com/PowerShell/Win32-OpenSSH/issues/1328>、<https://github.com/PowerShell/Win32-OpenSSH/issues/405>
   - Windows 不把 ControlMaster/ControlPath 当作确定可用的产品基线；运行时可探测但默认采用独立 Agent bridge。

## 结论

### 安装

- 默认模型是无 root、用户级、按需运行；首期不安装 systemd/launchd/Windows 常驻服务。
- 桌面端安装路径：下载并验证签名制品后，通过 SSH/SFTP 上传到远端临时目录，再由 Agent 自检、原子切换 current、握手确认，失败自动回滚。
- 用户脚本路径：提供 `install.sh`、`install.ps1` 及版本化 manifest。官方默认使用 HTTPS；若允许普通 HTTP 镜像，脚本必须内置受信 Ed25519 公钥并验签 manifest/制品，HTTP 不能被当作安全传输。
- 安装目录使用版本目录和稳定入口，Hook 配置只引用稳定入口，升级不需要重写 Hook。

### Hook

- Agent 自带 Hook 解析器和 `hook` 子命令；Hook 进程不启动 SSH、不联网、不等待桌面端。
- 远端 Hook 通过用户级 Unix socket/Windows named pipe 发送给 bridge；bridge 不可用时写入有界 spool，重连后按 event id/sequence 补发。
- Hook 安装必须由 SSH 主机设置页显式执行，分别支持 Claude/Codex，采用 owner + installation id 精确管理，原子更新并保留第三方配置。

### 连接与性能

- Windows 基线：每个 SSH 主机一个长生命周期 `ssh -T ... cli-manager-ssh-agent bridge --stdio`，交互式 Tab 继续独立 `ssh -tt`；历史/统计请求在 bridge 协议内复用。
- 每主机默认一条 bridge，最多一个历史扫描和一个统计解析任务；全局 bridge 并发默认 4（可配置 2-8）。
- bridge 空闲且没有活跃 PTY、实时统计或待发 Hook 时默认 5 分钟关闭；重连采用 1/2/5/10/30/60 秒指数退避并带抖动。
- 远端 transcript 按 inode/mtime/offset 增量读取，只发送完整 JSONL 记录；历史面板关闭后不轮询。

### 历史与统计

- 首次打开远端历史建立一次 bridge 查询并创建远端索引；之后优先使用本地缓存和同一 bridge，不为每个列表/详情/图表请求重新 SSH。
- 远端统计由 transcript 增量解析提供基线，远端 `ccusage` 仅作为可选增强；Hook 不承担 Token 权威来源。
- 断线时展示最近缓存及 `asOf`/stale 状态，重连后按 cursor 补齐；事件采用 at-least-once + 本地去重。

## 研究限制

- Codex Hook 配置格式与事件集合会随 CLI 版本演进，生产实现必须通过 Agent capability probe 和版本化适配器确认，不能把当前仓库事件白名单视为永久稳定 API。
- GitNexus MCP 在本次会话不可用，代码触点复审使用 `.trellis/spec/*-contracts.md`、当前源码和 `rg` 完成；进入实现阶段仍需在可用时重新执行 impact analysis。

## 2026-07-19 master 基线复审

- 当前 `master` 已包含 SSH P1：`src-tauri/src/commands/ssh.rs`、`ssh_launch.rs`、`ssh_proxy.rs`、`ssh_askpass.rs`、`src/lib/ssh.ts`、`src/stores/sshHostStore.ts`、SSH 设置页和 `.trellis/spec/backend/ssh-remote-terminal-contracts.md`。后续方案直接以这些结构化连接档案、Launch Plan、PTY/daemon 和 capability router 为基线，不再等待独立 SSH 分支合并。
- 当前 `master` 已包含 History Source 与 History Index v2 基线：`HistorySourceDescriptor`、`sourceInstanceId`、`HistorySessionRef`、`rawPointers`、`history_source_instances` 以及同一 `history-catalog.db` 内的 v2 schema。SSH 历史不能再建设平行的本地 Provider/SQLite 索引体系。
- 当前 v2 仍保留两个必须先解决的限制：公开历史 DTO/前端 store 仍大量依赖 `file_path`；`history_source_instances` 仍以“每个 source 只有一个 active instance”约束运行。远端多主机 Claude/Codex 同时可见前，必须先完成 typed session reference 和 source-instance activation scope 升级。
- 远端 Agent 可以在 SSH 用户目录维护独立、可删除、可重建的派生索引；桌面端不得因此新增第二个本地历史 SQLite。远端同步下来的 summary/usage/cursor/freshness 必须进入现有 `history-catalog.db` v2。
- 当前 Git 面板不是只读面板：`gitStore`/`GitChangesPanel` 同时包含 status/Diff、stage/unstage、commit、discard、删除 untracked、分支切换、Smart Checkout、fetch/push/pull、冲突中止、hunk/line revert 和 Worktree snapshot。SSH 不能直接把单一 `ProjectCapability.git` 设为 true，必须拆分 read/index/commit/worktree/network/destructive capability。
- 远端只读 Git 最适合由 Agent 调用目标主机系统 Git：复用现有 Git DTO 和 NUL porcelain 语义，但以 rootId/repoId/relativePath 固定 RPC 代替本地 `projectPath` 和任意 shell。首期 status/Diff/branch 不需要 Git 凭据，也不应自动 fetch。

## 方案复审补充

- 供应商是明确的负能力：SSH capability、Agent protocol、Terminal Launch Plan 和同步/导入路径都不得提供 provider switching；“设置 -> 供应商”只处理 local/WSL，不建立 SSH 连接或扫描远端 provider。
- 普通 SSH/IDE/tmux 启动的 CLI 若没有 CLI-Manager client/tab/session 注入环境，Hook 必须 no-op；否则远端全局 Hook 会误采集用户未授权会话。
- `hostId` 不是远端机器身份。Agent handshake 需要 `installationId/remoteMachineId`，用于防止 Host 编辑、DNS/alias 变化或服务器重装后复用旧历史缓存。
- 自定义 `CLAUDE_CONFIG_DIR` / `CODEX_HOME`、多 SSH 用户、多个桌面客户端、时区/时钟偏差、sudo/su/容器/tmux、NFS/noexec 和历史写操作都必须在首期矩阵中明确降级或阻断。
- 首期远端历史采用只读边界；收藏本地快照和同主机 resume 可开放，编辑/删除/插入/备份还原不得复用本地路径 API。
- 每台 SSH Host 的 Claude/Codex 各维护一个主 `toolConfigRoot`，默认 `$HOME/.claude` / `$HOME/.codex`；Hook 与历史共享该 root，但能力状态独立。项目级覆盖作为额外 per-root integration 展示，不增加第二个 Host 主目录输入。
- 最终复审补齐了文件 RPC、resume preflight、bridge stdout banner/preamble、config root 变更生命周期和 SSH Host 删除/重新绑定语义；Git status/Diff/branch 明确为首期必选交付。
