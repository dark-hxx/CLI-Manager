# SSH 远程项目 / 远程终端调研

## 1. 调研目标

本调研不只回答“如何启动 ssh”，而是回答 SSH 作为新的运行环境边界接入后，CLI-Manager 现有项目、终端、文件、Git、历史、Hook、统计、Worktree、后台任务、同步和安全能力应如何变化。

## 2. 当前产品能力地图

### 2.1 核心主链路

`Project.path` 目前同时承担多种语义：

1. 项目身份与项目树展示；
2. PTY 启动工作目录；
3. 文件浏览器根目录；
4. Git 与 Worktree 操作根目录；
5. 历史会话与统计的项目匹配依据；
6. Hook、终端恢复和后台任务的会话归属依据；
7. 命令模板、供应商覆盖、环境变量和 Shell 配置的项目作用域。

SSH 接入不能只给 `path` 前拼一个主机名，否则所有本地文件系统调用都会错误地处理远程路径。必须把“项目身份”和“资源所在运行环境”拆开。

### 2.2 主要关联能力

| 能力 | 当前依赖 | SSH 接入影响 |
|---|---|---|
| 项目 CRUD / 分组 / 排序 | SQLite `projects`、本地路径 | 增加项目运行环境与 SSH 主机引用；现有分组保持不变 |
| 项目启动 | 本地 Shell + cwd + startup command | 远程项目需生成 SSH 启动计划，在远端进入目录并运行命令 |
| PTY / daemon | 本地进程树、可恢复 PTY | SSH 客户端仍可作为本地 PTY 根进程；远端命令生命周期需单独表达 |
| 分屏 / Workspan / Tab | `TerminalSession.projectId/cwd/worktreeId` | 增加连接/远程路径元数据，布局能力可复用 |
| 会话恢复 / 后台任务 | 本地 PTY attach、项目路径 | 可恢复本地 SSH 客户端 PTY，但断网、远端 shell 退出与本地 PTY 存活需区分 |
| 文件浏览/编辑/搜索 | Rust 本地 fs commands | 首期必须禁用或提供远程文件传输层，不能直接复用 |
| Git 面板 | git2、本地 git、WSL 命令 | 需要远端 Git 执行适配层；首期应明确禁用 |
| Worktree | 本地 Git + 本地路径表 | 远程 Worktree 是独立后续能力，MVP 不应复用本地实现 |
| 历史会话 | 扫描本机 Claude/Codex JSONL | 远端历史不会自动出现在本机；需后续远程索引/同步设计 |
| Hook | 远端 CLI 向本机/daemon 上报 | 需要反向通道、端口转发或远端 helper；MVP 不默认支持 |
| 实时/历史统计 | 本机历史与 Hook 事件 | 远端运行默认不可见；Tab 只能显示终端级状态，不能伪造 AI 用量 |
| 系统资源 | 本机采样 | 必须标明“本机资源”；远程资源监控是后续独立数据源 |
| 命令模板 | 向当前终端写入文本 | 可直接复用，但路径变量必须区分本地路径和远程路径 |
| 供应商切换 | 修改本机 Claude/Codex 配置 | 不能假定远端配置与本机相同；需远端供应商能力后续设计 |
| WebDAV / 导入导出 | 项目配置与用户偏好 | 可同步非敏感 SSH 档案；凭据和机器相关密钥路径默认不跨设备同步 |

## 3. Issue #145 结论

Issue 的方向正确：优先实现远程项目配置和 SSH 终端，并薄封装系统 OpenSSH。需要补充的关键点是：远程项目不是“本地项目 + ssh 启动命令”，而是一种新的运行环境类型；任何依赖 `Project.path` 的功能都必须经过能力路由。

## 4. 竞品对比

