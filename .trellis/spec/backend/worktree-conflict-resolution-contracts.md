# Worktree Conflict Resolution Contracts

> V1.4.2 实现契约，2026-09-30。规范记录不代表原生功能/性能已全部验收；实际证据见任务的 `validation.md`。

## 1. Scope / Trigger

- 主检出完成流程遇到合并冲突，先证明主检出已恢复，再由用户进入隔离 Worktree 的冲突解决工作区；主检出恢复和隔离 Worktree 的应用自有 merge 是两个不同状态机。
- 实现入口：`src-tauri/src/features/projects/worktree_conflicts/` 的 `conflict_commands.rs`、`recovery_commands.rs`；共享仓库写入锁位于 `src-tauri/src/infrastructure/storage/repo_operation.rs`。命令中的阻塞 Git/IO 使用 `spawn_blocking`，不在 UI 线程同步执行。
- 不接管外部 merge/rebase/cherry-pick，不新增 SQLite 迁移、第三方依赖或终端会话类型，不扩大到 WSL/SSH Worktree。

## 2. Signatures

以下为 Tauri invoke 参数名，使用 camelCase；Rust 类型与 serde 定义以 `types.rs` 为准。`context` 必须包含 `projectPath`、`worktreePath`、`worktreeBranch`、`baseBranch`。表中 `S` 表示共同参数 `context, sessionId`，不是实际传输字段。

| 命令 | 参数 | 返回 |
|---|---|---|
| `git_worktree_probe_conflicts` | `context` | `Probe` |
| `git_worktree_prepare_conflicts` | `context, expectedHeadOid, expectedBaseOid, operationId` | `Snapshot` |
| `git_worktree_conflict_status` | `S, listSnapshotId, cursor, limit` | `Page` |
| `git_worktree_conflict_file` | `S, fileId, requestEpoch` | `{ requestEpoch, detail: Detail }` |
| `git_worktree_save_conflict_draft` | `S, fileId, version, draftRevision, choices, operationId` | `Draft` |
| `git_worktree_take_conflict_side` | `S, fileId, version, revision, side, operationId` | `Snapshot` |
| `git_worktree_resolve_conflict_file` | `S, fileId, version, revision, draftRevision, operationId` | `Snapshot` |
| `git_worktree_continue_conflicts` | `S, revision, message, operationId` | `Snapshot` |
| `git_worktree_abort_conflicts` | `S, revision, operationId` | `Snapshot` |
| `git_worktree_recheck_conflicts` | `S` | `Snapshot` |
| `git_worktree_release_conflicts` | `S, revision, operationId` | `Snapshot` |

主检出恢复另外使用 `git_worktree_recovery_probe(projectPath)` 与 `git_worktree_recovery_recheck(projectPath, stateToken, confirm)`，返回 `RecoveryStatus`；`stateToken` 对应 Rust `Option<String>`。`confirm=false` 仅尝试自动证明，显式确认仍须校验所展示状态的 token。不能把这些接口当作接管任意 merge 的入口。

## 3. Contracts

- 所有冲突/恢复命令的错误为 `{ code, detail }`；不得通过本地化 stderr 或文案猜测安全状态。普通既有 Worktree 命令的返回契约保持独立。
- `Snapshot`：`sessionId, revision, state, worktreeBranch, baseBranch, headOid, baseOid, total, resolved, unresolved, draftCount, listSnapshotId`。状态值使用 snake_case：`preparing/resolving/ready/committing/completed/aborting/aborted/recovery_required`。
- `Page`：`{ snapshot, files, nextCursor }`，每次 `1 <= limit <= 200`；以 `listSnapshotId` 防止拼接过期清单，不为每个文件启动 Git 子进程。`FileEntry` 包含 `fileId/displayPath/stages/capability/reason/resolved`，路径只用于显示，写操作只接受清单映射出的 `fileId`。
- `Detail` 包含版本、能力/原因、可选源内容、块、草稿、两侧是否存在及 marker size；调用方检查返回 `requestEpoch`，不得将过期内容回填当前文件。
- `Side` 为 `base_branch/worktree`；`Selection` 为 `{ kind: 'base_branch' | 'worktree' | 'both' }` 或 `{ kind: 'edited', text: string }`。在隔离 Worktree 执行 merge 时 stage 2 对应 Worktree、stage 3 对应目标分支；禁止按 UI 左右位置猜测 Git ours/theirs。
- 会话 `revision`、列表 `listSnapshotId`、文件 `version`、草稿 `draftRevision` 分工不同，不合并为单一全局版本。写入使用 `operationId` 与保存的 payload 证据处理重试，拒绝旧版本或同 ID 不同内容。
- 活跃指针为 `cli-manager-conflict-active.json`，数据位于 Worktree 私有 Gitdir 下 `cli-manager/conflict-resolution`；原始源、分页清单、草稿、写入意图与暂存回执是恢复依据，不以 UI store 为持久化事实来源。
- 保存部分块只更新草稿；确认完整结果后才写文件并精确暂存。选择缺失侧表示删除，不调用必然失败的缺失 stage checkout。关闭面板不 abort、不抛弃已保存草稿，也不自动调用 release。
- 专用 continue 校验完整索引/回执和显式确认后创建正确的双父提交；普通 stage-all/commit 不得绕过未完成 merge 闸门。隔离 Worktree 内提交成功不等于可清理：仍须返回主检出原有合并/恢复流程。
- 用户明确打开冲突工作区后，probe 为 none 才自动 prepare；managed 恢复当前会话，foreign/recovery 不自动接管。初始化保持单飞，仅加载一页元数据和首个未解决文件；组件卸载后禁止继续 prepare。
- “提交并合并到目标分支”明确串联 continue → release → host 身份校验 → 完成弹窗恢复/冲突/变更检查 → 原目标合并，仅尝试一次。保存返回与中止不携带目标合并意图；失败保留对应安全阻断，清理仍单独确认。
- 详情前后通过 `file_index_state(repo, path)` 强制 `index.read(true)`，仅查询目标路径 stage 0..3 并比对原始路径字节；禁止为只比较单文件的详情重复构建全仓库路径/OID Map，也禁止跨请求复用陈旧索引。写入、提交、恢复继续使用完整索引检查。此优化不意味着磁盘 I/O 为 O(1)。
- 源/结果 2 MiB、20,000 行、单行 64 KiB、2,000 块、JSON 8 MiB 是独立预算；超限按能力降级或拒绝写入，不截断后保存。保留 BOM、CRLF/LF、Unicode 和无尾换行语义。

