# SSH Agent 场景矩阵

状态值：`支持`、`降级`、`阻断`、`待验证`。

## 平台与 Shell

| 维度 | 场景 | 预期 |
|---|---|---|
| 客户端 | Windows 10/11 + Linux x64 | 支持，首期主验收。 |
| 客户端 | Windows + Linux arm64 | 支持，要求 arm64 制品/真机验证。 |
| 客户端 | macOS x64/arm64 | 待验证，设计兼容，不提前宣称正式支持。 |
| 远端 | Windows OpenSSH target | 待验证，PowerShell/cmd/文件锁单独适配。 |
| 远端 | Alpine/musl | 待验证，需检查 shell、证书、inotify、noexec。 |
| 远端 | BusyBox/无标准 shell | 阻断或仅手工终端，Agent doctor 报 unsupported。 |
| Shell | Bash/sh | 支持。 |
| Shell | zsh/fish 登录 shell | Agent bridge 使用绝对入口，交互终端按 SSH 默认 shell；Hook/历史支持取决于 CLI 配置。 |
| Shell | 仅 cmd、禁用 exec | 阻断 Agent bridge。 |

## 认证与网络

| 维度 | 场景 | 预期 |
|---|---|---|
| 认证 | SSH Config/Agent/私钥 | 支持。 |
| 认证 | `credential_ref` | bridge 可通过一次性 AskPass 尝试非交互认证；凭据失效后进入 authenticationRequired，不无限重试。 |
| 认证 | `password_prompt` / 多轮 MFA | 只承诺交互终端；独立 `ssh -T` bridge 不能复用前台 PTY 认证，首期 CLI 集成显示不支持后台 bridge/需要重新认证。 |
| Host Key | 首次指纹 | 遵循 OpenSSH 交互确认。 |
| Host Key | 指纹变化 | 阻断，不自动忽略。 |
| 跳板 | ProxyJump | 支持，bridge 与 PTY 使用同一结构化 Launch Plan。 |
| 跳板 | 多跳循环 | 阻断并报配置错误。 |
| 网络 | 连接超时 | 分类为 unreachable，指数退避。 |
| 网络 | 短时断线 | bridge reconnect，Hook spool/历史 cursor 补发。 |
| 网络 | 长时离线 | 停止高频轮询，显示 stale/cache。 |
| 代理 | ProxyCommand 带密码 | 阻断，凭据不进入配置/日志。 |
| 服务端 | `MaxSessions` 较小 | 连接池有界；无法创建 channel 时降级为排队。 |
| 服务端 | 禁止 exec/端口转发 | 阻断 Agent；交互 PTY 仍可单独支持。 |
| 服务端 | `ChannelTimeout` 杀空闲 bridge | doctor 检测并提示，需要保持 bridge 活跃。 |
| Shell 输出 | profile/MOTD 向 stdout 写 banner | 有界扫描 Agent magic preamble 后进入严格帧解析；超限或帧间污染阻断并由 doctor 报告。 |
| 服务端 | ForcedCommand 替换 Agent 命令 | 握手失败并标记 unsupported，不把返回文本当协议帧。 |

## 安装与升级

| 维度 | 场景 | 预期 |
|---|---|---|
| 入口 | 保存 SSH 主机 | 不安装、不改 Hook。 |
| 入口 | 测试连接 | 仅短连接诊断，不改 Hook。 |
| 入口 | SSH 主机 CLI 集成安装 | 用户明确点击后安装。 |
| 入口 | 首次打开 SSH 项目 | 只建立终端/按需 bridge，不静默安装。 |
| 来源 | 桌面端上传 | 下载 manifest、验签、上传、远端自检、原子 promote。 |
| 来源 | HTTPS 脚本 | 两步下载/审阅/执行，验签。 |
| 来源 | HTTP 镜像 | 默认拒绝；显式受信公钥/风险确认才允许。 |
| 升级 | 协议兼容 | 用户确认后升级，保留上一版本。 |
| 升级 | 协议不兼容 | 阻断 bridge，引导升级 Agent。 |
| 升级 | 写入中断 | 保留 current，清理 staging。 |
| 升级 | 新版本握手失败 | 回滚 previous。 |
| 卸载 | Agent Hook 仍存在 | 默认先卸载 Hook；仅删 Agent 需危险确认。 |
| 并发 | 两个桌面端同时安装 | 安装锁 + installation id；一方重试/显示冲突。 |
| 权限 | 用户目录 noexec | doctor 报 unsupported，允许手工终端。 |

