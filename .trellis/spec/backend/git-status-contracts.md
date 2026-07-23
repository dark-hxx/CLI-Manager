# Git Status Contracts

> git.rs 中 Git 状态收集/变更列表的执行合约与已知陷阱。

---

## 状态收集的三条链路（改过滤逻辑必须全部检查）

| 链路 | 入口 | 消费方 | 收集方式 |
|------|------|--------|----------|
| Git 面板 | `git_get_changes`（Tauri command） | `gitStore.fetchChanges` / `fileExplorerStore` | **内联 status 循环**（git.rs 内 `for entry in statuses.iter()`） |
| Replay 快照 | `git_get_worktree_snapshot` → `build_worktree_snapshot` | `replayStore` | `collect_git_changes_from_repo()` |
| WSL 项目 | `git_get_changes` → `git_get_changes_wsl` | 同面板 | `git status --porcelain -z` 文本解析（`parse_wsl_git_status`） |

> **Warning**: `git_get_changes` 与 `collect_git_changes_from_repo` 是两段**重复实现**的收集循环，历史原因未合并。任何条目过滤/状态映射规则变更必须同步两处（优先提取共享函数），WSL 文本解析链路也要评估是否同样适用。

### WSL UNC 指向 `/mnt/<drive>` 时必须回退 Windows Git

**Context**: 用户可能把 WSL 内的目录软连接指向 Windows 盘项目，例如 `/data/acGo -> /mnt/d/work/pythonProject/acGo`，再在 CLI-Manager 中配置 `\\wsl.localhost\Ubuntu-22.04\data\acGo`。

**Contract**:

- `git_get_changes` 收到 WSL UNC 路径时，先用 `readlink -f` 解析真实 Linux 路径。
- 如果真实路径是 `/mnt/<drive>/...`，必须转换成 Windows 路径并走 native/libgit2 状态收集。
- 只有真实路径仍是 Linux 文件系统路径时，才走 `wsl.exe git status --porcelain=v1 -z`。
- `git_command_output` 同样复用这个分流，避免分支、提交、推送等 shell-out Git 操作在 Windows 工作区上误用 WSL Git。

**Why**: WSL Git 读取 Windows 盘工作区时可能因为换行/索引配置差异把所有文件判为修改，典型表现为每个文件都出现 `+N -N` 的整文件 diff。Windows Git 对同一物理目录是干净状态时，应以 Windows/native Git 结果为准。

**Tests**:

- `wsl::tests::converts_wsl_mnt_paths_to_windows_paths`
- 手动对比：`git -C D:\... status --short` 为空，而 `wsl git -C /mnt/d/... status --short` 全量修改时，CLI-Manager Git 面板应按 Windows/native 结果展示。

### Common Mistake: 只改 `collect_git_changes_from_repo` 导致面板无效果

**Symptom**：修复/过滤逻辑单测全绿，但 Git 面板 UI 行为不变。

**Cause**：面板真正调用的是 `git_get_changes` 的内联循环，不经过 `collect_git_changes_from_repo`（后者只服务 Replay 快照）。issue #85 首轮修复即踩此坑。

**Fix / Prevention**：过滤类逻辑提取为共享工具函数（现有范例：`is_nested_repo_entry`），两个循环各自调用；修改前 grep `statuses.iter()` 确认所有循环点。

---

## 嵌套 Git 子仓库过滤合约（issue #85）

### Signatures

```rust
/// 尾部 '/' 且目录内存在 .git（目录或文件形式，覆盖 submodule/worktree gitlink）→ true
fn is_nested_repo_entry(repo: &Repository, file_path: &str) -> bool

Git 文件 Diff 返回结构化展示结果：

```rust
GitFileDiffPayload { content: String, can_revert_hunks: bool }
git_get_file_diff(project_path: String, file_path: String, status: String) -> Result<GitFileDiffPayload, String>
```
```

### Contracts

