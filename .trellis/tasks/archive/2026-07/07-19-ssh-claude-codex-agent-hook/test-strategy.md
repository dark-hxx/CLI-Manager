# `cli-manager-ssh-agent` 测试策略

## 1. 测试分层

### Agent 单元测试

- protocol hello/capabilities、major/minor 协商、未知帧、最大帧、分块和 request id。
- magic preamble、8KB 前置 banner、帧间 stdout 污染、ForcedCommand 文本、stderr 分流和握手超时。
- ping/pong、超时、cancel、backpressure、sequence/epoch 和重复 ACK。
- Hook stdin JSON 解析、Claude/Codex 事件白名单、session/cwd/transcript/reasoning effort 归一化。
- event id 去重、spool 上限/TTL/gap、cursor ACK 后删除和重启恢复。
- 多个 Hook one-shot 并发写 socket/spool 时的锁、原子追加、去重和配额一致性。
- Claude `settings.json`、Codex `hooks.json`/`config.toml` 合并、owner/install id 精确卸载、第三方字段保留。
- 非法 JSON/TOML、symlink、外部并发指纹变化、权限、原子替换和 journal 回滚。
- manifest 签名、SHA-256、target/版本/protocol 校验、篡改/过期/未知架构拒绝。
- POSIX 路径、环境 key/value、远端 transcript ref 和日志脱敏。
- Claude/Codex JSONL 增量 parser、inode/offset/generation、rotate/truncate、usage delta、模型切换和上下文窗口。

### Rust 集成测试

- SSH bridge 启停、握手、心跳、指数退避和错误分类。
- 同一主机多个项目/Tab 只创建一个 bridge；历史/统计请求不产生额外 SSH 进程。
- bridge 断线时 Hook spool、历史 cursor、统计 stale 状态；重连补发且不重复。
- `HistorySourceDescriptor/sourceInstanceId` 路由；本机/WSL 与多台 SSH 同 source 同时 active，SSH remote path/ref 永不进入本地 fs/Git。
- SSH provider capability/command 边界：供应商设置不建立 SSH；项目/批量/启动/导入路径不调用 `ccswitch_*`；Agent 拒绝 provider RPC。
- `history_list_sessions`、`history_get_session`、`history_get_stats` 的 typed `HistorySessionRef/rawPointers` 兼容和 `(sourceId, sourceInstanceId, sourceSessionId)` key 隔离。
- `GitTargetRef/GitProvider` 路由；SSH status/Diff/branch 只走 Agent repoId RPC，remote path 永不进入本地 Git/libgit2。
- PTY attach/restore 不重新执行 SSH startup/Claude/Codex 命令。
- SSH Host 删除：活动 PTY/bridge 和 jump target 阻断；普通项目引用解除绑定但保留 remotePath；credential 删除；远端 Agent/Hook 不被调用；历史 source/cache 转为 unbound。

### 前端测试

- SSH Host CLI 集成页按 Host 分别显示 Agent/Claude/Codex/History/Stats 独立状态；Claude/Codex 各只有一个“CLI 配置目录（Hook 与历史）”可编辑字段。
- 新建 Host 默认解析当前 SSH 用户的 `$HOME/.claude` 与 `$HOME/.codex`；远程目录选择、自定义路径、恢复默认只更新当前 Host/当前工具，不串到其他 Host。
- Hook 配置文件和历史制品路径作为只读派生详情显示；首期不存在独立 Hook root/history root 输入。
- 保存/测试 SSH Host 和首次打开项目不触发安装或 Hook 写入。
- Hook 预览、安装、升级、卸载、冲突和第三方配置状态。
- 当前 Tab 只显示匹配 remote source instance + cliSessionId 的实时统计；Hook 缺失且新会话 sessionId 未识别时不得误绑定候选 transcript。
- 同一远端用户两个桌面端、同服务器两个 SSH 用户、普通 SSH/IDE 启动 CLI 时不串 Hook/统计/历史。
- 两个桌面端同时刷新同一 config root 时只有一个 Agent index writer；另一 bridge 复用 generation/排队，writer 崩溃后 lease 可接管且索引不损坏。
- hidden Tab 降频/取消订阅；多窗口、分屏、Workspan 和托盘状态不串会话。
- 历史/分析缓存优先、stale/asOf/disconnected、刷新取消和未更新主机提示。
- 远端文件/Git read capability 可用时只打开对应只读面板；mutation/network/Worktree/本地路径入口始终硬拒绝。
- zh-CN/en-US 文案完整，英文仍为 24 小时制。

## 2. 端到端矩阵

### 客户端/远端