## Hook

| 维度 | 场景 | 预期 |
|---|---|---|
| 工具 | 只启用 Claude | Claude 正常，Codex neutral，不影响统计入口。 |
| 工具 | 只启用 Codex | Codex 正常，Claude neutral。 |
| 工具 | 两者都启用 | 分别显示状态，事件统一进入 daemon。 |
| 配置 | 已有第三方 Hook | 保留字段、顺序和 matcher，仅追加 owner 条目。 |
| 配置 | 重复 CLI-Manager 条目 | 按 installation id 去重/修复，不删除非 owner 条目。 |
| 配置 | JSON/TOML 非法 | 拒绝写入，提供备份/修复指引。 |
| 配置 | symlink dotfile | 更新真实 target，不替换 symlink 本身。 |
| 配置 | 外部并发修改 | 指纹冲突，有限重试；不能覆盖新修改。 |
| 配置目录 | 新建 SSH Host | Claude/Codex 分别预填当前 SSH 用户的 `$HOME/.claude`、`$HOME/.codex`，解析后显示绝对路径；不影响其他 Host。 |
| 配置目录 | 用户选择远程目录或填写自定义路径 | 仅更新当前 Host/当前工具的唯一 `toolConfigRoot`；Hook 与历史共同使用，派生文件只读展示。 |
| 配置目录 | 用户恢复默认 | 恢复当前 SSH 用户的标准目录，不复用另一台 Host 或另一 SSH 用户的值。 |
| 配置目录 | 默认目录不存在 | 保存/验证不创建；显式安装 Hook 的 preview 明确列出将创建的目录/文件，确认后才创建。 |
| 配置目录 | 自定义目录不存在 | 校验失败并保留旧配置/历史实例，不自动创建任意自定义路径。 |
| 配置目录 | 卸载 Hook | 删除 owner 条目，但保留 Host 的 `toolConfigRoot`、History Source 和缓存。 |
| 配置目录 | 已安装 Hook 后修改 Host 主目录 | 活动 Tab 固定旧 root；新 root 验证/索引成功后用于新会话，旧 Hook 不静默删除并显示引用/清理状态。 |
| 配置目录 | 多项目共享同一覆盖目录 | 合并为一个 source instance/Hook installation record，Host 页只读列出引用项目。 |
| 配置目录 | 项目覆盖目录改名或移除 | 新会话切换到新有效 root；旧 root 仍有活动引用时保留，无引用后进入显式清理状态。 |
| 运行 | bridge 在线 | Hook 通过远端 IPC 实时上报。 |
| 运行 | bridge 离线 | 写有界 spool，Hook 快速退出。 |
| 运行 | spool 满 | 丢弃最旧并发 gap，不阻塞 CLI。 |
| 绑定 | 有 `tabId + cliSessionId` | 更新对应 Tab，统计严格绑定。 |
| 绑定 | 无 CLI-Manager 环境 | Hook 立即 no-op、不写 spool；首期历史不自动导入未绑定项目。 |
| 子 Agent | 有独立 transcript ref | 通过 Agent RPC 订阅子 transcript。 |
| 子 Agent | 只有 parent path | lifecycle-only/degraded，不把 parent 当 child。 |
| 第三方 | 远端 cc-switch/其他工具重写 Hook | 不扫描 cc-switch；仅从 Hook 配置本身检测 conflict/outdated，用户显式修复。 |

