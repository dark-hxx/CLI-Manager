# Worktree 强制合并：技术设计

## 1. 目标与边界

本方案只扩展本地 Worktree 完成流程，不改变普通合并的安全门禁，也不为 WSL/SSH Worktree 增加支持。强制合并必须由 Rust 在 Git 边界执行，前端只负责展示状态、二次确认和调用 Tauri command。

## 2. 现有数据流

```text
WorktreeFinishDialog
  └─ useWorktreeStore.mergeWorktree
       └─ invoke("git_worktree_merge")
            └─ open_main_repo → status → branch/diff 校验
                 └─ checkout base branch → git merge
```

当前 `git_worktree_merge` 在 `git status --porcelain` 非空时返回 `dirty_main_worktree`，因此不会发生 checkout 或 merge。强制路径从同一个完成对话框开始，但使用独立 command，避免把普通流程变成隐式高风险流程。

## 3. IPC 合约

新增 command，输入保持与普通合并一致：

```rust
#[tauri::command]
pub async fn git_worktree_force_merge(
    project_path: String,
    worktree_branch: String,
    base_branch: String,
) -> Result<GitWorktreeMergeResult, String>;
```

`GitWorktreeMergeResult` 保留现有字段，并增加可选恢复状态的稳定字段；普通 command 也返回默认值，保持响应形状统一：

```typescript
interface GitWorktreeMergeResult {
  merged: boolean;
  output: string;
  conflictFiles: string[];
  skipped: boolean;
  skipReason: string | null;
  stashCreated: boolean;
  stashRestored: boolean;
  stashReference: string | null;
  stashRestoreConflictFiles: string[];
}
```

含义：

- `stashCreated`：本次强制流程是否保存了主工作区改动。
- `stashRestored`：该 stash 是否已成功应用回主工作区。
- `stashReference`：保留的 stash 提交 OID，便于用户在恢复冲突时手动处理；不自动 drop。
- `stashRestoreConflictFiles`：stash 应用失败后 Git 报告的未合并文件；可能为空，此时仍以 `output` 为准。
- 普通合并或没有产生 stash 的强制合并将 `stashCreated=false`、`stashRestored=false`；前端将“没有 stash 需要恢复”视为安全完成条件。

新增错误码只用于无法安全完成状态序列的情况：

| 错误码 | 语义 |
| --- | --- |
| `force_merge_stash_failed` | 主工作区改动未能保存，未开始 merge |
| `force_merge_stash_reference_failed` | 已尝试保存但无法取得稳定 stash 引用，未继续 merge |
| `force_merge_stash_incomplete` | stash 后工作区仍不干净，未继续 merge |
| `force_merge_checkout_failed` | stash 后切换基础分支失败，已尝试恢复主工作区 |
| `force_merge_abort_failed` | merge 失败后无法确认完成 `merge --abort`，保留 stash 并停止 |
| `force_merge_restore_failed` | merge/checkout 失败后 stash 无法恢复，保留 stash 并停止 |
| `force_merge_failed` | 非冲突 merge 失败，已尝试 abort 和恢复 stash |

错误字符串保留 Git 最终错误尾部和 stash OID（若已创建），前端不依赖原始英文文案判断流程。

## 4. Rust 状态序列

在 `src-tauri/src/features/projects/worktree.rs` 中提取共享的内部合并流程，普通 command 使用 `allow_dirty=false`，强制 command 使用 `allow_dirty=true`：

1. 校验 `wt/` 工作树分支和基础分支，打开主仓库并规范化项目路径。
2. 检查两分支存在，并先检查内容差异。无差异时直接返回 `skipped/no_diff`，不创建 stash、不 checkout、不 merge。
3. 读取主工作区状态。
   - 普通流程：非空立即返回既有 `dirty_main_worktree`。
   - 强制流程：非空时执行参数数组 `git stash push --include-untracked --message <固定说明>`。
4. 通过 `git rev-parse --verify refs/stash` 保存本次新 stash 的 OID；确认 stash 后主工作区已清洁。stash 创建成功后始终保留，不自动 drop。
5. 如当前分支不是基础分支，切换到基础分支；失败时不执行 merge，尝试用 `git stash apply --index <stashOid>` 恢复，并按恢复结果返回稳定错误。
6. 执行现有的 `git merge --no-ff --no-edit <worktreeBranch>`。
   - 成功：若有 stash，执行 `git stash apply --index <stashOid>`。
   - 冲突：读取 `conflict_files`，立即执行 `git merge --abort`，然后恢复 stash；merge 冲突和 stash 恢复冲突分别记录。
   - 其他失败：立即 abort，然后恢复 stash；任何恢复失败都保留 stash 并阻止清理。
7. merge 成功但 stash apply 失败时，返回 `merged=true`、`stashRestored=false` 和恢复冲突文件，不把流程推进到 Worktree cleanup。主分支的 merge 结果不回滚，因为此时 merge 已完成；保留的 stash 是用户恢复原改动的兜底。
8. 在进程内用同一把合并操作锁串行化普通/强制 Worktree merge，避免两个完成对话框交错执行 stash、checkout、merge 序列。外部 Git 进程仍由每个状态边界的重新检查和 Git 原始错误负责暴露。

