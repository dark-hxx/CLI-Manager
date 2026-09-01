# SSH 终端允许 Agent 直接粘贴图片和文件

## Goal

让 CLI-Manager 中任何已连接到 SSH Host、且该 Host 已安装可用
`cli-manager-ssh-agent` 的 SSH 终端，都能通过 Ctrl+V、右键粘贴和文件拖放上传本地图片/文件，
不再要求当前会话必须绑定一个已登记的 SSH 项目；同时允许用户为 SSH Host 自定义远端附件目录，
未配置时继续使用 Agent 默认缓存目录。

在 SSH Host 列表中，认证方式仅用于编辑连接配置，不作为列表展示字段；同时提供 Host 级
SFTP 风格附件面板，让用户从本机选择文件并上传到该 Host 的 Agent 远程附件目录。

## Background and confirmed facts

- `src/hooks/useTerminalInput.ts` 的粘贴/拖放链路先按当前 `sessionId` 获取会话和项目；SSH 图片、原生剪贴板文件路径、Tauri 文件拖放都会进入 `sshRemoteAttachFiles`。
- 当前链路在没有项目、项目不是 SSH 类型，或项目已无法解析时抛出 `ssh_project_configuration_invalid`，因此无项目 SSH 会话在发起 Agent 请求前失败。
- `src/lib/sshRemoteFiles.ts` 的 `sshRemoteAttachFiles` 通过 `buildSshAgentProjectLaunch(project)` 构造 SSH Agent Launch；该构造器绑定项目类型、`ssh_host_id`、`remote_path`，但附件协议本身只需要 SSH Host/Agent 身份和会话目标。
- `TerminalSession` 已保存 `environmentType`、`sshHostId` 和 `remotePath`；SSH 会话启动链路也支持没有 `projectId` 的 Host 终端。
- Rust `ssh_remote_file_attach_data` / `ssh_remote_file_attach_path` 已采用请求驱动的只读附件协议；现有 SSH Agent 合约允许附件请求的 `toolSource`、项目 ID 和项目名为空，但要求 Agent 安装路径、安装身份、远程机器身份、Host 和客户端身份有效。
- Agent 当前把附件固定写入 `${XDG_CACHE_HOME:-$HOME/.cache}/cli-manager-ssh-agent/attachments`，附件 Begin 请求没有自定义目录字段；自定义目录需要扩展 Desktop → Agent 的附件请求契约及对应的安全校验/清理边界。
- 现有 Agent 兼容策略保持不变：优先 `fileAttachAny`（最大 20 MiB），旧 Agent 仅允许经校验的旧版图片通过 `fileAttach` 回退；不支持的任意文件必须显示升级/能力错误，不能粘贴桌面本地路径给远端。
- 用户已确认自定义附件目录按 SSH Host 独立配置；同一 Host 的所有 SSH 终端共享该配置，空值使用 Agent 默认缓存目录。

## Requirements

1. 对 `environmentType === "ssh"` 的终端，附件上传上下文以会话自身的 `sshHostId` 和 `remotePath` 为准，不以是否存在注册项目为前置条件。
2. 上传前仍必须解析当前 Host 对应的已安装 Agent，并携带有效的安装身份、远程机器身份、客户端身份和 SSH 传输配置；Agent 未安装、Host 不存在、连接失败或能力不足时，按现有错误链路失败并且不泄露本地路径。
3. SSH 会话的远程附件路径必须使用该会话的 `remotePath` 作为 Launch 目标；不得从当前选中的其他项目、其他窗格或本地 `cwd` 推导目标。
4. SSH Host 提供可选的远端附件目录配置；配置为空时终端粘贴使用 Agent 默认目录，配置后终端粘贴仍写入 Agent 管理的会话隔离子目录，不能写入其他 Host 或其他会话。
5. 自定义目录只允许安全的远端 POSIX 路径（建议支持绝对路径与 `~/...`，拒绝相对路径、`..`、控制字符、反斜杠和路径逃逸）。Host 级 SFTP 上传直接写入当前远程目录，不自动生成 UUID 子目录，也不覆盖同名文件。
6. 图片、剪贴板文件路径、Tauri 文件拖放和普通文本粘贴行为分别保持正确：图片/文件上传到远端后粘贴远端附件路径，文本仍直接粘贴文本。
7. 本次改动不得放宽本地/WSL 终端的路径处理，不得改变 SSH 项目文件浏览、Git、历史、Hook 或远程接管的项目绑定规则。
8. 保持中文和英文错误提示兼容；沿用现有附件大小、文件名、符号链接、能力协商和清理约束。
9. SSH Host 列表行不再展示认证方式徽标；认证方式编辑、连接测试和实际认证链路保持不变。
10. 每个 SSH Host 提供独立的附件上传入口。上传面板采用双栏文件传输布局：左右表头高度对齐，文件列表使用固定高度并在内容超出时滚动；左侧默认打开 Windows/macOS 桌面并展示本地文件和目录，复用文件浏览器图标，支持进入子目录、返回上级、刷新、手动输入或选择本地目录，点击本地文件加入待上传队列；右侧展示当前远程目录下的文件和目录并复用文件浏览器图标，底部展示排队、上传中、成功和失败状态；远程目录支持手动输入并切换。
11. Host 级上传只使用当前 Host 的 SSH 配置、已安装 Agent 和 Host 级附件目录，不要求 SSH 项目或活动终端；不同 Host 的面板、连接和上传队列不得串用。