## 历史与统计

| 维度 | 场景 | 预期 |
|---|---|---|
| App 启动 | 多个 SSH 主机均离线 | 仅显示本地缓存，不自动连接全部主机。 |
| 历史 | 首次打开某主机 | 建立一条 bridge，创建/加载远端索引。 |
| 历史 | 分页、搜索、详情 | 复用 bridge，不新建 SSH。 |
| 历史 | 本机 Claude + 多台 SSH Claude | sourceId 都是 `claude`，按 sourceInstance scope 同时 active；不能因启用一台 SSH 主机停用本机或另一台主机。 |
| 历史 | 离线 summary-only | 可查看列表、摘要、已同步 usage 和 asOf；全文搜索、完整详情、Diff 显示需要连接，不伪装为完整缓存。 |
| 历史 | 连接断开 | 查看缓存，标记 stale/asOf。 |
| 历史 | 文件 append | 按 offset 只读完整 JSONL 行。 |
| 历史 | 文件 rotate/truncate | generation reset，避免重复/漏读。 |
| 历史 | 同名本地/远端路径 | sourceInstanceId 隔离，remotePath 只作项目筛选，禁止串会话。 |
| 历史 | 恢复远端会话 | 只选择同 host 的 SSH 项目，在远端 cwd resume。 |
| 统计 | 当前 Tab active | 增量解析，约 2s snapshot，UI 节流。 |
| 统计 | Tab hidden | 暂停/降频，不解析隐藏视图。 |
| 统计 | Hook 无 Token | 继续由 transcript parser 提供 Token；Hook 只绑定状态。 |
| 统计 | 无 ccusage | 内置 parser；只降级增强报表。 |
| 分析 | 刷新多个主机 | 全局并发上限，缓存先展示，结果标记未刷新主机。 |
| 资源 | 远端大历史 | Agent 索引配额，分页/取消/限帧，不全量复制。 |

## UI、窗口、分屏和恢复

| 维度 | 场景 | 预期 |
|---|---|---|
| 窗口 | 当前窗口聚焦 | 本窗口绑定 Tab 处理 Hook。 |
| 窗口 | 另一个窗口聚焦 | 广播仍送达，只有拥有 Tab 的窗口更新。 |
| 窗口 | 最小化/托盘 | daemon/bridge 可继续收集；系统通知按设置处理。 |
| 分屏 | 同一主机多个 pane | 共用 bridge，按 cliSessionId 分离统计。 |
| Workspan | 多工作区切换 | 不重复创建 bridge，订阅随 Tab 生命周期。 |
| 多会话 | 同项目多 Claude/Codex | session id 严格匹配，不能显示其他窗口统计。 |
| 恢复 | App 重启且 PTY 存活 | attach PTY；bridge 仅在认证模式允许后台重连时恢复，不重复运行 startup command。 |
| 恢复 | PTY 已退出 | 仅 replay/disconnected + 历史缓存，不重启远端 CLI。 |
| 功能入口 | 文件/Git 读取 | Agent capability 可用时开放只读面板；不可用时硬阻断并显示明确降级。 |
| 功能入口 | 文件/Git 写入/Worktree | 首期始终阻断，不因只读 capability 可用而放开。 |

## 安全与资源

| 维度 | 场景 | 预期 |
|---|---|---|
| 凭据 | 密码/私钥/passphrase | 不写 SQLite、日志、spool、缓存、同步。 |
| 日志 | 连接错误 | 记录 host id、阶段、错误 code；脱敏 host/user/proxy。 |
| 缓存 | 本地导出/WebDAV | 默认排除远端历史正文、cursor、spool。 |
| 协议 | 超大帧/恶意 Agent | 最大帧、分页、速率和超时限制。 |
| 服务器 | 连接风暴 | 每主机 1 bridge，全局重连并发 2，历史/统计共享。 |
| 服务器 | 无 UI 活跃请求 | 5 分钟 idle 关闭 bridge。 |
| 服务器 | spool 长期堆积 | 10k/32MB/24h 上限，gap 可见。 |