## 4. Validation & Error Matrix

- 前端以当前冲突块的 Monaco 三栏展示目标原文、可编辑结果和 Worktree 原文，不再用独立输入框或手动编辑开关。可直接删改和粘贴两侧任意行，前后/下一未处理导航切块；未选择时仅预览双方拼接，不生成草稿选择、不计为已解决。编辑器展示使用 LF，写入按源换行恢复；切块释放模型并隔离撤销栈，自动保存回读相同内容不得卸载模型或重置光标。保持原有 edited 草稿/CAS/精确暂存协议，不扩大到非冲突文本编辑。

| 条件 | 要求 |
|---|---|
| registration、branch/path、common-dir/private Gitdir 身份不匹配 | `identity`；拒绝访问错误检出 |
| 活跃仓库写操作或未知外部 Git 操作 | `busy` / `foreign_operation`；不自动夺锁、abort 或 reset |
| 主检出恢复未证明完成 | `main_recovery_required` / 恢复接口的 `repository_recovery_required`；危险按钮和后端写入口保持阻断 |
| HEAD/MERGE_HEAD、索引、版本、源指纹或 CAS 失配 | `stale` 或 `recovery_required`；保留现场，不以重试覆盖 |
| 未知 fileId、路径越界、Git 元数据路径或目标索引路径非法 | 对应 `path_invalid` / `invalid_path`；不得写入清单之外或工作区之外 |
| 编辑预算超限、非法草稿、能力不支持或块未确认 | `limit_exceeded` / `invalid_draft` / `unsupported` / `unresolved`；不产生截断结果或部分暂存 |
| IO/Git 写失败或提交没有产生预期结果 | `io_failed` / `git_failed` / `commit_not_created`，必要时进入恢复状态；不伪报成功 |

具体错误码取决于失败所在边界；不得把整组错误码归并成自动重试或自动清理。symlink/junction、复杂 rename 和其他不支持形态按既有能力门禁处理，不能增加宽松路径兜底。

## 5. Good / Base / Bad Cases

- Good：主检出恢复验证通过 → 隔离 Worktree prepare 固定 OID → 逐块草稿 → 每文件确认/暂存 → 专用 continue → 回到原完成上下文合并与清理。
- Base：关闭后重开恢复自有会话；外部暂存变化被同一 Repository 句柄下的新索引读取发现，要求重检而非沿用旧详情。
- Bad：abort 失败仍显示“已恢复”；只因 index 没有 unmerged entries 就允许普通提交；取前三百条当全部文件；为提速跳过 fresh-index/回执检查。

## 6. Tests Required

以下是维护契约时的断言入口，不是自动执行全量测试的清单。当前用户要求由其启动运行验证，不自动编译、启动应用或压测。

- `file_tests.rs`：目标索引结果与全量状态的 stage/OID/mode 一致；外部 stage、删除及 Unicode 路径更新可见；NUL 路径拒绝而不 panic；源变化和 stage-all 导致旧写入失效。
- `write_tests.rs` / `commit_tests.rs` / `ordinary_write_tests.rs`：部分块不暂存，单文件精确暂存，缺失侧删除，普通写入口不绕过 merge，continue 双父与确认结果正确，hook/丢失响应可恢复。
- `abort_tests.rs` / `recovery_tests.rs` / `lifecycle_tests.rs`：只 abort 自有现场，失败持久化阻断；显式确认 token 失效时拒绝；关闭/recheck/release 不混淆生命周期。
- `prepare_tests.rs` / `index_tests.rs` / `session_tests.rs`：身份/路径门禁、固定 OID、分页完整可达、损坏元数据拒绝、恢复进度与 Git 一致。
- `performance_tests.rs` 与任务原始报告：分别呈现 prepare、原生命令详情与浏览器 UI 耗时；采样程序退出 0 不代表预算达标，1k/10k 不能替代 64,887 档，浏览器 IPC 替身不能替代 WebView2。

## 7. Wrong vs Correct

```rust
// Wrong: 为单文件详情构建所有路径/OID 的 Map，或仅使用跨请求缓存。
let all = session_store::index_state(repo)?;
let stages = all.get(path);

// Correct: 详情前后各自强制刷新，只取精确路径阶段并与清单比较。
let stages = session_store::file_index_state(repo, path)?;
// 写入/提交/恢复边界仍用完整 index_state，不用单文件检查替代。
```

Wrong：忽略 `merge --abort` 返回值并清掉 UI 错误即可继续。Correct：验证 abort 与恢复基线；失败保留持久化恢复闸门，重开弹窗也不能绕过。
