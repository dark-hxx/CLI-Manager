# Review

## Root Cause

SSH 长驻 PTY 不能证明 Codex 回合已经停止。原资格判断对 SSH 豁免了未知状态门禁，使 `notification = none` 且 PTY 仍运行或状态缺失的会话可继续托管，第二个 app-server 因而可能抢占仍由桌面进程持有的线程。

修复位于共享边界 `getRemoteHandoffEligibility`：本地与 SSH 都必须获得 Hook/daemon 的 `done` / `failed`，或 PTY 的 `exited` / `error`，否则失败关闭。后端预检和代理会话 ID 校验不能替代启动前的权威终态判断。

## Discovery List

- `src/lib/remoteHandoff.ts`：状态门禁与校验顺序的唯一根因点。
- `src/hooks/useRemoteHandoffCoordinator.ts`：消费资格结果，并仅在状态门禁通过后解析缺失的 SSH 会话 ID。
- `src-tauri/src/commands/cc_connect/handoff.rs`：预检验证平台、SSH 与 app-server 基础链路，不掌握桌面回合终态。
- `src-tauri/src/codex_app_server_proxy.rs`：代理严格绑定会话 ID，但不能证明原桌面进程已释放线程。
- `CHANGELOG.md`：唯一内容冲突；双方内容均归入单一 `V1.3.2`，无 `[TEMP]`。

## Risk

- GitNexus 对 `getRemoteHandoffEligibility` 的上游影响分析为 LOW：直接调用者是 `startHandoff`、`deriveDesktopPetSnapshot`，二级影响为 `snapshot`、`unlistenStart`。
- GitNexus 相对 `master` 检测整个 PR #173 为 CRITICAL：46 个文件、跨 Rust/TypeScript 和多个托管/会话流程。这是 PR 总体规模，不是本次状态门禁单点修复的风险等级。

## Verification

- `node --test scripts/remoteHandoff.test.mjs`：4/4 通过。
- `npx tsc --noEmit`：通过。
- `cargo check --locked`：通过。
- `git diff --check`：通过。
- `CHANGELOG.md`：无冲突标记，无 `[TEMP]`。

## Remaining Manual Verification

未执行真实 SSH 主机、Telegram、飞书、微信、企业微信的端到端人工冒烟；未执行前端或 Tauri build/dev 命令。