## 供应商边界

| 维度 | 场景 | 预期 |
|---|---|---|
| 项目菜单 | SSH 项目右键/Tab 菜单 | 不显示供应商切换、重置、模型测试入口。 |
| 批量操作 | 本地/WSL/SSH 混选 | 整个 provider 操作禁用并说明 SSH 不支持，禁止静默跳过部分项目。 |
| 设置 | 打开“设置 -> 供应商” | 只读取本机/显式 WSL provider；不启动 SSH、不扫描 host。 |
| 设置 | 保存/刷新供应商 | SSH Host 数量不改变，远端无任何 provider 查询。 |
| 启动 | SSH 项目带 provider override | Rust/前端双边界忽略并清理，不生成远端 settings/profile，不注入本机 secret。 |
| 启动 | SSH 项目手工填写 provider-like 环境变量 | 作为普通用户环境变量透传，不被解析、展示或纳入供应商设置；存储/同步沿用项目环境变量策略。 |
| 环境切换 | local/WSL -> SSH | 清空 provider override，不复制本机 provider settings/profile。 |
| 环境切换 | SSH -> local/WSL | 重新按本地能力计算，不从远端推断或恢复 provider。 |
| 远端 | 有 cc-switch/自定义 provider 数据库 | Agent 不读取、不解析、不显示、不切换。 |
| 统计 | transcript 有自定义 endpoint/model | 只显示模型/Token；价格未知计入 unpriced，不反推 provider。 |
| 同步 | 导入带 provider/worktree 配置的 SSH 项目 | 清空机器相关字段，要求重新绑定 Host；不恢复 provider。 |

## 多客户端、权限和配置根

| 维度 | 场景 | 预期 |
|---|---|---|
| 多客户端 | 同一远端用户被两个桌面端连接 | 各自 clientInstanceId/bridge/spool 隔离；Hook 只投递到发起会话的客户端。 |
| 多客户端 | 两个客户端同时刷新同一 config root 历史 | 共享远端派生索引；跨进程单 writer，另一方读取已提交 generation 或排队，不重复全量扫描。 |
| 多用户 | 同一服务器不同 SSH 用户 | 独立 installation/history/cache，禁止跨用户扫描。 |
| 普通 CLI | 用户从普通 SSH/IDE 启动 Claude/Codex | Hook 快速 no-op，不写 spool；历史首期不自动导入未绑定目录。 |
| 配置根 | 自定义 `CLAUDE_CONFIG_DIR` / `CODEX_HOME` | 显式探测并按 configRootHash 隔离索引/Hook 状态。 |
| 配置根 | 同一主机 Claude/Codex 使用不同目录 | 两个工具分别保存自己的 `toolConfigRoot`，互不覆盖。 |
| 配置根 | 两台主机路径文本相同 | 仍按 machine/user/source/configRoot 隔离为不同 source instance。 |
| 配置根 | 项目级 config root 覆盖 | 只为该项目注册/复用对应 source instance，恢复会话时注入原覆盖值；Host 默认值保持不变。 |
| 配置根 | 配置目录 symlink/权限不足 | doctor 报告真实 target/权限，不能跨权限访问或替换 link。 |
| 身份 | Host alias/地址改到新机器 | Agent installationId/remoteMachineId 变化，旧缓存标记 machineChanged，要求确认。 |
| 时间 | 远端时区不同 | Agent 发送 UTC；UI 按应用时区展示，统计按明确的日界线聚合。 |
| 时间 | 远端时钟偏差超过 5 分钟 | doctor 警告；sequence/cursor 决定排序，不按 timestamp 猜顺序。 |
| 权限边界 | `sudo`/`su` 后运行 CLI | 首期标记 unsupported/unbound，不跨用户读取 socket、Hook 或历史。 |
| 持久会话 | tmux/screen/container 内长期运行 CLI | 首期不自动接管；显示连接/绑定限制，后续单独设计。 |
| Host 删除 | Host 被 SSH 项目引用但无活动连接 | 解绑并保留项目/remotePath，项目标记需重新绑定；不远程卸载 Agent/Hook，历史缓存标记 unbound。 |
| Host 删除 | 存在活动 PTY/bridge | 阻止删除，要求先关闭相关会话/任务。 |
| Host 删除 | 被其他 Host 作为 jump target | 阻止删除，要求先修改依赖 Host。 |