## Scenario matrix

| 维度 | 必须覆盖的行为 |
|---|---|
| 窗口焦点 | 当前窗口获得焦点时粘贴；其他窗口或应用未聚焦时不伪造粘贴请求 |
| 分屏 | 当前 SSH 窗格、同窗口其他 SSH 窗格、深层分屏节点分别绑定实际目标 `sessionId` |
| 最小化/托盘 | 恢复后仍按实际目标会话解析；不把其他会话或旧项目作为上传目标 |
| UI 模式 | 展开、折叠、紧凑嵌入终端的粘贴入口共用同一会话上传链路 |
| 多会话/Workspan | 多个 SSH 会话并存、切换 Workspan、项目切换时均以当前会话 Host/remotePath 为准 |
| Focus mode | 开启/关闭时附件上传行为一致 |
| 运行环境 | 本地 PowerShell/CMD/Pwsh、WSL 保持原行为；SSH 终端使用 Agent 上传 |
| Worktree | 本地 Worktree 保持相对路径逻辑；SSH 不借用本地 Worktree 路径 |
| Hook | Claude/Codex Hook 已安装、未安装或只安装一个时，附件能力只取决于 SSH Agent，不依赖 Hook |
| Agent 能力 | 新 Agent 可上传任意受限常规文件；旧 Agent 仅回退合法图片；缺少能力时安全失败 |
| Host 附件面板 | 无 Agent、Agent 能力过旧、默认/自定义目录、目录不可用、本地 Desktop 可用/不可用、本地空目录、进入/返回/刷新/手动切换目录、本地取消选择、多文件/超限/失败/成功、两个 Host 同时操作均有明确状态且不串传 |

## Acceptance Criteria

- [ ] 没有 `projectId` 的 SSH Host 终端，在 Host 已安装可用 Agent 且会话含有效 `sshHostId`/`remotePath` 时，Ctrl+V 图片成功上传并将远端缓存路径粘贴到终端。
- [ ] 同类无项目 SSH 终端可通过 Ctrl+V 粘贴任意受限常规文件，远端收到原始安全文件名对应的缓存路径。
- [ ] SSH Host 可保存自定义远端附件目录；Host SFTP 面板默认进入该目录（空配置使用 Agent 默认目录），上传直接写入当前目录且不自动创建 UUID 子目录。
- [ ] 右键/剪贴板事件、Tauri 原生文件拖放与上述行为共用正确的会话上下文；多窗格不会串传到其他会话。
- [ ] 已登记 SSH 项目、普通本地终端和 WSL 终端行为不回归。
- [ ] Agent 未安装、Host 无效、附件超限或旧 Agent 缺少任意文件能力时，不发送桌面本地路径，并显示现有本地化错误/升级提示。
- [ ] 保留 `fileAttachAny` 与旧版图片 `fileAttach` 回退、远端缓存隔离和已有安全校验。
- [ ] SSH Host 列表行不显示认证方式；编辑页仍可查看和修改认证配置。
- [ ] 从 Host 列表打开附件面板后，可以选择一个或多个本地文件并上传到该 Host 的当前远程目录；右侧展示目录下文件/目录，支持手动输入路径、进入子目录和返回上级，底部传输队列随状态刷新。
- [ ] 附件面板左侧默认进入 Windows/macOS Desktop，展示实际文件和目录并复用文件浏览器图标；点击目录可进入，支持返回上级、刷新、手动输入路径或选择目录，点击文件可加入上传队列。
- [ ] 附件面板左右表头保持对齐；本地和远程文件列表使用固定高度，内容超出时各自显示滚动条；远程文件和目录复用文件浏览器图标。
- [ ] Host 附件面板不依赖登记 SSH 项目或当前 SSH 终端；Agent 缺失/目录不可用时显示本地化错误，并保留安全失败行为。
- [ ] `npx tsc --noEmit`、Rust `cargo check`、相关 Rust 测试通过；变更影响范围通过 GitNexus/替代静态检查确认。
- [ ] 手动切换中文/英文，确认附件失败提示和相关 aria/用户可见文案均可用；时间格式不受影响。

## Resolved decisions

- 自定义附件目录按 SSH Host 配置，不按项目或单个会话配置；同一 Host 的所有 SSH 终端共享，空值使用 Agent 默认缓存目录。
- 上传 Launch 的远程工作目录仍使用会话启动时保存的 `remotePath`；附件存储目录是独立的 Host 配置，不改变 SSH 终端工作目录。
- Host 级 SFTP 面板与终端粘贴使用不同的上传语义：面板直接写入当前远程目录；终端粘贴保留 Agent 管理的隔离目录，避免同名和跨会话覆盖。
