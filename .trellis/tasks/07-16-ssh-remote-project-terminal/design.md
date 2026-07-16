# SSH 远程项目 / 远程终端总体设计

## 1. 设计原则

1. 项目优先：SSH 是项目运行环境，不取代项目树成为主导航。
2. 薄封装 OpenSSH：尽量复用用户既有 SSH 生态。
3. 能力诚实：未适配的本地功能必须禁用并说明，不能静默对远程路径执行本地命令。
4. 领域解耦：连接资产、项目、终端会话和凭据分别建模。
5. 渐进增强：先远程终端，再逐项接入文件/Git/历史/Hook。

## 2. 推荐领域模型

```text
ProjectGroup（现有手动分组）
  └─ Project
       ├─ environmentType: local | wsl | ssh
       ├─ localPath? / wslPath? / remotePath?
       ├─ sshHostId?
       ├─ CLI、启动命令、模板、Provider 等项目配置
       └─ TerminalSession[]

SshHost
  ├─ 基本连接信息
  ├─ 认证策略引用
  ├─ 跳板/代理策略
  └─ 初始化与连接选项

CredentialRef
  └─ 只保存系统凭据库引用，不保存秘密本身
```

### 2.1 `ssh_hosts` 建议字段

- `id`, `name`, `group_name`, `host`, `port`, `username`
- `config_alias`：可选，引用 `~/.ssh/config` Host
- `auth_mode`：`ssh_config | agent | identity_file | password_prompt | interactive | credential_ref`
- `identity_file`：机器本地路径，不进入跨设备同步
- `credential_ref`：系统安全凭据库键
- `jump_mode`, `jump_host_id`, `proxy_command` 或受限代理配置
- `connect_timeout_sec`, `server_alive_interval_sec`, `server_alive_count_max`
- `terminal_encoding`, `locale_env`, `startup_script`
- `notes`, `sort_order`, `created_at`, `updated_at`

### 2.2 `projects` 扩展

- `environment_type`，默认 `local`，保证旧数据无感迁移。
- `ssh_host_id`，仅 SSH 项目使用。
- `remote_path`，不与本地 `path` 混用。
- 现有 `path` 在迁移阶段继续作为本地/WSL路径；长期可抽象为 location，但不建议一次性重构全部调用点。

项目唯一性和匹配键应从单纯路径改为：

```text
local: local + normalizedLocalPath
wsl:   wsl + distro + normalizedLinuxPath
ssh:   ssh + sshHostId + normalizedRemotePath
```

## 3. 分层架构

### 3.1 Environment Adapter

新增统一能力接口，避免组件直接判断路径字符串：

```text
EnvironmentAdapter
  - buildTerminalLaunchPlan()
  - validateProjectLocation()
  - capabilities()
  - browseDirectory()        [可选]
  - fileOperations()         [后续]
  - gitOperations()          [后续]
  - historySource()          [后续]
```

首期实现 `LocalAdapter`、现有 WSL 适配桥接、`SshAdapter`。UI 通过能力集决定按钮是否可用。

### 3.2 Terminal Launch Plan

前端不拼接完整 SSH 命令，而是向 Rust 传递结构化计划：

```text
SshTerminalLaunchPlan {
  host_id,
  remote_path,
  startup_command,
  terminal_mode,
  allocate_tty,
  environment_overrides
}
```

Rust 加载主机配置，生成 OpenSSH 参数，启动本地 `ssh` 进程作为 PTY 根进程。远端命令通过固定 POSIX shell wrapper 完成 `cd -- <path>` 和启动命令，必须做严格引用。

### 3.3 会话模型

`TerminalSession` 增加：

- `environmentType`
- `sshHostId`
- `remotePath`
- `connectionState: connecting | authenticating | connected | reconnecting | disconnected | failed`
- `disconnectReason`

`cwd` 仍可用于 xterm/OSC 当前目录展示，但不再作为远程项目身份的唯一来源。

## 4. 产品信息架构

### 4.1 设置 → SSH 主机

提供主机列表、手动分组、搜索、添加、复制、编辑、删除、测试连接、打开纯 SSH 终端。主机分组只管理连接资产，不自动改写左侧项目分组。

### 4.2 新建项目

保持现有窄幅、单列、长滚动的“新增终端”弹窗。标题下方增加一级类型 Tab：“本地项目 / SSH 远程项目”。默认进入本地项目；本地 Tab 渲染现有表单，SSH Tab 渲染新的远程表单。两种类型共享弹窗外壳、底部操作区和校验反馈模式。

类型 Tab 状态属于本次创建草稿。切换 Tab 时分别缓存两套未提交字段，避免用户误切换后丢失已填写内容；最终只提交当前选中类型对应的数据。

公共字段：项目名称、现有项目分组、CLI 工具、启动命令、项目级环境变量。

