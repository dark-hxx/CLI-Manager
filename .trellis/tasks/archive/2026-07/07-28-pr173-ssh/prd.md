# 解决 PR173 冲突并收紧 SSH 托管资格

## Goal

在保留 PR #173 SSH Codex 远程托管能力的前提下，将该分支合入最新 `master`，解决冲突，并确保无法确认任务已停止时拒绝托管，避免中断仍由桌面 Codex 占用的远程会话。

## Background

- PR #173 头部为 `f2b01b5f`，当前 `master` 为 `550dabba`，共同祖先为 `692e9928`。
- `git merge-tree` 确认唯一内容冲突为 `CHANGELOG.md`；`src/lib/i18n.ts` 与 `src/stores/terminalStore.ts` 可自动合并。
- PR 在 `src/lib/remoteHandoff.ts` 中对 SSH 绕过 `task_state_unknown`，并在测试中允许 `notification = none`、`processStatus = running` 的会话托管。
- 后端明确指出第二个 app-server 可能中断仍由桌面 Codex 持有的线程，因此资格判断必须失败关闭。
- 当前 `master` 与 PR 头部的 `CHANGELOG.md` 均不存在 `[TEMP]` 标题；合并时仍需保证所有可能出现的 `[TEMP]` 内容并入 `V1.3.2`，且不留下 `[TEMP]`。

## Root Cause

根因位于前端托管资格状态边界：SSH Codex 的长驻 PTY 状态不能代表回合状态，但现有逻辑又把缺少 Hook/daemon 终态的 `none` 当成可托管，导致未知状态被错误放行；修复应落在 `getRemoteHandoffEligibility`，统一要求明确终态，而不是在启动或恢复失败后兜底。

## Requirements

- R1：从 PR #173 创建本地解决分支并合并最新 `master`，只按双方真实意图处理冲突，不丢失任一侧已发布内容。
- R2：`CHANGELOG.md` 只保留一个 `V1.3.2` 版本区，将 PR 新增/修复条目并入已有对应分类；所有 `[TEMP]` 条目必须迁入该版本并删除 `[TEMP]` 标题。
- R3：SSH 与本地 Codex 都只能在 `notification` 明确为 `done` 或 `failed`，或进程明确为 `exited` 或 `error` 时通过状态门禁。
- R4：`running`、`attention` 返回 `task_running`；`none` 且进程仍运行或未知返回 `task_state_unknown`。
- R5：缺少 `cliSessionId` 的 SSH 会话仍可在状态门禁通过后进入既有唯一身份解析流程；状态未知时不得先解析并放行。
- R6：保持 WSL、Worktree、SSH 主机、认证方式和本地托管现有约束，不引入依赖或配置迁移。

## Scenario Matrix

| 场景 | 预期 |
|---|---|
| SSH + Hook 明确 `done/failed` | 可继续校验并托管 |
| SSH + PTY 明确 `exited/error` | 可继续校验并托管 |
| SSH + `running/attention` | `task_running` |
| SSH + `none` + PTY `running` | `task_state_unknown` |
| SSH + `none` + PTY 状态缺失 | `task_state_unknown` |
| SSH + 缺少 `cliSessionId` + 明确终态 | 进入远端历史唯一绑定 |
| SSH + 缺少 `cliSessionId` + 未知/运行态 | 不绑定，不托管 |
| Local | 保持同一失败关闭规则 |
| WSL / SSH Worktree / 交互认证 | 保持不支持 |
| Hook 未安装或事件丢失 | 无权威终态，拒绝托管 |

## Discovery List

- [x] `src/lib/remoteHandoff.ts`：资格判断根因位置。
- [x] `src/hooks/useRemoteHandoffCoordinator.ts`：资格结果消费与 SSH 身份解析顺序；无需新增兜底。
- [x] `scripts/remoteHandoff.test.mjs`：状态矩阵回归测试。
- [x] `src-tauri/src/commands/cc_connect/handoff.rs`：后端预检不拥有桌面回合权威状态，确认不在此层补丁。
- [x] `src-tauri/src/codex_app_server_proxy.rs`：严格绑定会话 ID，但不能替代启动前终态判断，确认无需修改。
- [x] `CHANGELOG.md`：唯一合并冲突与版本归并目标。
- [x] `.trellis/spec/backend/ssh-remote-terminal-contracts.md`：Hook 未安装时实时状态不可用，支持失败关闭结论。
- [x] GitNexus：`getRemoteHandoffEligibility` 上游影响为 LOW；最终相对 `master` 的整个 PR 差异为 CRITICAL，已结合契约、源码、测试和 `git merge-tree` 复核。

## Acceptance Criteria

- [x] PR #173 与最新 `master` 合并后不存在未解决冲突。
- [x] `CHANGELOG.md` 的 PR 内容和 `master` 内容均保留在 `V1.3.2`，不存在 `[TEMP]`。
- [x] SSH `notification = none` 且进程运行/未知时返回 `task_state_unknown`。
- [x] SSH `done/failed` 或 PTY `exited/error` 时仍可通过状态门禁。
- [x] `running/attention` 仍返回 `task_running`。
- [x] 缺失 `cliSessionId` 不会绕过未知状态门禁。
- [x] `scripts/remoteHandoff.test.mjs` 通过。
- [x] `npx tsc --noEmit` 通过。
- [x] Rust 合并结果通过 `cargo check --locked`；未执行被禁止的前端/桌面 build/dev 命令。
- [x] 最终差异只包含 PR 合并、冲突解决、资格判断修复、测试、任务记录及必要 Changelog 调整。

## Out of Scope

- 新增远端任务状态查询协议。
- 支持 SSH Worktree、WSL、MFA 或交互式认证托管。
- 推送到贡献者 Fork 或直接合并 GitHub PR；本任务先产出本地可审查分支与提交。

## Changelog Target

`V1.3.2`
