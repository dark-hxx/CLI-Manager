# 远程 Git 全功能面板技术设计

## 1. 设计结论

SSH、本地和 WSL 共用 `GitChangesPanel`、`GitChangesTree`、`DiffViewerModal` 与同一套 Store 行为。环境差异只存在于 Git Transport 和后端执行层：

```text
GitChangesPanel / DiffViewerModal
              |
          gitStore
              |
      GitTransport contract
        /             \
LocalGitTransport   SshGitTransport
        |             |
existing git_*     ssh_remote_git_request
Tauri commands         |
                       daemon Git lane
                            |
                    SSH Agent Git runner
```

本地和 WSL 继续调用现有 `git_*` Tauri command；SSH 只向 Agent 发送远程根目录内的仓库相对标识和路径，不允许把远程 POSIX 路径传入本地 Git command。

## 2. 设计依据与影响范围

### 2.1 本地功能基准

本任务以当前本地面板的真实行为为准，不增加 Tag、Cherry-pick、Reflog 等新功能。

| 功能组 | 当前入口 | 远程目标 |
|---|---|---|
| 仓库与状态 | `git_list_repositories`、`git_get_changes` | 仓库枚举、嵌套仓库切换、状态、暂存态、增删行 |
| Diff | `git_get_file_diff` | staged/unstaged/untracked/rename/conflict/二进制/非 UTF-8 |
| 暂存 | `git_stage_file/paths/all`、`git_unstage_file/paths/all` | 相同选择语义与刷新行为 |
| 回滚 | `git_discard_file`、`git_delete_untracked_paths`、`git_revert_hunk/lines` | 保留二次确认、状态复核和 patch dry-run |
| 提交 | `git_commit`、`git_commit_paths` | 全索引提交、路径提交、短 commit id、身份错误 |
| 网络 | `git_fetch`、`git_push`、`git_pull` | Fetch、首次 upstream、Push、三种 Pull 策略 |
| 分支 | `git_list_branches`、checkout、smart checkout、create | 本地/远程分支、创建、普通/Smart Checkout |
| 冲突 | `pendingOp`、`git_pull_abort`、`git_rebase_continue` | Merge/Rebase 状态、继续、中止 |

### 2.2 Discovery List

设计阶段 GitNexus 曾因全局包缺少 `tree-sitter-kotlin` 无法建索引，因此先按仓库规则使用契约文档和 `rg` 完成触点发现。实施阶段已修复并重建索引（16,481 symbols / 42,683 relationships / 300 flows）；最终 `detect-changes` 识别 20 个文件、139 个符号、5 条流程，整体风险 MEDIUM。`fetchChanges` 的单符号影响为 HIGH（20 个 Store 动作直接调用），Agent `diff` 影响为 HIGH，均已按跨层契约和定向测试复核。

