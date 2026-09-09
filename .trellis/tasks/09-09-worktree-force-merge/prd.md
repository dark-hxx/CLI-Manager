# Worktree 强制合并按钮

## Goal

当 Worktree 完成流程在主工作区存在未提交改动时，用户可以在确认风险后继续合并，同时不丢失主工作区原有改动，也不破坏现有的安全合并流程。

## Background and confirmed facts

- 当前完成流程位于 `src/features/projects/api/WorktreeFinishDialog.tsx`：先提交 Worktree 改动，再合并，最后清理 Worktree。
- 前端 Store 的 `mergeWorktree`（`src/features/projects/api/worktreeStore.ts:327-334`）调用 Tauri command `git_worktree_merge`。
- Rust 合并入口为 `src-tauri/src/features/projects/worktree.rs:794-865`。它先执行 `git status --porcelain`，主工作区不干净时返回 `dirty_main_worktree`，不会执行 checkout 或 merge。
- Worktree 合约要求普通合并在主工作区不干净时停止；当前错误文案明确告知用户提交、暂存或处理主工作区改动后重试（`.trellis/spec/backend/worktree-isolation-contracts.md`）。
- Worktree 右键菜单在 `src/features/projects/components/SidebarView.tsx:498-530` 打开完成对话框；完成对话框由 `SidebarView.tsx:905-910` 挂载。
- Worktree 用户可见文案分别维护在 `src/shared/i18n/messages/projects.zh-CN.ts` 与 `projects.en-US.ts`。
- GitNexus 关键词索引缺少 LadybugDB FTS 扩展，修复索引失败；本次发现清单使用契约文档和 `rg` 结果交叉确认。

## Requirements

- R1. 保留现有“合并到主工作区”按钮的安全行为：主工作区有未提交改动时仍返回并展示 `dirty_main_worktree`，不自动升级为强制合并。
- R2. 在 `dirty_main_worktree` 错误状态下，完成对话框提供一个明确区分、需要用户主动点击的“强制合并”操作，并说明该操作如何处理主工作区改动；触发后必须二次确认。
- R3. 强制合并必须在 Git 边界执行，不能由前端拼接 shell 命令或仅绕过错误提示；需要保持 Worktree 分支、基础分支、主工作区路径校验和冲突回滚约束。
- R4. 强制合并不得静默丢弃主工作区已提交、未提交、已暂存或未跟踪的用户数据；失败时必须保留可恢复状态并给出下一步指引，不能自动清理 Worktree。自动恢复成功后保留 stash 恢复点。
- R5. 强制合并成功后，只有在主工作区改动的处理结果明确可恢复时，才允许进入现有清理步骤；强制合并失败或恢复改动发生冲突时保留 Worktree 记录。
- R6. 普通合并、无差异跳过、合并冲突自动中止和清理流程的现有行为保持不变。
- R7. 新增或修改的按钮、确认提示、状态说明、错误提示、无障碍标签同时覆盖 `zh-CN` 和 `en-US`。
- R8. 方案覆盖本地 PowerShell/CMD/Pwsh、主仓库与 linked Worktree（`.git` 为文件）、主工作区不同分支、已有 stash、主工作区含未跟踪文件，以及合并冲突和恢复冲突场景；WSL/SSH 等当前 Worktree 不支持的路径不因本需求获得隐式支持。

## Scenario matrix to verify

| 维度 | 必须确认的场景 |
| --- | --- |
| Window focus / split pane | 完成对话框在当前窗口、其他窗口焦点、不同分屏节点时都只操作目标项目路径 |
| Minimized / presentation | 普通窗口、最小化/托盘恢复、展开/折叠/紧凑侧栏均能进入同一完成流程 |
| Session / Workspan | 单会话、多会话、切换 Workspan 后 Worktree 记录和完成目标不串线 |
| Runtime | 本地 PowerShell、CMD、Pwsh；Git 命令仍由 Rust 参数数组执行 |
| Worktree | 主仓库、linked Worktree、主目录缺失/Worktree 缺失、`.git` 文件型 linked Worktree |
| Main changes | 已暂存、未暂存、未跟踪、已有 stash、与 Worktree 改动不冲突/冲突 |
| Merge result | 成功、无差异、分支不存在、合并冲突、恢复主工作区改动冲突 |
| CLI Hook | Claude/Codex hook 安装或未安装不改变合并语义 |

## Acceptance Criteria

- [ ] AC1 普通合并遇到主工作区未提交改动时仍安全停止，并显示现有指导。
- [ ] AC2 用户能在该错误状态主动触发强制合并，并在操作前看到风险确认；确认弹框阻止点击外部和 Escape 关闭，只能通过显式关闭、取消或确定操作退出。
- [ ] AC3 强制合并后主工作区原有改动按最终选定策略保留，且无法恢复时不被删除、状态和指引可操作。
- [ ] AC4 合并冲突、恢复冲突、分支缺失和路径缺失均不会误进入 Worktree 清理步骤。
- [ ] AC5 中英文界面文案和 aria 标签完整，TypeScript 与 Rust 定向检查通过。
- [ ] AC6 定向测试覆盖强制合并的 Git 状态序列和失败回滚；架构检查与 GitNexus 变更检测不出现非预期触点。

## Decisions

- 强制合并处理主工作区改动已确定为 A：临时 stash（包含未跟踪文件），合并成功后自动恢复；恢复冲突时保留 stash 并停在完成对话框。该选择优先保证数据可恢复，不采用直接绕过检查或要求用户手动恢复的方案。
- 强制合并需要二次确认：在同一完成对话框内明确提示“将暂存主工作区（包含未跟踪文件），合并后自动恢复；恢复冲突时不会清理 Worktree”，用户再次确认后才调用后端。确认弹框采用现有 `ConfirmDialog` 的 `explicitCloseOnly` 语义，点击外部或按 Escape 均不能关闭，只能显式关闭、取消或确定。
- 自动恢复成功后保留临时 stash，沿用现有 Smart Checkout 的恢复点策略，让 `git stash list` 保留一份兜底副本；用户接受 stash 列表会多一条记录，以换取应用崩溃或 Git 异常等极端情况下的恢复能力。

## Out of scope

- 不改变普通合并的默认安全门禁。
- 不为当前不支持的 WSL/SSH Worktree 增加另一套 Git Transport。
- 不自动删除主工作区改动、已有 stash、Worktree 目录或 `wt/*` 分支。