- libgit2 `statuses()` + `recurse_untracked_dirs(true)` 下：普通未跟踪目录会被展开为文件条目；**只有嵌套 git 仓库**保留为带尾部 `/` 的目录条目（如 `sub-repo-a/`）。
- 命中 `is_nested_repo_entry` 的条目：`continue` 跳过，不进入 `GitFileChange` 列表。
- `git_get_file_diff` 的 `"U" | "??"` 分支：读取文件字节前有 `is_dir()` 兜底守卫，目录条目返回友好中文错误，而非原始 OS 错误（Windows 下曾表现为 os error 123/5/3，随环境浮动）。
- 未跟踪文本文件通过项目文本编码检测读取并生成全新增 Diff；二进制或无法解码内容返回稳定错误。
- 已跟踪非 UTF-8 文本的 UI Diff 可强制按文本生成并按检测编码解码；`can_revert_hunks=false`，前端必须禁用行级/Hunk 级 Patch 回滚，但整文件回滚仍可用。
- UTF-8 UI Diff 保持原 Patch 文本并返回 `can_revert_hunks=true`。
- Worktree Snapshot/恢复继续使用原 `format_diff_to_text_allow_empty` Patch 链路，不得消费转码后的 UI Diff。

### Validation & Error Matrix

| 条件 | 行为 |
|------|------|
| 条目尾部 `/` 且 `<dir>/.git` 存在 | 跳过，不进变更列表 |
| 条目尾部 `/` 但无 `.git`（理论不出现） | 保留，不误伤 |
| diff 请求路径为目录 | `Err("该条目是目录（可能为嵌套 Git 仓库），无法显示文件 diff")` |
| 非 UTF-8 文本 Diff | 返回可读 `content`，`canRevertHunks=false` |
| UTF-8 文本 Diff | 返回原 Patch `content`，`canRevertHunks=true` |

### Tests

- `commands::git::tests::collect_git_changes_skips_nested_repo_dir`（正例 + 反例）
- `commands::git::tests::is_nested_repo_entry_detects_nested_repo_dir_only`
- 手工夹具：`D:\github\nested-git-test`（一级/二级嵌套仓库 + node_modules 假 .git）

### 已知未覆盖（后续项）

- `parse_wsl_git_status`（WSL 链路）尚未过滤嵌套仓库条目（`?? dir/` 仍会进列表；diff 目录守卫可兜底不报错）。已记入任务 `07-05-feat-git-sub-repo-monitor` 一并处理。

---

## Git 分支菜单命令合约（V1.2.6）

### 1. Scope / Trigger

- Trigger: Git 变更面板新增分支列表、Fetch、checkout、本地新建分支能力，跨越 Tauri command、Rust Git 执行、Zustand store、React UI 和 i18n。
- Target: `src-tauri/src/commands/git.rs` 中 Git 面板相关命令；前端只通过 Tauri command 调用，不拼接 shell 命令。

### 2. Signatures

```rust
pub struct GitBranchInfo {
    pub name: String,
    pub branch_type: String, // "local" | "remote"
    pub current: bool,
    pub upstream: Option<String>,
    pub remote: Option<String>,
}

#[tauri::command]
pub async fn git_list_branches(project_path: String) -> Result<Vec<GitBranchInfo>, String>;

#[tauri::command]
pub async fn git_fetch(project_path: String) -> Result<String, String>;

#[tauri::command]
pub async fn git_checkout_branch(
    project_path: String,
    branch: String,
    remote: bool,
) -> Result<String, String>;

#[tauri::command]
pub async fn git_create_branch(project_path: String, branch: String) -> Result<String, String>;
```

### 3. Contracts

- `project_path` 是当前 Git 面板生效仓库路径：根仓库或已选子仓库。非仓库返回 `open_repo_failed:*` 或 Git 原始错误映射。
- `git_list_branches` 只读本地 Git 元数据，不触网；本地分支带 `current/upstream`，远程分支跳过 `*/HEAD`。
- `git_fetch` 执行 `git fetch --prune`，只刷新远端 refs，不 merge/rebase，不修改工作区文件。
- `git_checkout_branch(remote=false)` 执行 `git checkout <branch>`，不使用 force。
- `git_checkout_branch(remote=true)` 要求分支形如 `<remote>/<name>`，执行 `git checkout --track <remote>/<name>`。
- `git_create_branch` 执行 `git checkout -b <branch>`，从当前 HEAD 创建并切换。
- checkout/create 成功后前端必须刷新 changes、branch status、branch list 和 repository list；失败后至少刷新 changes、branch status、branch list，避免 UI 停留在半旧状态。

### 4. Validation & Error Matrix

| 条件 | 行为 |
|------|------|
| `branch` 为空 | `empty_branch` |
| `branch` 以 `-` 开头、含空白/control、`..`、`//`、`@{`、以 `/` 或 `.` 结尾、或含 `~`、`^`、`:`、`?`、`*`、`[`、反斜杠 | `invalid_branch` |
| `git check-ref-format --branch <branch>` 失败 | `invalid_branch` |
| `remote=true` 但分支没有 `<remote>/<name>` 结构 | `invalid_branch` |
| checkout 会覆盖本地改动 | `checkout_conflict`，不强制切换 |
| git 可执行文件不存在 | `git_not_found` |
| remote 不存在或不可访问 | `no_remote` 或 Git 原始错误映射 |