所有 Git 参数使用 `Command::new("git").args([...])`，不通过 shell 拼接；主项目路径继续经过既有本地路径、仓库根目录和分支校验。`--include-untracked` 不包含 ignored 文件，避免把构建产物等忽略内容纳入恢复协议。

## 5. 前端交互

### 5.1 Store

在 `worktreeStore.ts` 增加 `forceMergeWorktree`，调用新 command；不复用普通 action 的隐式 force 参数，避免其他调用方绕过安全门禁。

### 5.2 完成对话框

在 `WorktreeFinishDialog.tsx`：

- 为结构化完成错误增加稳定 `code`，只在 `dirty_main_worktree` 时显示“强制合并”按钮。
- 点击按钮只打开二次确认，不调用 Git。
- 使用现有 `ConfirmDialog` 并设置 `explicitCloseOnly`：点击遮罩和按 Escape 都不能关闭；只能点击关闭/取消/确定等显式操作。确认按钮进入 busy 状态后禁用重复操作。
- 确认后调用 `forceMergeWorktree`，复用普通 merge 结果处理。
- `merged=true && (!stashCreated || stashRestored)` 才进入现有 cleanup；`stashRestoreConflictFiles` 非空或 `stashCreated && stashRestored=false` 显示恢复冲突并停留在对话框，保留 Worktree。
- merge 冲突仍显示已有冲突文件和自动 abort 说明；强制流程额外显示 stash 已保留，指导用户检查 `git stash list`。
- 关闭/取消确认不改变任何 Git 状态；普通 merge 的所有路径保持原行为。

### 5.3 国际化

在 `projects.zh-CN.ts` 和 `projects.en-US.ts` 同步加入强制合并按钮、确认标题/正文、stash 处理状态、恢复冲突和操作失败文案，并为新增操作提供可访问名称。

## 6. 场景与兼容性

- 当前窗口、其他窗口焦点、分屏和 Workspan 切换只影响弹层呈现，不改变 `finishTarget` 指向的项目路径。
- 最小化/托盘恢复、侧栏展开/折叠/紧凑模式复用同一对话框挂载。
- 主仓库当前分支不是 `baseBranch` 时先 stash 再切换；无法切换或恢复时不清理 Worktree。
- 已暂存、未暂存和未跟踪改动均由 stash/apply 处理；已有 stash 不用 `stash@{0}` 作为唯一身份，而使用本次创建后的 OID，避免已有 stash 顺序变化导致误应用。
- Worktree 的 `.git` 文件型 linked Worktree 不改变主仓库合并入口；缺失目录、非仓库、分支缺失继续返回既有错误并禁止清理。
- 本地 PowerShell/CMD/Pwsh 和 Claude/Codex Hook 安装状态不改变 Rust Git 语义。
- WSL/SSH 项目仍由现有 capability/路径边界阻断，不进入本 command。

## 7. 回滚与失败边界

- 任何 stash 保存失败、checkout 失败、merge 非成功或 abort 失败都不调用 Worktree remove，也不删除 `wt/*` 分支。
- stash apply 成功后仍保留 stash；应用崩溃或后续异常可通过 Git stash 恢复。
- merge 已成功但 stash apply 冲突时不尝试伪造 abort；让用户处理当前主工作区和保留 stash，再重新打开完成流程检查无差异并清理。
- 本需求无数据库迁移。若实现需要回退，可同时移除新增 command 注册、Store action、确认 UI 和 i18n，不影响已有 Worktree 记录。

## 8. 发现清单

| 触点 | 状态 |
| --- | --- |
| `src-tauri/src/features/projects/worktree.rs` 合并命令、Git helpers、Rust tests | 已确认相关 |
| `src-tauri/src/lib.rs` Tauri command 注册 | 已确认相关 |
| `src/features/projects/api/worktreeStore.ts` IPC Store action/result | 已确认相关 |
| `src/features/projects/api/WorktreeFinishDialog.tsx` 完成步骤、错误映射、按钮 | 已确认相关 |
| `src/features/projects/components/SidebarView.tsx` Worktree 菜单和 Dialog 挂载 | 已确认相关，复用现有入口，无需新增菜单 |
| `src/shared/ui/ConfirmDialog.tsx` `explicitCloseOnly` | 已确认可复用 |
| `src/shared/i18n/messages/projects.zh-CN.ts` / `projects.en-US.ts` | 已确认相关 |
| `.trellis/spec/backend/worktree-isolation-contracts.md` | 已确认需补充新 command 合约 |
| `CHANGELOG.md` / `docs/功能清单.md` | 已确认交付时必须更新 |
| GitNexus | 已尝试 query/context；由于本机缺少 FTS 扩展且符号索引无法解析，改用契约与 `rg`，实现前仍运行 impact 并记录结果 |