本地配置区：本地/WSL 路径、Shell、Worktree 隔离策略和依赖安装设置。

SSH 配置区：SSH 主机、远程路径和远程能力提示；MVP 隐藏或明确禁用远程 Worktree，不展示会产生错误预期的本地 Shell 选择。

远程路径提供：手工输入、连接后浏览、路径检测。浏览器是否通过 SFTP 实现属于技术细节；产品合同是“SFTP 不可用时仍可手工输入并检测”。

### 4.3 项目列表

保持现有树、手动分组、排序和 Workspan 行为。SSH 项目增加明确图标/徽标与主机提示；右键菜单按能力过滤，例如 MVP 不展示或禁用“打开文件夹”“Git Worktree”。

## 5. 连接配置设计

参考 XTerminal，但采用渐进披露：

- 基本信息：名称、SSH 分组、地址/Host alias、端口、用户、备注。
- 认证：SSH Config/Agent、私钥、密码询问、交互认证、系统凭据引用、认证顺序。
- 跳板机：引用另一 SSH 主机，首期限制无环链路。
- 代理：优先支持 SSH Config；自有 HTTP/SOCKS/ProxyCommand 作为高级项。
- 连接设置：超时、KeepAlive、TTY、编码。
- 初始化：登录后命令、环境变量、是否自动进入 shell。

测试连接必须分别报告：客户端探测、配置解析、网络建立、Host Key、认证、远端 shell、SFTP（可选）和项目路径检测结果。

## 6. 远程目录选择

产品层支持：

1. 手工输入路径；
2. 连接并浏览目录；
3. 检测存在性、可进入性、Git 仓库状态；
4. 记忆最近浏览位置但不记录秘密。

技术优先级：系统 `sftp` 持久会话 → 受控 `ssh` 目录查询降级 → 手工输入 + `test -d`。不把 SFTP 作为创建远程项目的硬前提。

## 7. 与现有功能的兼容设计

### 7.1 可直接复用

- 项目分组、排序、搜索、收藏与项目级配置框架；
- xterm 渲染、Tab、Pane、Workspan、复制粘贴、终端主题；
- 命令模板和向终端写入命令；
- daemon 对本地 SSH PTY 的托管与 attach。

### 7.2 MVP 需要适配

- 项目创建/编辑和数据迁移；
- PTY 启动计划与 SSH 状态识别；
- 会话恢复元数据；
- 项目右键菜单、空态、错误提示、能力禁用；
- 外部终端启动策略；
- i18n、日志脱敏、WebDAV/导出过滤。

### 7.3 MVP 明确不支持但必须正确降级

- 文件浏览/编辑/拖拽/终端路径点击打开；
- Git 面板、Git 文件状态、Worktree；
- 远端历史扫描、Prompt Library、Diff 文件回跳；
- 远端 Hook、通知、实时统计、请求日志；
- 远端系统资源和 Provider 配置切换。

这些入口必须显示“远程环境暂未支持”，不能调用本地路径实现。

## 8. 安全方案

- 默认不保存密码；本次连接通过 PTY/AskPass 安全交互。
- 若实现保存凭据，必须复用/扩展现有 `credential_store`，并补齐 macOS Keychain 与 Linux Secret Service 后才宣称跨平台支持。
- SQLite 只保存 `credential_ref`；导出/WebDAV 不包含秘密。
- Known Hosts 由系统 OpenSSH 管理；指纹变化强制阻断。
- 日志记录连接阶段、主机 ID 和错误类别，不记录密码、私钥内容、口令或完整代理凭据。
- 远程初始化脚本必须与用户输入参数分离并有预览/风险提示。

## 9. 分期路线

### P1：远程终端 MVP

- SSH 主机管理、SSH Config/Agent/私钥/交互密码；
- 测试连接、纯 SSH 终端；
- SSH 远程项目、路径输入/浏览/检测；
- SSH 项目启动、Tab 状态、断线反馈、会话恢复；
- 全应用能力路由和未支持功能降级。

### P2：远程文件与 Git

- SFTP 文件树、预览、编辑和安全写回；
- 远程 Git 状态、Diff、Stage；
- 终端远程路径与文件树联动。

### P3：远程 AI 工作流

- 远端 Claude/Codex 历史索引；
- Hook 反向通道与通知；
- 用量/请求日志/实时统计；
- 远端 Provider/状态栏配置。

### P4：高级远程开发

- 远端 Worktree、tmux 持久会话、端口转发、远端资源监控。

## 10. 迁移与回滚

- 新字段均有安全默认值，旧项目全部迁移为 `local`。
- SSH 表是新增表，不改变现有本地项目行为。
- 功能开关可隐藏 SSH 入口；关闭后保留配置但不启动新远程会话。
- 数据库降级不应删除 SSH 数据；旧版本忽略新表和新字段。