- [x] `src/components/git/GitChangesPanel.tsx:345`：SSH 只读状态与 `:738` 的专用 JSX 必须删除。
- [x] `src/components/git/GitChangesPanel.tsx:400`：本地 watcher 保留；SSH 增加独立聚焦/低频轮询刷新。
- [x] `src/components/git/DiffViewerModal.tsx:124`、`:204`、`:235`：Diff、Hunk、行回滚直连本地 command，必须改为回调/Transport。
- [x] `src/stores/gitStore.ts:236`：删除 `assertGitWritable()`；所有动作统一经 Transport。
- [x] `src/stores/gitStore.ts:306-918`：读写、刷新与竞态守卫需要绑定完整项目上下文。
- [x] `src/lib/sshRemoteGit.ts`：从 5 个只读 RPC 扩展为完整远程 Git Transport；写操作不得暴露 retry。
- [x] `src-tauri/src/commands/ssh_git.rs`：扩展严格 kind allowlist 和分类型 payload。
- [x] `src-tauri/src/daemon/ssh_agent_bridge.rs:236`：新增 Git lane，不能再把 Git 写操作归入 Readonly lane。
- [x] `src-tauri/src/daemon/ssh_agent_bridge.rs:1108`：按 `gitFull` capability 阻断 Git 请求，不影响 Hook/历史/文件能力。
- [x] `src-tauri/ssh-agent/src/protocol.rs:261`：协议次版本和 capability；新增 Git 请求分派。
- [x] `src-tauri/ssh-agent/src/git.rs`：当前仅有只读实现，是远程执行与安全校验的主要落点。
- [x] `src-tauri/src/commands/git.rs`：本地行为基准；本任务不改其执行路由，不把远程分支塞入该文件。
- [x] `src/lib/types.ts:1006`：统一 Diff payload、请求选择行和仓库引用类型。
- [x] `src/lib/i18n.ts`：能力缺失、远程认证、结果未知、锁冲突、超时等中英文文案。
- [x] `src/components/git/GitChangesTree.tsx`：已通过回调隔离，确认不需要远程专用分支。
- [x] `src/components/files/FileEditorPane.tsx:253`：只服务本地文件编辑 Diff，确认不纳入本任务。
- [x] `src/components/worktree/WorktreeFinishDialog.tsx:121`：本地 Worktree 生命周期，确认不纳入远程 Git。
- [x] `src-tauri/src/lib.rs:1020`：继续只注册一个受控的 `ssh_remote_git_request`，无需为每个 RPC 增加 Tauri command。

按触点数量、跨 WebView/Tauri/daemon/Agent 四层以及包含不可逆写操作判断，实施风险为 **HIGH**。风险来自边界和状态一致性，不来自共享 JSX 本身。

## 3. 前端边界

### 3.1 统一执行上下文

Store 不再只用 `projectPath` 判断请求是否过期。初始化面板时生成不可变上下文：

```ts
interface GitExecutionContext {
  contextKey: string;        // projectId + environment + host/root + generation
  projectId: string;
  environment: "local" | "wsl" | "ssh";
  projectRoot: string;       // UI 身份；不是命令参数
  repositoryId: string;      // 根仓库为 ""，子仓库为 POSIX 相对路径
  transport: GitTransport;
}

interface GitRepositoryRef {
  id: string;                // repositoryId
  relativePath: string;
  localPath?: string;        // 仅 Local/WSL Transport 可见
  branch: string | null;
}
```

- SSH 的 `repositoryId` 永远是远程根目录内的 `/` 分隔相对路径。
- Local/WSL Transport 通过 `GitRepositoryRef.localPath` 解析现有绝对路径。
- Store 的异步请求在 await 前捕获 `contextKey + repositoryId`，写入前重新比较；不匹配即丢弃。
- 项目切换、Host 切换、远程根路径变化、仓库切换都会生成新上下文并清理文件选择态。
- `buildSshRemoteGitContext` 直接从 SSH Host、Agent installation 和 Project 构建，不再经 `buildSshAgentHistoryContext` / `buildSshRemoteFileContext` 派生；Git 能力不依赖项目是否配置 Claude/Codex、Hook 或 history source。
- Git consumer identity 固定为 `git:<clientInstanceId>:<hostId>:<projectId>`；launch plan 保留 Host、Agent、project、bridge epoch 身份，`toolSource` 对 Git lane 可为空。

### 3.2 GitTransport

Transport 是窄接口，不持有 React 状态；Store 继续拥有 loading、error、选择集合和刷新编排。

