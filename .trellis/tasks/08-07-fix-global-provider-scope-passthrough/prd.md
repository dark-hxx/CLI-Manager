# 修复跟随全局供应商仍走隔离快照启动

## Changelog Target

`[TEMP]`（与同批 Codex / Grok 两条供应商修复同段，见 `CHANGELOG.md:5-6`）

## Goal

让"应用到全局"的原生供应商真正表现为全局：跟随全局的项目启动任何 CLI 工具时不再生成一次性隔离快照、不再追加供应商参数，直接使用全局 writer 已写入真实 Home 的 live 配置；只有项目 / Worktree / 显式覆盖才走 scope prepare 生成隔离快照。同时修掉 `provider_current_not_set` 阻断从未 apply 过的用户的启动，以及会话恢复复用旧快照导致修复不生效 / 恢复失败 / 静默跑错供应商的问题。

## Requirements

### R1: 全局直通

- `prepare()` 在无 worktree / project / explicit 覆盖时直接返回 `None`，不查 `current_provider_id()`，不生成快照，不写 `--settings` / `-c` / `--model` / env 覆盖。
- 三个 app type（claude / codex / grokbuild）统一行为。Codex 已有 `codex_global_passthrough` 只管单一 app type，改掉之后去掉该专用函数。
- `provider_scope_resolve`（UI 探测）行为不变：仍可对跟随全局的项目返回 `source: "global"` + 当前全局供应商名。

### R2: 覆盖仍走快照

- 项目 / Worktree / 显式 provider ID 覆盖的 prepare 行为不变：Claude 生成 `--settings`，Codex 生成 `-c` 配置覆盖 + env key，Grok 生成 `GROK_MODELS_BASE_URL` / `XAI_API_KEY` + `--model`。

### R3: 会话恢复重新解析 scope

- `restoreSessions()` 重建 PTY 前 release 旧快照，传 `providerSnapshot: undefined` 让 `prepareProviderLaunchSnapshot()` 按当前覆盖状态重新解析。
- daemon attach 分支不动：进程仍活着，不得热切换。
- `resumeSessionFromRemoteHandoff()` Codex 分支已有形状校验，保持语义不变。
- 回写 `providerSnapshot` 去掉 `?? ps.providerSnapshot` / `?? lockedSession.providerSnapshot` 兜底，不允许旧快照引用残余在新会话对象上。

### R4: 跨环境

- 不做 Home 身份匹配判断。全局 apply 到哪个 Home 就在哪个环境生效，跨环境用不了是预期行为（需在设置里切 Home 再 apply）。与 Codex 现行语义一致。

## Acceptance Criteria

- [ ] 跟随全局的 Claude 项目启动命令为 `claude`（无 `--settings`），全局已 apply 的 endpoint/key/model 生效。
- [ ] 跟随全局的 Grok 项目启动命令无 `--model` / env 覆盖，全局已 apply 的配置生效。
- [ ] 从未 apply 过全局供应商的项目（`is_current` 未设置）也能正常启动终端（不再因 `provider_current_not_set` 报错）。
- [ ] 项目 / Worktree / 显式覆盖的启动行为不变：Claude 仍带 `--settings`，Codex 仍带 `-c` + env key，Grok 仍带 env + `--model`。
- [ ] `provider_scope_resolve` UI 探测行为不变：跟随全局的项目仍返回 `source: "global"` + 当前全局供应商名。
- [ ] 会话恢复丢弃旧快照，按当前覆盖状态重新解析；恢复后命令与新建终端一致。
- [ ] daemon attach 不热切换，进程继续跑原供应商。
- [ ] 旧快照（修复前创建的 `source=global` Claude 快照）恢复时被自动 release 并重建，不再带到新会话。
- [x] `cargo test`（scope 模块相关测试 + global 模块相关测试）、`cargo check`、`npx tsc --noEmit` 通过。

## Out of Scope

- 不改全局 writer 写入字段范围与 Home 选择语义。
- 不改 Codex 已修复的直通行为本身（只泛化条件）。
- 不改供应商目录 / Key / 通用配置 / Home 设置 UI。
- 不额外清理死代码（`appendProviderOverrideArgs` 的 `--profile` / `--settings` 分支等）。

## Design Decisions (all confirmed)

| # | 决策 | 选择 |
|---|------|------|
| D1 | 会话恢复如何处理旧快照 | 一律丢弃并重新解析；daemon attach 不动；回写去掉 `??` 兜底 |
| D2 | 短路放在哪一层 | `scope_override()` 抽取无覆盖→None；`prepare()` 不碰 `current_provider_id()`；`resolve()` UI 探测保持原样 |
| D3 | Windows Home vs WSL Home 不一致 | 接受，不加判断；与 Codex 一致；需分别在各自环境 apply |