## 历史写操作边界

| 操作 | SSH 首期行为 |
|---|---|
| 列表、搜索、详情、Diff | 支持，远端只读 RPC。 |
| 收藏 | 支持保存本地只读快照，保留远端来源标记。 |
| Resume | 支持，只能恢复到同一 Host 的 SSH 项目。 |
| Session identity | 使用 `(sourceId, sourceInstanceId, sourceSessionId)`；remotePath/file_path 只作筛选或兼容字段。 |
| 编辑消息 | 阻断。 |
| 删除/批量删除 | 阻断。 |
| 插入消息/撤销/备份还原 | 阻断。 |
| 打开远端原文件 | 阻断本地 opener/fs，必须使用未来远端文件能力。 |

## 历史存储与缓存

| 场景 | 预期 |
|---|---|
| 首次打开远端历史 | 本地无缓存时建立一个 bridge，Agent 增量建索引；不复制整个目录。 |
| 再次打开 | 先显示本地 summary/usage cache，再按 generation 拉 delta。 |
| 打开会话详情 | 按需读取单个远端 JSONL，详情默认只进内存 LRU。 |
| 在线全文搜索 | 查询远端 bounded search index，点击后按需加载详情。 |
| 离线搜索 | 只搜索本地 session id/项目/标题预览/标签/收藏。 |
| 收藏会话 | 本地保存完整只读快照；远端源删除后收藏仍可查看。 |
| 普通未收藏会话 | 不默认在本地持久化完整消息、工具 payload 或 Diff。 |
| 远端文件删除 | 在线同步收到 tombstone 后从普通列表移除；收藏快照保留。 |
| 远端不可达 | 不把缓存缺失误判为删除，显示 stale/asOf。 |
| 配置根权限异常/扫描取消 | 不产生 tombstone，保留缓存并标记同步失败。 |
| Agent parser 升级 | 旧索引标记 stale，分批重建；UI 可继续显示旧缓存及重建进度。 |
| 删除本地缓存 | 不影响 Agent 索引和原始远端 JSONL。 |
| 删除 Agent 索引 | 可从原始 JSONL 重建，不影响 Claude/Codex。 |

## SSH 历史会话恢复

| 场景 | 预期 |
|---|---|
| 精确匹配 SSH 项目 | 复用 Host bridge preflight，创建新 SSH PTY，在原 cwd 执行原 source resume。 |
| 多个同 Host 项目匹配 | 选择框只展示同 Host SSH 项目。 |
| 无项目但 Host 仍有效 | 提供“使用原远端目录”，创建无项目 SSH terminal。 |
| Host 配置丢失 | 要求重新绑定并验证 session，不能选择 local/WSL 项目。 |
| Host 指向新机器/用户 | installationId/remoteMachineId/user 不符，阻止恢复。 |
| 原 cwd 不存在/不可进入 | 阻止恢复，不能静默改用项目根目录。 |
| 自定义 config root | 恢复计划注入原 `CLAUDE_CONFIG_DIR`/`CODEX_HOME`。 |
| 同 session 已在当前客户端运行 | 跳转已有 Tab，不重复 resume。 |
| 同 session 在另一客户端运行 | 首期阻止并发恢复，显示 active elsewhere。 |
| Hook 未安装 | 允许 resume；实时状态/统计降级。 |
| Agent 不可达但缓存可信 | 默认要求重连；显式尝试时由远端 CLI 返回真实错误。 |
| 远端源文件已删除 | 收藏可查看但 resume 阻断，不自动上传快照。 |
| 子 Agent/转换会话 | 不直接 resume，定位父会话或显示不支持。 |
| Codex/Claude CLI 不可用 | preflight/PTY 显示 tool unavailable，不修改历史缓存。 |
| CLI 版本不支持该 session resume | preflight 返回 unsupported_resume_version，不创建 PTY 或修改缓存。 |