- Windows 10/11 x64 -> Ubuntu/Debian/RHEL Linux x64。
- Windows 10/11 x64 -> Linux arm64。
- Windows -> Alpine musl（安装、Hook、历史、统计至少 smoke）。
- macOS x64/arm64 client/target 在开放前单独验收，不通过则保持设计兼容状态。
- Windows SSH target、BusyBox/受限 shell、noexec、无 exec 账号验证为阻断/降级结果。

### 认证/网络

- SSH Config、Agent、identity file、首次 Host Key、变更 Host Key。
- `ssh_config`/Agent/identity/有效 `credential_ref` 可建立 bridge；`password_prompt`/多轮 MFA 只验证交互终端，bridge 返回 authenticationRequired 且不死等、不无限重连。
- ProxyJump、ProxyCommand、跳板链路循环、网络断开/恢复、服务端 `MaxSessions` 较小。
- 服务器短连接/ChannelTimeout 场景下的 doctor 提示和 idle 策略。
- UI 退出但 daemon 后台 PTY 存活时 bridge 保持；最后一个消费者释放后才 idle 关闭。

### Hook

- Claude-only、Codex-only、两者启用、两者禁用。
- 第三方 Hook、非法配置、symlink、并发写、重复 CLI-Manager 条目。
- 在线实时事件、离线 spool、spool overflow/gap、重连补发、重复事件。
- SessionStart/UserPrompt/Permission/Stop/StopFailure/Subagent 全链路和未知事件降级。

### 历史/统计

- 首次索引、分页/搜索/详情、append、rotate/truncate、长历史限额。
- `history_source_instances` scope-aware activation：本机 Claude、WSL Claude 与多台 SSH Claude 不互相停用；旧 schema/metadata 可迁移。
- 再次打开只传 generation delta；详情只加载目标文件；全局用量不读取完整消息。
- remote summary-only 行进入现有 `history-catalog.db` v2；不生成第二个本地 DB，离线全文搜索/完整详情/Diff 明确返回 onlineRequired/partial。
- 普通详情关闭应用后不在本地磁盘保留；收藏快照可离线查看并可单独删除。
- 同主机多项目、同路径不同主机、同项目多 CLI session、子 Agent transcript。
- Host 档案改指新机器、自定义 `CLAUDE_CONFIG_DIR`/`CODEX_HOME`、symlink 项目路径、远端时区/时钟偏差。
- 默认 config root 存在/不存在、自定义 root 不存在、远程目录选择、恢复默认、同主机两工具不同 root、两主机相同路径文本均按预期隔离。
- 保存/验证缺失目录不创建任何文件；显式 Hook 安装 preview 后仅允许创建缺失的标准默认目录，自定义缺失目录拒绝；卸载 Hook 后历史 source/cache 仍可用。
- 项目级 config root 覆盖产生独立 source instance，Host 级默认/自定义值不被改写，resume 注入原覆盖值。
- Host root/项目 override 变更时活动 Tab 固定旧 root，新会话只在新 root 两阶段激活后切换；多项目共享 root 去重；无引用旧 root 进入显式清理且不静默卸载 Hook。
- Codex live SQLite/WAL 被占用、busy 或 schema 不兼容时只降级可选制品读取，JSONL 历史与 CLI 运行不被阻塞。
- 首期历史编辑/删除/插入/还原在 UI/store/backend 均拒绝，收藏和同 host resume 可用。
- Resume preflight 校验 Host/machine/user/config root/cwd；同 session 跳转、跨客户端占用阻断、源删除和 Hook 缺失降级。
- 当前 Tab 2 秒增量 snapshot、模型切换、reasoning effort、cache token、无 ccusage。
- 历史分析多主机并发、部分主机离线、缓存过期、手动刷新取消。

## 3. 性能验收

### 连接数

- 10 个 SSH 主机、每主机 4 个 PTY Tab：应为约 10 个 bridge + 40 个 PTY，不随 UI 请求增长。
- 同一主机连续打开历史列表/搜索/统计 100 次：bridge 数保持 1，SSH spawn 次数只增加到首次连接/重连次数。
- 100 个历史分页请求在 bridge 内串行/并发受控，服务器无连接风暴。

### 资源

- 无文件变化、无 UI 订阅时 Agent CPU 接近空闲；idle timeout 关闭 bridge。
- 大 JSONL 增量读取不全量复制；内存受单帧/分页/索引配额约束。
- spool 达到 10k/32MB 后产生 gap，不阻塞 Claude/Codex。
- 网络恢复时全局重连并发不超过 2。

### 体验目标

- Hook one-shot 正常路径小于 250ms，bridge 不可用时仍快速返回。
- bridge 首次握手在普通 LAN/公网延迟下可显示连接阶段，不阻塞交互终端输入。
- 实时统计 UI 只在 250-500ms 节流后渲染，不因 2 秒 Agent snapshot 造成输入卡顿。

## 4. 安全验收

