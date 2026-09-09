# Worktree 强制合并：执行计划

## 开始实现前

- [x] 用户已确认强制合并策略：stash 包含未跟踪文件，合并后自动恢复，stash 保留。
- [x] 用户已确认强制合并需要二次确认，确认框 `explicitCloseOnly`，点击外部和 Escape 不关闭。
- [x] 复核 `prd.md`、`design.md`、Worktree 后端合约和相关入口。
- [x] 对每个将修改的函数/组件运行 GitNexus upstream impact；`GitWorktreeMergeResult` 初始报告为 CRITICAL，进一步限定到直接依赖后为 LOW；其余符号因索引缺失未解析，已用契约与 `rg` 发现清单替代。
- [x] 运行 `python ./.trellis/scripts/task.py start`，将任务从 planning 激活为 in_progress。
- [x] 代码变更前确认 `CHANGELOG.md` 版本为 `V1.4.0`。

## 实现步骤

1. **Rust Worktree 合并流程**
   - 在 `src-tauri/src/features/projects/worktree.rs` 为结果增加 stash 状态字段。
   - 抽取普通/强制共用的内部合并流程，保留普通 `git_worktree_merge` 的 dirty-main 阻断行为。
   - 新增 `git_worktree_force_merge` command：分支/路径校验、无差异短路、stash（`--include-untracked`）、OID 捕获、checkout、merge、abort、stash apply（`--index`）和稳定错误映射。
   - 将本次合并使用的 stash OID 作为恢复身份；成功恢复后也不 drop。
   - 对 merge 相关 command 加入进程内串行锁，避免多个完成对话框交错操作同一主工作区。
   - 增加纯函数/临时 Git 仓库测试，覆盖 staged/unstaged/untracked 保存恢复、已有 stash、当前分支切换、merge 冲突 abort、stash 恢复冲突和普通 merge dirty 阻断。

2. **Tauri 注册与前端 Store**
   - 在 `src-tauri/src/lib.rs` 注册 `git_worktree_force_merge`。
   - 在 `src/features/projects/api/worktreeStore.ts` 同步 Rust result 字段，增加 `forceMergeWorktree` action，保持前端不拼接 Git 命令。

3. **完成对话框交互**
   - 在 `src/features/projects/api/WorktreeFinishDialog.tsx` 为错误保留稳定 code，只有 `dirty_main_worktree` 显示强制合并入口。
   - 加入确认状态和 `ConfirmDialog explicitCloseOnly`，取消/关闭只关闭弹框，确认后才调用 force action，并防止重复提交。
   - 分别处理普通合并冲突、stash 保存失败、恢复失败、恢复冲突和“合并成功但恢复冲突”状态；恢复未确认成功前不渲染 cleanup 操作。
   - `SidebarView.tsx` 只继续复用现有 `finishTarget` 入口和挂载点；除非类型编译证明需要，不改变 Worktree 菜单结构。

4. **文案与契约**
   - 在 `src/shared/i18n/messages/projects.zh-CN.ts` 和 `projects.en-US.ts` 增加按钮、二次确认、stash 保留/恢复、恢复冲突和下一步指引文案及 aria 文案。
   - 更新 `.trellis/spec/backend/worktree-isolation-contracts.md`，记录新 command、响应字段、stash/恢复状态、错误矩阵与禁止清理条件。
   - 按用户确认的版本更新 `CHANGELOG.md` 对应版本段；若未提供版本使用 `TEMP`。
   - 在 `docs/功能清单.md` 的 Worktree/Git 功能板块记录强制合并能力及安全恢复边界。

## 验证清单

### 定向验证

- [x] `rustfmt --edition 2021 --check src-tauri/src/features/projects/worktree.rs`
- [x] Worktree Rust 测试（`cargo test ... --lib force_merge_`，以及完整 Rust 测试）
- [x] `npx tsc --noEmit`
- [x] `git diff --check`

> 说明：完整 `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` 当前会报告仓库其他既有文件的格式差异；本任务涉及的 Rust 文件已通过定向 rustfmt 检查，未格式化无关文件。

### 交付前跨层验证

- [x] `cd src-tauri; cargo check`
- [x] `cd src-tauri; cargo test`（使用独立 target-dir，1284 passed、1 ignored）
- [x] `npm run check:architecture -- --strict`
- [x] `npm run report:architecture`
- [x] GitNexus `detect_changes` 检查；索引缺少新增符号且 FTS 修复不可用，结果为既有符号低风险、0 个受影响流程，已用定向 diff/契约复核降级处理。

### 手动场景

- [ ] 普通 merge 在主工作区有 staged、unstaged、untracked 改动时仍停止，不创建 stash、不改变主分支。
- [ ] 点击强制合并后确认框点击外部、按 Escape 均不关闭；取消/显式关闭不运行 Git，确定才运行。
- [ ] 非冲突强制 merge：主工作区所有改动恢复，merge 成功，stash 保留，进入 cleanup。
- [ ] 主工作区当前分支不是 base branch：stash、切换、merge、恢复顺序正确。
- [ ] Worktree 与主分支 merge 冲突：自动 abort，主工作区原改动恢复，Worktree 保留，不进入 cleanup。
- [ ] stash 恢复冲突：merge 结果不被误报为完全成功，保留 stash 和 Worktree，显示文件/命令输出及手动恢复指引。
- [ ] 无差异、分支缺失、主目录/Worktree 缺失和已有 stash 场景保持既有安全边界。
- [ ] 中英文切换后新增文案、按钮、aria 标签均完整；英文时间/其他无关格式不受影响。

## 风险与回滚点

| 阶段 | 风险 | 回滚点 |
| --- | --- | --- |
| stash | Git 无法保存或应用主工作区改动 | 保留 stash，停止后续步骤，不 checkout/merge/cleanup |
| checkout | base branch 不存在或切换失败 | 恢复 stash；失败时返回 stash OID 和指引 |
| merge | 冲突或非预期 Git 失败 | 立即 abort；恢复 stash；Worktree 和分支保持可重试 |
| restore | 与 merge 结果发生路径冲突 | 不伪造清理成功，返回 `stashRestoreConflictFiles`，保留 stash 和 Worktree |
| 前端状态 | 误把恢复冲突推进到 cleanup | 以 `!stashCreated || stashRestored === true` 作为 cleanup 推进条件，并加入 result 分支测试 |

## 任务完成条件

- [x] 代码、测试、i18n、后端合约、CHANGELOG 和功能清单均完成。
- [x] 定向与跨层验证通过，架构检查无新增豁免。
- [x] 运行 GitNexus `detect_changes` 并复核变更范围。
- [ ] 用户可在中英文界面完成一次普通阻断和一次确认后的强制合并流程；未确认前没有任何 stash/merge mutation。

> 手动桌面验收未由本次代理启动 Tauri 执行；代码和 Rust 临时 Git 夹具已覆盖状态序列，仍需用户在设置中切换中英文后按上方手动场景验收 UI 与真实窗口焦点行为。