| 产品 | 核心定位 | 值得借鉴 | 不宜直接照搬 |
|---|---|---|---|
| XTerminal | SSH 连接与服务器资产管理 | 分组、认证方式、凭据、跳板机、代理、备注、初始化配置分区；测试连接 | 以“主机连接”为中心，缺少 CLI-Manager 的项目/AI 会话语义 |
| Termius | 跨设备 SSH/SFTP 资产与凭据管理 | Host、Group、Identity、Jump Host 分离；清晰的资产复用 | 云同步凭据体系与商业账户模型不适合直接引入 |
| Tabby | 可扩展终端与 SSH Profile | SSH Profile 与终端 Tab 一体化；复用系统交互习惯 | Profile 即入口，项目、历史、Git 等跨功能关联较弱 |
| WindTerm | 高能力 SSH/SFTP 客户端 | 完整认证、代理、跳板链、SFTP、会话恢复 | 功能面过大，照搬会把 CLI-Manager 变成通用运维客户端 |
| VS Code Remote SSH | 远程开发环境 | 远端代理/Server 统一提供文件、终端、扩展与端口能力；能力边界清晰 | 安装远端 Server 和完整 IDE 协议成本过高，不适合作为 MVP |
| JetBrains Gateway | 远程 IDE 后端 | 本地 UI 与远端执行环境分离；连接前诊断 | 重型远端后端与索引体系超出 CLI-Manager 定位 |
| cmux / tmux 类 | 远程持久终端 | 断线后远端任务可继续、重连恢复 | 依赖远端 tmux，不应成为基础 SSH 的硬要求 |
| Orca SSH worktree | 远程并行开发 | 将服务器、仓库和任务工作区关联 | Worktree 不应在 SSH MVP 中抢先实现 |

### 4.1 产品定位结论

CLI-Manager 应学习 XTerminal/Termius 的“连接资产管理”，学习 VS Code Remote SSH 的“能力路由与远端边界”，但继续以“开发项目和 AI CLI 工作流”为中心，而不是变成服务器运维工具。

## 5. SSH 技术方案对比

### 5.1 系统 OpenSSH 薄封装

优点：复用 `~/.ssh/config`、Agent、ProxyJump、硬件密钥、Known Hosts、企业环境配置；行为符合用户已有习惯。

缺点：结构化目录浏览、密码自动填充、连接复用和错误分类需要额外适配；不同平台 OpenSSH 版本存在差异。

### 5.2 Rust SSH 库

优点：连接、SFTP、错误和认证状态可结构化控制。

缺点：很难完整复用复杂 SSH Config、Agent、ProxyJump、FIDO/PKCS#11 与企业定制；容易形成第二套 SSH 行为。

### 5.3 混合方案

正式终端始终使用系统 OpenSSH；结构化管理能力优先调用系统 `ssh` / `sftp`，仅在后续需求证明必要时引入受限的库。该方案最符合 Issue 和现有 PTY 架构。

## 6. 推荐结论

1. 新增独立 `ssh_hosts` 连接资产；项目通过 `environment_type + ssh_host_id + remote_path` 引用它。
2. 项目树保持项目优先和现有手动分组，不引入服务器自动层级。
3. SSH 终端作为现有 PTY 的一种 Launch Plan，而不是新建第二套终端渲染系统。
4. 所有依赖路径的功能必须通过 Capability Router 判断 `local / wsl / ssh`，禁止直接把远程路径交给本地 fs/git/history API。
5. MVP 做“可用且诚实”的远程终端和项目管理；文件、Git、历史、Hook 等未接入能力明确展示不可用原因。

## 7. 参考资料

- Issue #145：https://github.com/dark-hxx/CLI-Manager/issues/145
- XTerminal：https://www.xterminal.cn/
- Termius Documentation：https://termius.com/documentation
- Tabby：https://tabby.sh/
- WindTerm：https://github.com/kingToolbox/WindTerm
- VS Code Remote SSH：https://code.visualstudio.com/docs/remote/ssh
- JetBrains Remote Development：https://www.jetbrains.com/help/idea/remote-development-overview.html
- OpenSSH Manual：https://man.openbsd.org/ssh