### 5. Good/Base/Bad Cases

- Good: 面板打开时读取分支列表；用户点击本地分支，后端普通 checkout，成功后 UI 当前分支与变更列表刷新。
- Good: 用户先 Fetch，再 checkout `origin/feature/x`，Git 创建本地跟踪分支并切换。
- Base: 没有远程分支时远程区显示空状态；Fetch 失败只提示错误，不影响已有工作区。
- Bad: 前端用字符串拼接执行 `git checkout ${branch}`。
- Bad: checkout 失败后仍显示目标分支为当前分支。
- Bad: 为了模拟 JetBrains Smart Checkout 在 Stage A 自动 stash 或强制 checkout。

### 6. Tests Required

- Rust 单测：合法分支名通过；空、`-bad`、空白、`..`、`:`、`\`、尾部 `/` 等非法分支名返回预期错误码。
- TypeScript：`npx tsc --noEmit` 验证 `GitBranchInfo` 与 i18n key 完整。
- Rust：`cargo check` 验证 Tauri command 注册和 Git 命令编译。
- 手动：Fetch 不修改 `git status --short`；本地 checkout 成功刷新；远程 checkout 建立 upstream；checkout 冲突时当前分支和文件内容不变。

### 7. Wrong vs Correct

#### Wrong

```typescript
// 前端不要直接拼命令，也不要绕过后端校验。
await invoke("run_shell", { command: `git checkout ${branch}` });
```

#### Correct

```typescript
await invoke("git_checkout_branch", {
  projectPath,
  branch: item.name,
  remote: item.branchType === "remote",
});
```

---

## Smart Checkout 命令合约（V1.2.6 Stage B）

### 1. Scope / Trigger

- Trigger: Git 分支切换遇到 `checkout_conflict` 时，前端提供用户确认后的 Smart Checkout。该流程会移动未提交改动，必须由后端按固定序列执行。
- Target: `src-tauri/src/commands/git.rs` 中 `git_smart_checkout_branch`；前端只能在用户确认后调用。

### 2. Signatures

```rust
#[tauri::command]
pub async fn git_smart_checkout_branch(
    project_path: String,
    branch: String,
    remote: bool,
) -> Result<String, String>;
```

### 3. Contracts

- 只在普通 `git_checkout_branch` 返回 `checkout_conflict` 后由 UI 弹窗确认触发；不要在普通点击分支时直接自动 stash。
- 后端执行顺序固定：
  1. `validate_branch_name_with_git(project_path, branch)`
  2. `git stash push -u -m "CLI-Manager smart checkout: <branch>"`
  3. 本地分支：`git checkout <branch>`；远程分支：`git checkout --track <remote>/<name>`
  4. `git stash apply stash@{0}`
- 不使用 `git checkout -f`。
- 不自动 `stash drop`。`stash apply` 成功后也保留 stash 记录作为用户兜底恢复点。
- 成功或失败后前端必须刷新 changes、branch status、branch list；成功还要刷新 repository list。

### 4. Validation & Error Matrix

| 条件 | 行为 |
|------|------|
| 分支名基础校验或 `git check-ref-format --branch` 失败 | `invalid_branch` |
| `remote=true` 但分支没有 `<remote>/<name>` 结构 | `invalid_branch` |
| `stash push` 失败 | `smart_checkout_stash_failed:*`，不切换分支 |
| `stash push` 输出 `No local changes to save` | `smart_checkout_stash_empty`，不切换分支 |
| stash 成功但 checkout 失败，stash apply 回原分支成功 | `smart_checkout_checkout_failed:*`，stash 保留 |
| stash 成功但 checkout 失败，自动 apply 回原分支也失败 | `smart_checkout_restore_failed:*`，提示用户检查 `git status` 和 `git stash list` |
| checkout 成功但 `stash apply` 失败或冲突 | `smart_checkout_apply_conflict:*`，目标分支已切换，用户需要解决冲突 |

### 5. Good/Base/Bad Cases

- Good: 用户点击分支，普通 checkout 返回 `checkout_conflict`，UI 弹确认；用户确认后 Smart Checkout stash、切分支、apply，最终目标分支生效且本地改动恢复。
- Base: 用户取消弹窗，当前分支和工作区不变。
- Bad: 普通 checkout 失败后前端直接自动调用 Smart Checkout。
- Bad: `stash apply` 成功后自动 `stash drop`，导致用户失去恢复点。
- Bad: checkout 失败后不尝试把 stash apply 回原分支。
- Bad: `stash apply` 冲突时复用 pull/rebase 冲突横幅或调用 `git_pull_abort` / `merge --abort`；该场景不存在可自动中止的 merge state。

### 6. Tests Required

- Rust 单测覆盖 `is_no_stash_created` 对 `No local changes to save` 的识别。
- `cargo check` 覆盖 Tauri command 注册和编译。
- `npx tsc --noEmit` 覆盖新增 store action、弹窗状态、i18n key。
- 手动验证：取消不改工作区；确认后目标分支生效；apply 冲突时 UI 提示且 Git 面板刷新。

### 7. Wrong vs Correct

#### Wrong

```typescript
// 用户只点了分支，前端自动 stash。风险太高。
await invoke("git_smart_checkout_branch", { projectPath, branch, remote });
```

#### Correct

```typescript
try {
  await checkoutBranch(branch.name, branch.branchType === "remote");
} catch (error) {
  if (String(error).includes("checkout_conflict")) {
    setSmartCheckoutTarget(branch);
  }
}
```

---

## Untracked File Delete Command Contract（V1.2.6）

### 1. Scope / Trigger

- Trigger: Git 变更面板允许从右键菜单物理删除未跟踪文件。
- Target: `src-tauri/src/commands/git.rs` 的 `git_delete_untracked_paths`；前端只能通过 Tauri command 调用，不拼接 shell 命令。

### 2. Signatures

```rust
#[tauri::command]
pub async fn git_delete_untracked_paths(
    project_path: String,
    paths: Vec<String>,
) -> Result<(), String>;
```

```typescript
await invoke("git_delete_untracked_paths", {
  projectPath,
  paths,
});
```

### 3. Contracts

- `project_path` 必须是当前 Git 面板生效仓库路径：根仓库或已选择的子仓库。
- `paths` 必须是 repo-relative 路径数组，由 Git 变更树里的未跟踪文件项产生。
- 后端必须在删除前重新读取当前 Git 状态，只允许删除状态仍为 `U` / `??` 的文件。
- 目录菜单不得传任意目录路径；前端应展开为该目录下的未跟踪文件路径数组。
- 删除后前端必须刷新 Git 变更列表，并从 `selectedUntracked` 中移除已删除路径。

### 4. Validation & Error Matrix

| Condition | Behavior |
|---|---|
| `paths` empty | No-op success |
| path empty | `empty_path` |
| path contains `..` | `path_escape` |
| path starts with `/` or `\` | `absolute_path` |
| Windows drive absolute path such as `C:/x` | `absolute_path` |
| project path missing | `path_not_found` |
| repo cannot open | `open_repo_failed:*` |
| path exists but is not currently untracked | `path_not_untracked` |
| target canonicalizes outside workdir | `path_outside_root` |
| target is a directory | `untracked_directory_not_supported` |
| missing path after stale UI | No-op success |

### 5. Good/Base/Bad Cases

- Good: right-click an untracked file, confirm Delete, backend verifies `U` / `??`, removes the file, and the panel refreshes.
- Good: right-click an untracked directory, confirm Delete, frontend passes only the untracked files under that directory.
- Base: file was already deleted outside the app before confirm; backend no-ops and refresh removes the stale row.
- Bad: using `git_discard_file` for untracked files; that command intentionally rejects `U` / `??`.
- Bad: accepting an arbitrary directory path and recursively deleting it without Git status membership checks.

### 6. Tests Required

- Rust unit test: deleting a repo-relative untracked file removes it from disk.
- Rust unit test: trying to delete a tracked file returns `path_not_untracked`.
- Reuse existing validation tests for `validate_repo_relative_path` and `remove_untracked_snapshot_file`.
- TypeScript: `npx tsc --noEmit` must cover store action, tree props, confirm dialog state, and i18n keys.
- Rust: `cargo check` must cover Tauri command registration.

### 7. Wrong vs Correct

#### Wrong

```typescript
// Do not route untracked deletion through tracked discard semantics.
await invoke("git_discard_file", {
  projectPath,
  filePath,
  status: "U",
});
```

#### Correct

```typescript
await invoke("git_delete_untracked_paths", {
  projectPath,
  paths: [filePath],
});
```

---

## SSH 远程 Git 全功能面板合约（Protocol 1.7）

### 1. Scope / Trigger

- 修改 `GitChangesPanel`、`gitStore`、Git Transport、`ssh_remote_git_request`、daemon Git lane 或 SSH Agent Git runner 时适用。
- SSH、本地和 WSL 共用一套面板行为；执行环境差异只能存在于 Transport/后端边界。

### 2. Signatures

```typescript
createGitTransport(
  projectRoot: string,
  remoteContext: SshRemoteGitContext | null,
  remoteRequired: boolean,
): GitTransport;
```

```rust
ssh_remote_git_request(consumer_id, ssh_launch, kind, payload) -> Result<Value, String>
```

### 3. Contracts

- SSH Git 要求 Agent capability `gitFull`，所有 Git 请求进入独立串行 Git lane；本地/WSL 继续调用既有 `git_*` command。
- `payload.rootPath` 必须与 `SshLaunchPlan.remote_path` 完全一致，`repoPath` 和文件路径只允许仓库内 POSIX 相对路径。
- SSH 根仓库的 `repoPath` 是合法空字符串 `""`，只有 `null` 表示没有生效仓库；Store action 禁止用 `!repoPath` 拒绝根仓库操作。
- `remoteRequired=true` 且 SSH context 未就绪时返回 `ssh_agent_context_unavailable`，禁止选择 LocalGitTransport。
- 写操作不自动重试；响应超时、通道关闭或读失败映射为 `remote_git_result_unknown`，先刷新真实状态。
- 未跟踪 Diff 禁止跟随 symlink；路径数组同时限制数量与总字节数。

### 4. Validation & Error Matrix

| 条件 | 行为 |
|---|---|
| Agent 缺少 `gitFull` | `ssh_agent_capability_missing:gitFull` |
| `rootPath != ssh_launch.remote_path` | `remote_git_root_mismatch` |
| SSH context pending/missing | `ssh_agent_context_unavailable`，不调用本地 Git |
| SSH 根仓库 `repoPath == ""` | 作为根仓库正常执行，不能静默 return |
| repo/file 路径越界、绝对路径、反斜杠、控制字符 | 稳定 `remote_git_*_invalid/confined` 错误 |
| 未跟踪 Diff 目标为 symlink/目录 | `remote_git_symlink_rejected` |
| 写响应结果不确定 | `remote_git_result_unknown`，刷新后由用户决定后续动作 |

### 5. Good / Base / Bad Cases

- Good: SSH 项目切换期间 context 为空，面板清空旧数据并阻断操作；context 就绪后才开始 15 秒低频轮询。
- Good: Stage/Commit/Pull 等写操作在 Agent Git lane 串行执行，完成后按动作刷新状态。
- Good: SSH 根仓库删除未跟踪文件时，空 `repoPath` 继续进入 Transport；嵌套仓库仍使用相对路径。
- Base: Agent 未安装或 capability 不兼容，显示本地化提示，本地和 WSL Git 不受影响。
- Bad: 将 SSH `remote_path` 传给 `git_get_changes` 或把 `remoteContext === null` 解释为本地项目。
- Bad: 对未跟踪 symlink 使用 `fs::read`，从而读取仓库外目标。
- Bad: 用 `if (!repoPath)` 判断仓库是否存在，导致 SSH 根仓库操作被静默跳过。

### 6. Tests Required

- `npx tsc --noEmit`。
- `cargo check --manifest-path src-tauri/Cargo.toml`。
- `cargo test --manifest-path src-tauri/ssh-agent/Cargo.toml --lib`。
- Agent 请求结构拒绝未知字段；路径、分支、patch、symlink 和输入上限有回归测试。
- Node 回归测试断言 SSH 根仓库的空 `repoPath` 不被 Store action 当成缺失值。
- GitNexus `detect-changes` 确认只影响预期 Git 面板、SSH bridge 和 Agent 流程。

### 7. Wrong vs Correct

#### Wrong

```typescript
return remoteContext
  ? createSshGitTransport(remoteContext)
  : createLocalGitTransport(projectRoot);
```

#### Correct

```typescript
return createGitTransport(projectRoot, remoteContext, remoteRequired);
```

仓库标识判空同样必须区分合法空字符串与缺失值：

```typescript
// Wrong: SSH 根仓库 repoPath === "" 会被误判。
if (!repoPath) return;

// Correct: 只有 null 表示当前没有仓库。
if (repoPath === null) return;
```
