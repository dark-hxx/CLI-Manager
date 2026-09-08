# 三方冲突编辑器研究

## 1. 结论

三方冲突编辑器可作为独立后续父任务实施，但不能建立在当前文本 Diff 回滚接口上。正确边界是后端生成的只读 conflict session，加四个显式动作：保存 Result、标记已解决、继续 rebase、交接 merge commit。首期只支持 UTF-8 普通文本；本地、WSL、SSH 共享前端契约，写操作不自动重试。

## 2. 证据与现状

| 触点 | 现状 | 结论 |
|---|---|---|
| `src/lib/types.ts` | `GitFileChange.status` 包含 `C`；`pendingOp` 只有 `merge/rebase/null` | 首期 operation 不假装支持 cherry-pick/revert |
| `git_branch_status` | libgit2 RepositoryState 检测 merge/rebase | operation 必须由后端证明，前端不猜 `.git` 文件 |
| `GitChangesPanel.tsx` | 展示冲突横幅，支持 abort 和 rebase continue | merge 没有 continue；冲突解决后走现有 commit 流程 |
| `GitTransport` | 有 stage、pullAbort、rebaseContinue，无冲突读取/保存 | 必须增加窄 conflict capability，不复用通用文件写入 |
| Desktop `git.rs` | 能列出冲突状态，但没有 index stage 1/2/3 读取 | 不能从工作区 marker 反推三侧内容 |
| SSH Agent `git.rs` | 写操作经 Git lane 串行，且高风险请求不自动重试 | conflict save/resolve 必须沿用相同结果未知规则 |
| `FileEditorPane` | 有 Monaco 保存与文件状态 | 只复用 Result 编辑器语义，不接入其普通文件会话 |

GitNexus 的 TypeScript FTS 在本机不可用；按降级规则使用 fast-context 定位状态、面板、Transport、Desktop 和 Agent 调用链，并用 `rg` 确认仓库没有 stage 1/2/3 blob 读取或 conflict session。后续写任务风险为 CRITICAL，修改每个入口前必须重新执行 impact。

## 3. Git 角色语义

- index stage 1 = Base，stage 2 = Ours，stage 3 = Theirs；add/delete 冲突可能缺失一侧。
- merge 中 Ours 通常是当前分支，Theirs 是合入分支。
- rebase 中 Ours 通常是已重放到的 upstream 侧，Theirs 是当前正在重放的原分支提交，不能固定翻译为“我的/对方的”。
- 主标签始终使用 `Base / Ours / Theirs / Result`。只有后端返回可证明的 ref/commit 时，才显示 `Current branch`、`Replayed commit` 等副标签。
- 不从 `<<<<<<<` marker 推断角色；marker 可被编辑、嵌套或出现在普通文本中。

## 4. 数据契约

```ts
interface GitConflictSession {
  conflictId: string;
  contextKey: string;
  repositoryId: string;
  path: string;
  operation: "merge" | "rebase";
  base: GitConflictSide | null;
  ours: GitConflictSide | null;
  theirs: GitConflictSide | null;
  result: GitConflictResult;
  indexFingerprint: string;
}

interface GitConflictSide {
  blobId: string;
  mode: number;
  content: string;
  label: string | null;
}

interface GitConflictResult {
  content: string;
  worktreeFingerprint: string;
  encoding: "utf-8" | "utf-8-bom";
  lineEnding: "lf" | "crlf" | "mixed";
  finalNewline: boolean;
  executable: boolean;
}
```

- `conflictId` 由后端基于 context、repository、canonical path、operation、stage blob ids/modes 和 worktree fingerprint 生成，前端只回传。
- 缺失 Base/Ours/Theirs 用 `null` 表达，不用空字符串。
- response 和所有 mutation 绑定 `contextKey + repositoryId + conflictId`，禁止切换仓库后复用旧会话。
- 前端只保存未提交的 Result 草稿；不把 stage blob、Transport 或回调放进 Zustand 持久化。

## 5. 请求与竞态

### Load

`loadConflict(repoId, path)` 在后端验证仓库相对路径、当前 operation 和 unresolved index entry，读取 stage 1/2/3 与工作区 Result，再生成 fingerprints。文件切换或重新加载后，旧 response 直接丢弃。

### Save Result

请求携带 `conflictId + expectedIndexFingerprint + expectedWorktreeFingerprint + content metadata`。后端依次执行：

1. 复核 operation、index stages、路径类型和两个 fingerprints。
2. 在相同执行环境创建有界备份：Desktop app data、WSL Linux 侧或 SSH Agent data root；返回 opaque `backupId`。
3. 在目标同目录写受限临时文件，flush、保留 mode 后做平台正确的原子替换。
4. 返回新的 worktree fingerprint；不 stage、不 continue。

任一前置不匹配返回 `git_conflict_changed`。SSH 超时/断线返回 `result_unknown`，客户端先 reload，绝不重放 save。