```ts
interface GitTransport {
  listRepositories(): Promise<GitRepositoryRef[]>;
  getChanges(repoId: string): Promise<GitSnapshot<GitFileChange[]>>;
  getFileDiff(repoId: string, path: string, status: string): Promise<GitFileDiffPayload>;
  getBranchStatus(repoId: string): Promise<GitSnapshot<GitBranchStatus>>;
  listBranches(repoId: string): Promise<GitSnapshot<GitBranchInfo[]>>;

  stage(repoId: string, paths: string[]): Promise<void>;
  unstage(repoId: string, paths: string[]): Promise<void>;
  discardFile(repoId: string, path: string, status: string): Promise<void>;
  deleteUntracked(repoId: string, paths: string[]): Promise<void>;
  revertHunk(repoId: string, path: string, diff: string, index: number): Promise<void>;
  revertLines(repoId: string, path: string, diff: string, lines: GitSelectedLine[]): Promise<void>;
  commit(repoId: string, message: string, paths?: string[]): Promise<string>;
  fetch(repoId: string): Promise<string>;
  push(repoId: string, setUpstream: boolean, branch: string | null): Promise<string>;
  checkout(repoId: string, branch: string, remote: boolean): Promise<string>;
  smartCheckout(repoId: string, branch: string, remote: boolean): Promise<string>;
  createBranch(repoId: string, branch: string): Promise<string>;
  pull(repoId: string, strategy: GitPullStrategy): Promise<string>;
  pullAbort(repoId: string): Promise<void>;
  rebaseContinue(repoId: string): Promise<string>;
}
```

`stageAll/unstageAll/discardAll` 仍由 Store 根据当前变更集调用批量接口，避免为 UI 语义再造 Agent 专用模型。

### 3.3 Diff 复用

- 删除 `GitChangesPanel` 的 `remoteDiff` 简易文本弹窗。
- `DiffViewerModal` 接收 `loadDiff`、`revertHunk`、`revertLines` 回调，不再直接决定 Local/SSH。
- `GitFileDiffPayload` 统一为 `{ content, canRevertHunks }`。
- Hunk/行回滚请求必须额外携带当前文件路径；Agent 校验 patch 头只触及该路径。
- 二进制、未跟踪、非 UTF-8 或冲突场景由后端返回 `canRevertHunks=false`，面板仍显示整文件回滚入口。

### 3.4 共享 UI

- 删除 `readOnly`、SSH 专用早返回和 `git.readOnly` 展示。
- SSH 进入与本地完全相同的仓库菜单、筛选、树、暂存、提交、分支、Push/Pull、冲突横幅和确认弹窗。
- capability 缺失、Agent 未安装或协议不匹配时，在同一面板内容区显示可恢复错误，不渲染伪只读列表，也不降级到本地 command。
- 新增文案全部同步 zh-CN/en-US；时间继续显式 `hour12: false`。

## 4. SSH RPC 契约

### 4.1 协议与能力

- Agent 协议从 `1.6` 升到 `1.7`，major 保持 `1`。
- 携带 `gitFull` 的 Agent 产品版本升级到 `0.1.1`；已发布的 `0.1.0` prerelease 是协议 `1.6`，其 tag、签名、哈希和二进制不可覆盖。
- hello capability 新增 `gitFull`。
- 每个 `git*` 请求发送前由 daemon bridge 检查 `gitFull`；缺失返回 `ssh_agent_capability_missing:gitFull`。
- capability 判断不依赖 minor 数字，不影响同一 Agent 的终端、Hook、历史和文件能力。
- Agent 尚未发布，不保留旧只读 Git 模式；缺失 capability 时整个远程 Git 面板提示更新 Agent。

### 4.2 请求种类

继续使用一个 Tauri 入口 `ssh_remote_git_request`，但 Rust 与 Agent 两侧都使用显式 allowlist：

```text
Read:
gitListRepositories, gitChanges, gitDiff, gitBranchStatus, gitBranches

Write:
gitStage, gitUnstage, gitDiscardFile, gitDeleteUntracked,
gitRevertHunk, gitRevertLines, gitCommit, gitCommitPaths,
gitFetch, gitPush, gitCheckout, gitSmartCheckout, gitCreateBranch,
gitPull, gitPullAbort, gitRebaseContinue
```

公共请求字段：

```json
{
  "rootPath": "/absolute/remote/project",
  "repoPath": "nested/repo",
  "...operationFields": "..."
}
```

