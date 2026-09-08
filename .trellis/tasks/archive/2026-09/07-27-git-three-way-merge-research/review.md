# Self Review

## Scope

- 本任务只产出研究、ADR 和后续垂直切片，不修改产品代码或依赖。
- 风险按 CRITICAL 处理，重点审查 Git 角色、竞态、恢复和远程结果未知。

## Acceptance

- [x] stage 1/2/3 与 merge/rebase 标签语义明确。
- [x] load/save/mark-resolved/restore/rebase continue/merge commit 交接均有边界。
- [x] operation、index、worktree 和 context 乐观并发 token 明确。
- [x] 编码、换行、文件类型、mode、权限和超限矩阵明确。
- [x] 本地、WSL、SSH 和断线结果未知纳入场景。
- [x] UI/Hook/Transport/Editor/Recovery 按职责拆分，设定 300 行硬审查线。
- [x] 后续三个切片可独立验收，首个切片完全只读。

## Findings

1. 原稿把“继续 merge/rebase”并列描述，但当前只有 rebase continue；merge 通过 commit 完成。
   - 修正：动作与后续切片改为 rebase continue 和 merge commit 交接。
2. 原稿暗示备份可以在 mark-resolved 后恢复冲突现场，但 `git add` 会折叠 stage 1/2/3。
   - 修正：自动恢复只允许在 unresolved index 仍存在时；之后只能查看/导出或 abort 整个 operation。
3. 复用普通 save + generic stage 会在两个命令之间留下竞态。
   - 修正：要求专用 mark-resolved command 复核 session 与保存后 fingerprint。
4. 四个版本若同时挂载完整编辑器会造成文件和 UI 膨胀。
   - 修正：Ours | Result | Theirs 主布局，Base 按需切换；只有 Result 使用可编辑 Monaco。

## Verification

- [x] fast-context 定位 pendingOp、冲突横幅、Transport、Desktop 和 Agent 触点。
- [x] `rg` 确认当前无 stage 1/2/3 blob 读取或 conflict session。
- [x] 核对当前 abort/rebase continue/commit 行为，不虚构 merge continue。
- [x] Trellis context、`git diff --check` 和提交范围将在提交前校验。
- [x] 无产品文件变更，因此无编译/运行测试要求。
