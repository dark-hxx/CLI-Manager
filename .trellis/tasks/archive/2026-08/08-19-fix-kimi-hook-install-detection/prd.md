# 修复 Kimi Hook 安装状态检测

## Goal

让本地 Hook 设置中的 Kimi 状态与其他 CLI 保持一致，不因本机缺少 Kimi 可执行文件而把 Hook 配置状态错误折叠为“版本不支持”；同时保持 Kimi 配置写入的兼容性和安全边界。

## Background

- 当前 `build_kimi_status` 在读取 `config.toml` 前调用 `discover_kimi_executable`；找不到 Kimi、命令不可执行、缺少 `doctor` 能力都会返回同一个 `kimi_code_unsupported`，状态随后被强制改为 `HookInstallStatus::Unsupported`。
- Claude、Codex、Pi、Grok 的 Hook 状态检查以配置目录和配置文件为依据，不在状态读取阶段探测对应 CLI 可执行文件。
- 原 Kimi 集成在状态读取时运行 `kimi doctor --help`，安装写入前运行 `kimi doctor config <candidate>`；用户确认这两类 CLI/doctor 检测都应从本地 Hook 流程移除，因为检测耗时会拖慢状态刷新和 Hook 安装。
- 版本目标为 `V1.3.7`；交付时需将 `CHANGELOG.md` 中所有 `TEMP` 版本内容归并到 `V1.3.7`，并保留已有未提交内容。

## Root-Cause Statement

缺陷位于本地 Hook 管理边界：状态读取和安装写入都与 Kimi CLI/doctor capability 检查耦合，导致“CLI 不存在”和“旧版 CLI 不支持”在配置解析前变成 `unsupported`，并让外部子进程延迟进入每次刷新和安装；修复应在本地 Hook 管理层移除该外部检测，同时保留结构化 TOML、live-file 重验和原子替换，而不是在前端改标签或吞掉错误。

## Discovery List

- [x] `src-tauri/src/commands/hook_settings.rs::hook_settings_get_status`：本地五种 Hook 状态的 IPC 聚合入口。
- [x] `src-tauri/src/commands/hook_settings.rs::build_kimi_status`：错误耦合发生点；负责 Kimi `config.toml` 的只读状态检查。
- [x] `src-tauri/src/commands/hook_settings.rs::discover_kimi_executable` / `kimi_doctor_capability`：当前同时表示“未安装”和“版本不支持”。
- [x] `src-tauri/src/commands/hook_settings.rs::install_kimi_hooks` / candidate validation：用户确认移除本地 CLI/doctor capability 与 candidate validation。
- [x] `src/components/settings/pages/HookSettingsPage.tsx`：`unsupported` 会禁用 Kimi 模块级和全量安装按钮；后端不再为本地 Kimi CLI 缺失返回该状态，因此无需修改前端。
- [x] `src/lib/hookErrors.ts`、`src/lib/i18n.ts`：`kimi_code_unsupported` 仍可能供 SSH/其他 Kimi 错误链路使用，本次不删除公共双语映射。
- [x] `.trellis/spec/backend/cli-hook-contracts.md`：现有契约要求 Kimi install candidate 通过 doctor 校验。
- [x] SSH Agent Kimi Hook：独立远端能力检查链路，本地缺陷未触达，确认不在本次范围。
- [x] `CHANGELOG.md`、`docs/功能清单.md`：版本归并与功能记录交付触点。

## Requirements

1. 本地 Kimi Hook 的只读状态不得仅因 Kimi 可执行文件缺失而错误显示“版本不支持”。
2. Kimi `config.toml` 中未安装、部分安装、完整安装、冲突或陈旧条目继续由结构化 planner 判定。
3. 不修改 Claude、Codex、Pi、Grok 的现有状态行为，不影响 SSH Kimi Hook 链路。
4. 本地 Kimi Hook 安装不得调用 Kimi 可执行文件、`kimi doctor --help` 或 `kimi doctor config`；安装只依赖 CLI-Manager 的结构化 TOML planner、live-file 重验和原子替换。
5. 删除仅服务于本地 capability/candidate 检测的死代码和过时测试，增加聚焦回归测试，覆盖无 Kimi CLI 时的状态、首次安装、重复安装、卸载和 live-file 竞争保护。
6. `CHANGELOG.md` 使用 `V1.3.7`，收集全部 `TEMP` 内容并去除重复版本标题；`docs/功能清单.md` 在 Hook 对应板块记录修复。
7. 保留工作区原有 `AGENTS.md`、`CLAUDE.md` 和 `CHANGELOG.md` 未提交修改，不覆盖无关内容。

## Acceptance Criteria

- [x] 未安装 Kimi CLI 时，本地 Hook 状态按 `config.toml` 内容正常返回，不再无条件显示 `unsupported`。
- [x] 已有 Kimi Hook 配置仍能准确区分 `notInstalled`、`partialInstalled`、`installed`。
- [x] 本地 Hook 状态与安装路径均不启动 Kimi/doctor 子进程；无 Kimi CLI 时仍可检查和安装 Kimi Hook。
- [x] TOML 解析失败、owner conflict、live config 竞争或原子替换失败时仍不覆盖用户配置。
- [x] 相关 Rust 聚焦测试、`cargo fmt --check`、适用的 Rust check/test、`git diff --check` 通过，环境阻断单独报告。
- [x] GitNexus impact 在编辑前完成，`detect_changes` 在交付前确认影响范围。
- [x] `CHANGELOG.md` 中不再存在 `TEMP` 版本标题，相关内容统一位于 `V1.3.7`；`docs/功能清单.md` 已更新。

## Out of Scope

- SSH Agent 的 Kimi capability/doctor 校验行为；远端仍按现有契约检查 Kimi capability 和 candidate。
- 旧 `~/.kimi` 迁移、Kimi history、provider switching、statusline。
- Hook 设置页整体重构或其他 CLI 的安装流程变更。