- `rootPath` 是 SSH 项目的绝对 POSIX 根目录。
- `repoPath` 是根目录内仓库相对标识，根仓库为空串。
- 文件路径一律是仓库相对路径。
- 每个请求反序列化为自己的 `#[serde(deny_unknown_fields)]` 结构，不使用可写任意字段的通用结构体。

主要响应：

```text
GitSnapshot<T>       = { value/status/changes/branches/repositories, asOf }
GitFileDiffPayload   = { content, canRevertHunks, asOf }
GitMutationResult    = { output?, shortId?, asOf }
```

写响应只表示 Agent 已完成执行；连接超时、通道关闭或响应丢失属于结果未知，前端必须刷新，不能重放。

### 4.3 专用 Git lane

daemon bridge 新增 `BridgeLane::Git`：

- 同一 Host 的所有 Git 请求进入一个 Git lane，按队列串行执行。
- Git 读请求不再借用 Readonly lane，避免写操作中途读取到 stash/reset/apply 的中间状态。
- 文件/历史只读 lane、Hook primary lane 保持原行为。
- `release_consumer` 同时清理 Primary、Readonly、Git 三个 lane。
- Git lane 使用独立、确定性的 `git_client_instance_id(hostId, clientInstanceId)`；不得复用 Primary 或 Readonly 的 client identity，否则远端 Agent 会把并行 bridge 判为重复实例。
- `ensure_bridge` 按 lane 校验身份：Git 要求 Host/Agent/client/project/epoch，不要求 Claude/Codex `toolSource`。
- Git lane 仍受全局 bridge/connect permit、帧上限和身份校验约束。

## 5. Agent 执行设计

### 5.1 Read/Write runner 分离

Agent 只用 `Command::new("git").args(...)`，禁止 shell 字符串。

`run_git_read`：

- 设置 `GIT_OPTIONAL_LOCKS=0`。
- 禁用 pager、外部 diff、fsmonitor 与终端提示。
- 适用于 status、diff、branch、repository 查询。

`run_git_write`：

- 不设置 `GIT_OPTIONAL_LOCKS=0`，保留 index/refs 自身锁。
- 设置 `GIT_TERMINAL_PROMPT=0`、`GCM_INTERACTIVE=Never`，stdin 关闭。
- 继承远程用户的 HOME、SSH key、credential helper、代理和 Git 配置，不采集密码。
- 网络认证需要交互时快速返回 `auth_failed`，提示用户在远程终端配置非交互凭据。
- 每个进程使用独立进程组和有界超时；超时终止整个进程组。
- 无自动重试，无隐藏 fallback。

建议时限：普通读取 30 秒，磁盘写 60 秒，Fetch/Push/Pull 120 秒；daemon client 超时必须大于 Agent 操作时限并预留传输余量。

### 5.2 路径与输入校验

Agent 边界必须执行：

1. `rootPath`：绝对 POSIX 路径，拒绝 NUL/CR/LF/反斜杠/`..`，canonicalize 后必须是目录。
2. `repoPath`：只允许相对 POSIX 路径；canonicalize 后必须仍位于 canonical root。
3. 文件路径：拒绝绝对路径、空目标、`.`/`..` 越界段、反斜杠和控制字符。
4. 多路径：限制数量和总字节数，逐项校验并去重。
5. 分支名：先做参数级拒绝，再执行 `git check-ref-format --branch`。
6. commit message：trim 后非空，拒绝 NUL，限制字节数；作为单独 argv 传递。
7. patch：限制大小，解析 `---/+++` 文件头，必须只包含请求中的文件路径；先 `git apply --check`，再正式 apply。
8. 未跟踪删除：执行前重新获取 Git 状态；只删除仍未跟踪的普通文件/符号链接，父目录 canonicalize 后必须在 worktree 内。

