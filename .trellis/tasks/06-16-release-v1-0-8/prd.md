# 准备 V1.0.8 发布

## Goal

完成 CLI-Manager V1.0.8 发布准备，保证版本元数据、发布说明、提交与 tag 状态一致。

## What I already know

- 用户要求：更改版本号、编写 `CHANGELOG.md`、提交代码、创建 tag 并推送。
- 当前分支：`master`。
- 初始工作区干净；创建本任务后仅新增 `.trellis/tasks/06-16-release-v1-0-8/`。
- 本地 `HEAD` 为 `cf657a4 chore: release V1.0.8`，领先 `origin/master` 1 个提交。
- 本地和远端 `origin` 已存在 `v1.0.8` tag，tag 指向提交 `6fbb2cf`。
- `HEAD` 和 `v1.0.8` 指向的提交互不包含，但文件树相同。
- `package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json` 已是 `1.0.8`。
- `CHANGELOG.md` 已有 `V1.0.8` 发布说明。
- `package-lock.json` 根版本和 `packages[""].version` 仍是 `1.0.6`。
- `src-tauri/Cargo.lock` 中 `cli-manager` 包版本仍是 `1.0.7`。

## Requirements

- 将所有应用版本源统一为 `1.0.8`。
- 保留并核对 `CHANGELOG.md` 的 `V1.0.8` 发布说明。
- Git 操作必须避免盲目覆盖既有远端 tag。
- 提交和推送前必须明确当前 tag/分支策略。

## Acceptance Criteria

- [ ] `package.json`、`package-lock.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`、`src-tauri/tauri.conf.json` 应用版本一致为 `1.0.8`。
- [ ] `CHANGELOG.md` 包含 `V1.0.8` 发布说明。
- [ ] 工作区只包含本任务相关改动。
- [ ] 至少完成版本一致性检查。
- [ ] 提交策略和 tag 策略经用户确认后执行。

## Definition of Done

- 版本元数据一致。
- 发布说明存在且内容可读。
- 必要检查通过或失败原因明确。
- Git 提交、tag、push 操作仅在用户确认后执行。

## Out of Scope

- 不改动业务功能。
- 不新增依赖。
- 不强推 tag，除非用户明确确认。

## Technical Notes

- 发布版本源参考：`.trellis/spec/guides/version-update-checklist.md`。
- 远端 `origin/master` 当前为 `39b2a3a`。
- 远端 `origin` tag `v1.0.8` 当前存在。
