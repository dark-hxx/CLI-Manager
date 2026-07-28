# 升级桌面应用版本至 V1.3.2

## Goal

统一 CLI-Manager 桌面应用 npm、Tauri 与 Rust 版本元数据为 `1.3.2`，使构建产物对应发布版本 `V1.3.2`。

## Confirmed Facts

- 当前桌面应用六处版本元数据均为 `1.3.1`。
- `CHANGELOG.md` 已存在 `V1.3.2` 版本段，不需要重复修改。
- SSH Agent 使用独立版本 `0.1.5`，桌面版本升级不得修改该版本。

## Requirements

- 将 `package.json` 顶层 `version` 更新为 `1.3.2`。
- 将 `package-lock.json` 顶层 `version` 与 `packages[""]` 根包版本更新为 `1.3.2`，不得修改依赖包版本。
- 将 `src-tauri/Cargo.toml` 的 `cli-manager` 包版本更新为 `1.3.2`。
- 将 `src-tauri/Cargo.lock` 中 `cli-manager` 根包版本更新为 `1.3.2`，不得修改其他同版本依赖。
- 将 `src-tauri/tauri.conf.json` 顶层 `version` 更新为 `1.3.2`。
- 保留 `CHANGELOG.md`、`src-tauri/ssh-agent/Cargo.toml` 和 `src-tauri/ssh-agent/Cargo.lock` 不变。

## Acceptance Criteria

- [x] 六处桌面应用版本元数据均精确等于 `1.3.2`。
- [x] npm 与 Tauri JSON 配置可正常解析。
- [x] `cargo check --locked --manifest-path src-tauri/Cargo.toml` 通过。
- [x] `git diff --check` 通过，变更范围仅包含五个版本文件和本 Trellis 任务文件。
- [x] SSH Agent 版本仍为 `0.1.5`，Changelog 的 `V1.3.2` 内容不变。

## Out of Scope

- 不创建发布标签、不推送远端、不执行 GitHub Release。
- 不修改产品功能、依赖版本或更新器签名配置。