Diff 与 patch 的 UTF-8 内容上限统一为 768 KiB，给 1 MiB JSON 帧保留字段和转义余量；超限返回 `remote_git_diff_too_large`。本任务不扩大全局帧上限，也不为单文件 Diff 引入分块协议。

按钮隐藏不是安全边界；WebView、Tauri allowlist、daemon kind allowlist、Agent 反序列化与文件系统边界均需独立拒绝。

### 5.3 本地行为对等

- 状态使用 NUL 分隔 porcelain 输出，正确解析 rename 的双路径记录、冲突组合和非 UTF-8 路径错误。
- 增删行分别聚合 worktree/index numstat；二进制计数为 0；嵌套仓库根从父仓库变更列表排除。
- Diff 按本地状态分支生成：未跟踪合成新增文件 Diff；A、M、D、R、C 与当前本地命令保持相同比较基线。
- Agent 增加与本地相同的文本编码检测依赖（复用项目已有 `encoding_rs`、`chardetng` 版本），非 UTF-8 可展示但禁止局部回滚。
- `stage/unstage`、commit pathspec、fetch/push/pull 参数与 `src-tauri/src/commands/git.rs` 保持一一对应。
- Branch status 必须返回 `pendingOp`；通过 Git 目录状态识别 merge/rebase。
- Smart Checkout 复用本地顺序：stash `-u` -> checkout -> apply；任一步失败返回现有稳定错误码并刷新真实状态。
- 通用 Git stderr 继续映射 `auth_failed`、`not_fast_forward`、`no_upstream`、`checkout_conflict`、`no_remote`、`git_failed`。

不把本地 `commands/git.rs` 抽成共享执行模块。Local/WSL 与远程 Linux 的路径、凭据和进程语义不同，强行共用会放大耦合；行为一致性由请求契约、错误码和对等测试保证。

## 6. 刷新、并发与失败处理

### 6.1 刷新矩阵

| 触发 | Local/WSL | SSH |
|---|---|---|
| 面板打开/项目切换 | 立即刷新 | 立即刷新并校验 capability |
| 手动刷新 | 立即刷新 | 立即刷新 |
| 文件变化 | 现有 watcher | 不监听远程文件系统 |
| 窗口重新聚焦/恢复可见 | 静默刷新 | 静默刷新 |
| 前台停留 | watcher 失败时 15s | 15s 低频轮询，仅可见且聚焦 |
| 写操作完成 | 按当前动作刷新 | 相同刷新集合 |
| 写操作失败/结果未知 | 按当前动作刷新 | 强制 changes + branch status，必要时 branches + repositories |

### 6.2 写后刷新集合

- Stage/Unstage/Discard/Hunk/Lines/Delete/Commit：changes + branch status。
- Fetch/Checkout/Smart Checkout/Create Branch：changes + branch status + branches + repositories。
- Push：branch status；失败也刷新。
- Pull/Abort/Rebase Continue：changes + branch status；冲突失败也刷新。

### 6.3 自动重试规则

- 只读刷新可由用户或低频轮询再次发起。
- `sshRemoteGit` 只有只读请求可向 Background Tasks 暴露 Retry。
- 任何写请求都不设置 `retry` 回调。
- response timeout/channel closed/bridge reconnect 对写操作统一映射为“结果未知”；先刷新，用户根据真实状态决定下一步。

## 7. 场景矩阵