## SSH 项目文件侧边栏

| 场景 | 预期 |
|---|---|
| 点击“打开项目文件夹” | 打开内部远端文件侧边栏，根为 SSH 项目 remotePath。 |
| 调用本机 Explorer/Finder | 禁用并说明远端路径不能由本机文件管理器打开。 |
| 根目录首次加载 | 只请求第一层目录，不递归扫描。 |
| 展开大目录 | 分页加载并可取消，复用 bridge。 |
| Agent 未安装/bridge 认证不支持 | 显示安装或重新认证引导，不回退到本机文件 API、SFTP 猜测或按请求新建 SSH。 |
| 文本/图片预览 | 按需分块读取，大小/MIME 超限时降级。 |
| 创建/重命名/删除/移动/粘贴/保存 | 首期 UI 隐藏，store/backend 硬拒绝。 |
| 文件名搜索 | Agent 在项目 root 内执行受限搜索。 |
| 内容搜索 | 有结果/字节/超时上限；能力不可用时明确降级。 |
| symlink 指向 root 外 | 显示但禁止进入/读取。 |
| bridge 断开 | 树 metadata 可显示 stale；新内容必须重连。 |
| 历史变更文件点击 | 使用 RemoteFileRef 在同 Host 侧边栏定位，不调用本地 opener。 |
| 无项目远端恢复会话 | 临时 remote root 绑定恢复 cwd，提供只读文件侧边栏。 |
| Host/installation 变化 | 旧 tree/cache/RemoteFileRef 失效并要求重新加载。 |

## SSH 只读 Git 面板

| 场景 | 预期 |
|---|---|
| 远端未安装 Git | Git 面板显示 unavailable；终端、文件、历史不受影响。 |
| 项目不是 Git 仓库 | 显示空状态，不尝试本机 Git。 |
| 根仓库 + 嵌套仓库 | Agent 受限深度发现，UI 可切换 repoId；不能提交任意绝对路径。 |
| Git Worktree `.git` file | 允许 Git 解析合法 common dir，但文件访问仍限制在 worktree root。 |
| staged/untracked/conflict/rename | NUL porcelain 正确保留状态和 Unicode/空格路径。 |
| 点击变更文件 | 使用 SshFileProvider 只读打开；删除文件只显示 Diff。 |
| 查看 Diff | Agent 固定命令生成，禁用 external diff/textconv，超限分块/截断。 |
| 查看分支 | 显示当前/upstream/ahead/behind 和已有 refs；不自动 fetch，标注 asOf。 |
| 点击 stage/commit/discard/checkout/fetch/push/pull | 首期 UI 不显示；伪造 RPC 返回 unsupported_capability。 |
| dubious ownership | 返回诊断，不自动修改 `safe.directory`。 |
| Git 需要 credential helper/MFA | 首期无网络 Git，不触发凭据提示或转发本机秘密。 |
| 面板可见 | 共用 bridge，watch invalidation + debounce refresh。 |
| 面板隐藏/失焦 | 停止订阅或降为零轮询，不持续消耗远端资源。 |
| watcher 不可用/NFS | 可见期间低频 status polling，结果带 asOf/partial。 |
| bridge 断开 | 显示最近 status stale；新 Diff/refresh 要求重连。 |
| Host/repo generation 变化 | 旧 repoId/Diff 失效，重新 discovery/status。 |