### Mark Resolved

必须是独立 conflict command，不能由前端组合通用 `stage(path)`。请求携带 save 后 fingerprint；后端复核仍为 unresolved、index 未变化、工作区仍是已保存内容，再对单路径执行 add。成功后 stage 1/2/3 被折叠，原 conflict session 立即失效。

### Continue / Complete

- rebase：所有 unresolved entries 为零后，用户单独触发现有 `rebaseContinue`。
- merge：没有 `merge --continue` capability；用户回到现有 commit 区显式提交 merge 结果。
- 不自动串联 save -> add -> continue/commit。

### Restore

自动恢复仅允许在 `backupId` 对应的 index stages 仍存在、index fingerprint 未变化且当前 worktree 匹配预期 fingerprint 时执行。`mark resolved` 后备份只能查看/导出，不能宣称恢复 stage 1/2/3；完整回退由用户显式 abort 整个 operation。

## 6. 文件与编码矩阵

| 情况 | 首期行为 |
|---|---|
| UTF-8 / UTF-8 BOM | 支持，保存保持 BOM |
| LF / CRLF | 支持，保持主换行和末尾换行 |
| mixed newline | 只读或明确选择规范化，默认不保存 |
| legacy/unknown encoding | 只读，转外部工具；不自动转码写回 |
| binary / image / Office / archive / audio / video | 拒绝进入文本合并器 |
| symlink / submodule / directory conflict | 拒绝普通文本写入 |
| executable mode | 原子替换保留现有 mode；变更 mode 另行处理 |
| 只读/权限不足 | load 可读则只读；save 返回稳定错误 |
| 超限 | 拒绝完整编辑，不截断后保存 |
| 缺失某一 stage | 显式空侧占位，仍保留其余 blob 身份 |

首期沿用文本 Diff 的 768 KiB/20000 行作为最大候选上限，并额外以 Result UTF-8 字节数校验请求。正式任务可收紧，不能放宽且不能截断可写内容。

## 7. UI 与模块职责

JetBrains 风格布局采用 Ours | Result | Theirs 三列，Base 作为可切换参考，而不是同时挂载四个完整编辑器。窄窗口改为输入侧 tabs + Result，不压缩到不可用宽度。

```text
GitConflictEditorHost          // transport lease + session identity
  GitConflictWorkspace        // responsive composition only
  useGitConflictSession       // load/save/resolve lifecycle + tokens
  GitConflictInputPane        // one read-only Base/Ours/Theirs view
  GitConflictResultEditor     // Monaco editable Result only
  GitConflictActions          // save/resolve/abort/continue handoff
  GitConflictRecoveryDialog   // backup inspect/export/restricted restore
  gitConflictContracts.ts     // request/response/capability types
```

- Result Editor 不执行 Git 命令；Actions 不拼文件内容；Transport 不持有 React 状态。
- “接受 Ours/Theirs”只修改 Result 草稿，不立即写工作区。
- 单文件目标小于 200 行；达到 300 行必须按上述职责继续拆分。

## 8. ADR 决策摘要

采用后端权威 conflict session 与乐观并发 token。加载、保存、标记解决、恢复和 operation 完成严格分离；保存前做环境本地备份和原子替换；首期只写 UTF-8 普通文本；SSH 写操作不自动重试。

拒绝方案：

- 解析工作区 conflict markers 代替 index stages。
- 保存后自动 stage/continue/commit。
- 复用普通文件保存或通用 stage 作为安全 conflict transaction。
- 把 Base/Ours/Theirs/Result 和 Git 状态全部堆进单一组件。
- 承诺在 mark-resolved 后用工作区备份恢复完整冲突 index。

## 9. 场景矩阵

覆盖本地/WSL/SSH、merge/rebase、add/add、modify/delete、delete/modify、缺失 stage、UTF-8 BOM、LF/CRLF/mixed、无尾换行、只读文件、symlink/submodule、二进制、超限、外部编辑器并发、generic stage、分支切换、abort、窗口关闭、分屏/Workspan、SSH 断线和结果未知。

任何 operation、index、worktree、project、host 或 repository identity 变化都会使会话失效，不能靠刷新 UI 后继续使用旧 token。

## 10. 后续垂直切片

1. `D09-A 只读冲突检查器`：读取 stage 1/2/3、正确标签、缺失侧、冲突导航和本地/WSL/SSH 对等；无写能力。
2. `D09-B 安全 Result 保存`：Result Monaco、token、环境本地备份、原子写、受限恢复；不 stage。
3. `D09-C 显式解决流程`：专用 mark-resolved、刷新、rebase continue 和 merge commit 交接；不自动连锁。

二进制、非 UTF-8 写回、rename/rename、目录冲突和 AI 自动合并必须是独立任务，不能扩大首个可写切片。
