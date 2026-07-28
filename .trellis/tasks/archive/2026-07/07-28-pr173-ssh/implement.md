# Implementation Plan

1. 从 `origin/pr/173` 创建本地分支，合并 `origin/master`。
2. 手工解决 `CHANGELOG.md`，把双方内容归入单一 `V1.3.2`，清除所有 `[TEMP]`。
3. 在修改 `getRemoteHandoffEligibility` 前完成影响面复核；GitNexus 不可用时使用契约与精确搜索结果。
4. 删除 SSH 对 `task_state_unknown` 的特殊豁免，使本地与 SSH 共用失败关闭状态门禁。
5. 修改 `scripts/remoteHandoff.test.mjs`，覆盖 SSH 明确终态、运行态、未知态及缺少会话 ID 的顺序。
6. 运行目标 Node 测试、`npx tsc --noEmit`、`cargo check --locked` 和差异检查。
7. 运行 GitNexus `detect_changes`；若工具仍不可用，记录降级并使用 `git diff`、测试与契约核对范围。
8. 提交本地合并结果，提交信息关联 `PR #173`，不执行外部 push 或 GitHub merge。

## Risk Points

- Changelog 冲突可能重复标题或丢失 `master` 已有条目。
- 门禁判断顺序错误可能让缺少 `cliSessionId` 覆盖更重要的运行态错误。
- PR 跨 Rust/TypeScript 边界，虽只有 Changelog 冲突，仍需类型与 Rust 编译检查。

## Validation Commands

```powershell
node --test scripts/remoteHandoff.test.mjs
npx tsc --noEmit
Set-Location src-tauri; cargo check --locked
git diff --check
git status --short
```