- 普通 HTTP manifest/制品篡改、签名替换、SHA mismatch、跳转到非 allowlist 域名均拒绝。
- Agent 安装脚本禁止 `eval`、路径穿越、归档 symlink、命令行凭据和临时文件泄露。
- Host Key 变更不得自动接受；Proxy credentials/password/private key 不进入日志、SQLite、store、cache、spool、sync。
- 恶意/损坏 Agent 发送超大帧、错误 sequence、无限分页时本地连接可取消且不耗尽内存。
- 远端 Hook 配置外部修改后不覆盖用户内容；卸载仅删除 owner 条目。
- 第三方通知 payload 不包含 remote path/transcript ref/host/user/session/tab/prompt。

## 4A. 供应商隔离验收

- 打开/刷新“设置 -> 供应商”时记录进程和 SSH 调用：不得创建 Agent bridge、短 SSH 连接或远端文件查询。
- SSH 项目右键、Tab 菜单、命令面板和批量操作不出现供应商切换/重置/测试。
- local/WSL/SSH 混选时 provider 批量操作整体禁用，不得部分成功、部分跳过。
- 构造带 `provider_overrides` 的旧 SSH 项目：Terminal Launch Plan provider 字段保持 null，Rust 不生成 settings/profile、不注入 secret。
- 构造带 provider-like 环境变量的 SSH 项目：只按普通环境变量传递，不出现在 provider 设置或远端扫描结果中；存储/同步行为与现有项目环境变量一致。
- 测试 local/WSL <-> SSH 环境切换：进入 SSH 清空 provider override，切回 local/WSL 不推断/恢复远端 provider。
- 导入/同步带 provider override 的 SSH 项目后字段被清理；local/WSL provider 行为保持不变。
- 远端安装 cc-switch 并含多条 provider：Agent status/history/stats 不读取或返回任何 provider 信息。
- transcript 中出现自定义 model/provider-like name：UI 只显示模型和 token，未知价格计入 unpriced，不创建供应商记录。

## 4B. SSH 文件侧边栏验收

- 点击 SSH 项目“打开项目文件夹”只调用 SshFileProvider，不调用 `open_folder_in_explorer` 或本地 file commands。
- 根目录和展开目录按需分页；连续展开/折叠不创建新的 SSH 进程，host bridge 数保持 1。
- 文本、图片、二进制、大文件、Unicode 文件名、空目录和无权限目录均有明确预览/降级状态。
- symlink 指向 root 外、`..`、绝对路径、NUL/CR/LF 和大小超限请求被 Agent 拒绝。
- create/rename/delete/move/paste/drag/save/openExternal 在 File 面板 UI/store/backend 均不可用；Git 只通过独立 SshGitProvider。
- bridge 断线时只显示 stale tree metadata；重连后 generation delta 更新，不误删目录。
- SSH 历史 Diff 文件点击和无项目 resume cwd 可打开同 Host 的只读远端侧边栏。

## 4C. SSH 只读 Git 面板验收

- `git_probe` 覆盖未安装、版本过低、正常 Git；失败只禁用 Git 面板。
- 根仓库、嵌套仓库和 Git Worktree `.git` file discovery 返回稳定 repoId，不接受任意 absolute path。
- status 覆盖 staged、unstaged、untracked、deleted、conflict、rename、空格/Unicode 文件名和 10k 条目截断。
- file Diff 覆盖新增/修改/删除、二进制、非 UTF-8、超大 Diff、stale generation；禁用 external diff/textconv。
- branch status/list 覆盖 detached HEAD、无 upstream、ahead/behind、remote-tracking refs 和未 fetch 的 asOf 提示。
- Git 面板打开、连续刷新、切换 repo、打开 Diff 均保持每 host 一个 bridge，不新增 SSH 进程。
- watcher 只发 invalidation 并 debounce；隐藏/失焦停止，NFS/无 watcher 降级低频 polling。
- stage/unstage/commit/discard/delete/checkout/create/fetch/push/pull/rebase/revert/stash/Worktree RPC 即使伪造也返回 unsupported capability。
- dubious ownership 不自动写 `safe.directory`；Git 日志/错误不包含 credential helper 输出、token、SSH key 或远端秘密。
- 点击变更文件调用 SshFileProvider；不调用本地 `open_file`、本地 Git command 或 Explorer/Finder。

## 5. 质量门禁

```bash
npx tsc --noEmit
cd src-tauri && cargo check
cd src-tauri && cargo test
```

实现前后还需运行 GitNexus impact/detect changes；GitNexus 不可用时使用现有 SSH/Hook/History/Stats contracts 加 `rg` discovery，并在 review 中列明替代依据。

不主动运行 `npm run dev/build`、`npm run tauri dev/build`，除非用户明确要求。