| 维度 | 设计处理 |
|---|---|
| 当前窗口/其他窗口/失焦 | Store 用 project/context key 防串写；失焦停轮询，聚焦刷新 |
| 当前 Pane/其他 Pane/深层分屏 | 面板上下文来自明确 projectId，不依赖当前路径字符串猜测 |
| 最小化/托盘 | 停止远程轮询；恢复可见后刷新一次 |
| 多 Session/Workspan | 同项目可共享只读结果，但每次响应仍校验上下文；Git 写由 Host Git lane 串行 |
| Focus mode 开/关 | 只影响可见性，不改变 Transport 与写操作语义 |
| Local/WSL/SSH | Local/WSL 保持现有 command；SSH 只走 Agent |
| 主仓库/嵌套仓库 | 统一 repositoryId；切换时清理选择态和过期响应 |
| 远程 Worktree | 可把已配置 remote root 当普通仓库使用；Worktree 创建/删除生命周期仍不支持 |
| Agent 未装/过期/Git 缺失 | 同面板显示明确错误并阻断，不回退本地 |
| Hook 装/未装 | Git capability 仅依赖 Agent 安装，不依赖 Claude/Codex Hook 或 CLI source |
| 凭据可用/需交互 | 非交互凭据正常；需交互时快速失败并引导远程终端配置 |
| 外部终端同时操作 | Git 自身锁保护；锁冲突失败并刷新，不抢锁、不重试 |

## 8. 测试设计

### 8.1 Rust/Agent 自动测试

- 每个请求结构拒绝未知字段、路径越界、绝对路径、反斜杠、NUL/CR/LF 和超限输入。
- 临时仓库覆盖 M/A/D/R/??/C、staged/unstaged、嵌套仓库、unborn branch、detached HEAD。
- Diff 覆盖 UTF-8、GBK、UTF-16、二进制、无尾换行、大文件上限与 `canRevertHunks`。
- Stage/Unstage、路径 Commit、未跟踪删除、文件/Hunk/行回滚均验证执行前状态复核。
- Checkout/Create/Smart Checkout、Fetch/Push/Pull 参数与错误映射做单元/fixture 测试。
- Bridge 测试 Git lane 串行、capability 缺失、consumer release、timeout/channel closed 不重放。
- Protocol 测试 `1.7`、`gitFull`、所有 kind allowlist 和 1 MiB 帧上限。

### 8.2 前端静态/行为测试

- Transport 测试证明 SSH action 只调用 `ssh_remote_git_request`，Local/WSL 只调用现有 `git_*`。
- Store 测试项目/仓库切换后丢弃旧响应，写失败仍刷新，写请求没有 retry。
- 检查 `GitChangesPanel` 无 SSH 专用 JSX，`DiffViewerModal` 无环境判断。
- i18n 键同时存在 zh-CN/en-US。

### 8.3 人工桌面验收

项目规约禁止 AI 启动 Tauri 桌面应用做 UI 真值验证。人工需逐项执行本地、WSL、SSH 三套面板操作，特别验证：多窗口/分屏切换、远程嵌套仓库、Smart Checkout 冲突、Pull merge/rebase 冲突、断网结果未知、远程凭据缺失和中英文切换。

## 9. 取舍与回滚

### 采用

- 单 JSX + 单 Store 行为 + 双 Transport。
- SSH Agent 系统 Git CLI，继承远程用户 Git 环境。
- 独立 Git lane 串行化所有远程 Git 请求。
- capability 作为唯一启用门槛，不维护旧只读兼容。

### 不采用

- 不复制一套 `RemoteGitPanel`：会导致功能和错误处理持续漂移。
- 不让 UI 到处判断 Local/SSH：环境选择只在上下文/Transport 创建时发生。
- 不把远程路径传给本地 `git_*`：这是禁止的安全降级。
- 不复用 Readonly lane 执行写操作：它关闭锁且允许并行，语义错误。
- 不自动重试写请求：无法证明 Commit/Checkout/Pull 是否已经执行。
- 不把完整本地 Git 后端抽成共享模块：平台执行语义不同，收益小于耦合成本。

### 回滚点

1. Agent Git engine 可独立回滚，不触碰现有 Local/WSL command。
2. Protocol/bridge 通过 `gitFull` gate 隔离；移除 capability 即可阻断远程 Git，不会回落本地。
3. 前端 Transport 接入若回归，可回滚 SSH Transport 分支并保留原 Local transport。
4. UI 最后移除只读分支；在 Transport/Agent 验证通过前不提前开放写按钮。
