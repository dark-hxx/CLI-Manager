# 远程 Git 全功能面板

## Goal

让 SSH 远程项目复用当前本地 Git 面板的完整交互，通过 SSH Agent 在远程仓库内安全执行同等 Git 操作，同时保证本地和 WSL Git 链路不回归、远程路径绝不进入本地 Git 命令。

本任务是父任务 `07-16-ssh-remote-project-terminal` 中 P2“远程文件与 Git”的独立子任务。

## Background

- 当前远程和本地已经使用同一个 `GitChangesPanel`，但 `src/components/git/GitChangesPanel.tsx:345` 根据 SSH 环境进入独立只读渲染分支。
- `src/stores/gitStore.ts:236` 的 `assertGitWritable()` 明确拒绝所有远程写操作；远程读取只覆盖仓库列表、变更、Diff、分支状态和分支列表。
- `src/components/git/DiffViewerModal.tsx:124` 仍直接调用本地 Tauri Git command，不能直接复用于远程路径。
- `src/components/git/GitChangesPanel.tsx:400` 的本地文件 watcher 明确排除 SSH 项目；远程刷新必须走独立策略。
- SSH Agent 协议 1.6 的 Git RPC 按 `.trellis/spec/backend/ssh-agent-contracts.md` 定义为只读。
- 父任务的 P1 执行计划明确排除了完整远程 Git；其总体设计只把远程 Git 状态、Diff、Stage 列为后续 P2。

## Requirements

### R1. 单一面板交互

- SSH、本地和 WSL 项目复用同一套 Git 面板 JSX、树结构、筛选、分支菜单、提交栏、冲突提示和确认弹窗。
- UI 不直接选择本地或远程命令；执行环境差异必须封装在 Git Store/Transport 边界。
- 本地与 WSL 现有行为、错误码和 watcher 链路保持不变。

### R2. 当前本地面板能力对等

远程项目必须支持当前本地面板已有能力：

- 仓库枚举和根仓库/嵌套仓库切换。
- 变更树、状态筛选、暂存状态、增删行统计和结构化 Diff。
- 单文件、批量和全部暂存/取消暂存。
- 整文件、Hunk、选中行回滚，以及经过二次状态校验的未跟踪文件删除。
- 按面板当前选择规则提交全部或指定路径。
- Fetch、Push、首次建立 upstream、Pull merge/rebase/ff-only。
- 本地/远程分支列表、创建分支、普通 Checkout 和用户确认后的 Smart Checkout。
- Merge/Rebase 冲突状态展示、Pull Abort 和 Rebase Continue。
- 操作完成后刷新 changes、branch status、branch list 和 repository list。

### R3. 传输与上下文隔离

- 每个请求绑定 SSH Host、项目、远程根路径、仓库相对路径和 consumer identity。
- 远程仓库使用受根目录约束的 repo-relative 标识；不得把远程 POSIX 路径传给本地 `git_*` command。
- 异步响应写入 Store 前必须确认项目、仓库和远程上下文仍匹配，过期结果直接丢弃。
- 本地、WSL 和 SSH 返回统一的 TypeScript 数据结构及稳定错误码。

### R4. 远程写操作安全

- SSH Agent 使用参数数组调用 `git`，禁止拼接 shell 命令。
- 所有路径和分支名在 Agent 边界重新校验；路径 canonicalize 后必须仍位于配置的远程项目根目录。
- 只读查询可关闭可选锁；写操作必须保留 Git 自身索引锁。
- Discard、删除和 Patch 回滚必须在执行前重新验证文件状态和仓库归属。
- 写操作禁止自动重试；连接中断或响应丢失后先刷新真实仓库状态，不得盲目重放 Commit、Checkout、Pull 或 Smart Checkout。
- 远程网络 Git 只使用远程主机已配置的非交互凭据；后台 RPC 不采集或保存 Git 密码，认证失败时快速返回并引导用户在远程终端配置凭据。
- 同一 Agent bridge 上的远程写请求串行执行；Git 锁冲突返回明确错误并刷新状态。

### R5. 刷新和故障降级

- 本地继续使用现有文件 watcher。
- SSH 项目在打开、手动刷新、写操作完成、窗口重新聚焦时刷新；前台可使用低频轮询，不创建远程长期文件监听作为本任务前置条件。
- Agent 缺失、版本不兼容、Git 不存在、认证失败、网络超时和响应不确定均提供 zh-CN/en-US 明确提示。
- 隐藏或禁用按钮不是安全边界；Store、Tauri allowlist、daemon bridge 和 Agent 必须逐层拒绝无效请求。

### R6. 协议要求

- Agent 必须通过 capability 明确声明远程 Git 写能力，不能仅根据协议版本猜测。
- 新增 capability 和请求种类时升级协议次版本，协议 major 保持 1。
- 当前 SSH Agent 尚未正式发布给用户，本任务不维护旧 Agent 的只读兼容模式。
- 应用与 SSH Agent 按同一版本能力集交付；缺少新 Git capability 时直接阻断远程 Git 面板并提示重新安装或更新 Agent。
- 缺少 capability 时绝不把远程写请求当作只读请求或本地请求执行。

## Acceptance Criteria

- [ ] SSH 项目展示与本地项目相同的 Git 面板结构，不再进入独立只读 JSX。
- [ ] R2 列出的每项操作均通过 SSH Agent 在远程仓库执行，并与本地面板保持一致的刷新和错误反馈。
- [ ] 远程 Diff 正确覆盖 staged、unstaged、untracked、rename、conflict、二进制和非 UTF-8 场景；不支持行级回滚时由后端返回 `canRevertHunks=false`。
- [ ] 路径穿越、绝对路径、反斜杠、NUL/CR/LF、非法分支名和仓库根外 symlink 均被 Agent 拒绝。
- [ ] 写操作超时、断线或响应通道关闭时不会自动重放；UI 刷新后反映远程真实状态。
- [ ] 多窗口、分屏、项目切换和嵌套仓库切换不会产生跨项目状态覆盖。
- [ ] 未配置远程 Git 凭据时返回认证提示，不弹出或记录密码。
- [ ] 本地和 WSL 项目的全部现有 Git 行为通过回归验证。
- [ ] 新增用户可见文案同时提供 zh-CN 和 en-US，英文模式仍使用 24 小时制。
- [ ] `npx tsc --noEmit`、`cd src-tauri && cargo check`、`cd src-tauri && cargo test --lib` 和 SSH Agent 测试通过。

## Out of Scope

- 当前本地面板没有提供的 Tag、Cherry-pick、Reflog、交互式 Rebase 等新 Git 功能。
- 远程 Worktree 生命周期管理。
- 由后台 RPC 直接采集或保存 Git 用户名、密码或 MFA 信息。
- 为远程仓库增加长期 inotify/fs watcher 服务。
