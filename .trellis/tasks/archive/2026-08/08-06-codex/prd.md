# 修复原生 Codex 供应商全局配置与实时统计回归

## Changelog Target

`[TEMP]`

## Goal

使用 CLI-Manager 原生供应商并“应用到全局”后，新启动的 Codex 必须继续使用所选供应商，同时完整保留用户真实 Codex Home 中的 MCP、Hook、沙箱策略和会话历史能力，使实时统计恢复正常。

## Confirmed Facts

- 用户真实配置 `C:\Users\1\.codex\config.toml` 仍包含 `sandbox_mode = "danger-full-access"`、完整 `[mcp_servers.*]`、`[features] hooks = true` 和 Hook 信任状态；全局 writer 没有直接删掉这些配置。
- `provider::global::materialize_codex_config(Some(live), ...)` 以真实配置为输入，只覆盖供应商拥有的字段，并有保留 MCP/未知 TOML 段的单元测试。
- 本分支 `terminalStore.prepareProviderLaunchSnapshot()` 对所有带 CLI 类型且有启动命令的本地项目调用 `provider_scope_prepare`，包括没有项目/Worktree 覆盖、仅跟随全局供应商的项目。
- `provider::scope::prepare()` 对 Codex 生成临时 Home；`write_snapshot_bundle()` 使用 `materialize_codex_auth(None, ...)` 和 `materialize_codex_config(None, ...)`，没有读取真实 Home。
- PTY 启动随后把 `CODEX_HOME` 指向该临时目录。目录只要求存在 `auth.json` 与 `config.toml`，不会带入真实 Home 的 `hooks.json`、MCP/沙箱等非供应商配置或历史目录。
- 实时统计依赖 Codex Hook 上报 `sessionId`，再从历史会话读取 Token；临时 Home 缺少 `hooks.json` 且会改变历史落盘根目录，因此 Hook 绑定和历史读取同时可能失效。
- 该问题是行为回归、跨越前端启动解析、Tauri IPC、供应商 scope materialization、PTY 环境和历史/Hook 边界，必须走根因修复。

## Root-Cause Statement

缺陷位于供应商 scope 到 PTY 启动环境的边界：全局选择被错误地当成隔离 scope，并通过临时 `CODEX_HOME` 替换真实 Codex Home；修复必须落在 scope 解析/启动投影层，不能在 MCP、沙箱或实时统计消费者处分别加兜底。

## Requirements

1. 跟随原生全局供应商的 Codex 启动不得切换到只含供应商文件的临时 `CODEX_HOME`。
2. 新启动 Codex 使用全局 writer 已物化到真实 Home 的供应商模型、endpoint 和活动 Key。
3. 真实 Home 中的 MCP、`hooks.json`、`[features].hooks`、Hook 状态、`sandbox_mode`、`approval_policy`、项目信任、插件、技能和未知配置继续生效。
4. 实时统计继续通过既有 Hook `sessionId` 绑定和真实历史根目录工作，不新增统计侧兜底。
5. 已运行终端不热切换；仅未来启动和恢复启动采用修复后的解析结果。
6. SSH 启动继续不接收本地供应商快照或密钥；WSL/显式 Home 仍遵守 `CliHomeResolver`。
7. 不读取或修改用户密钥内容用于诊断输出；测试使用临时目录和虚构密钥。
8. 项目与 Worktree 显式 Codex 供应商覆盖也不得通过替换 `CODEX_HOME` 实现；使用 Codex 启动期配置覆盖，只投影供应商拥有的 `model`、`model_provider`、`model_providers` 和活动 Key。

## Acceptance Criteria

- [ ] 全局 Codex 供应商应用后，从普通项目启动 Codex，进程不被指向供应商临时 `CODEX_HOME`，且供应商 endpoint/model/key 生效。
- [ ] 同一次启动可发现原配置中的全部 MCP，而非仅加载临时配置内容。
- [ ] `sandbox_mode = "danger-full-access"` 和现有 approval policy 生效，不再出现由配置缺失触发的沙箱类型选择。
- [ ] 用户级 `hooks.json` 与 `[features].hooks` 生效，Hook 能绑定 `sessionId`，实时统计重新显示当前会话 Token。
- [ ] Codex resume/会话恢复沿用相同规则，不回退到临时 Home。
- [ ] 项目/Worktree 显式供应商覆盖不修改 `CODEX_HOME`，供应商 endpoint/model/key 生效，同时继承真实 Home 的 MCP、Hook、沙箱和历史。
- [x] Rust 相关单元测试、`cargo check`、`npx tsc --noEmit` 和相关脚本测试通过。

## Scenario Matrix

- 供应商来源：全局跟随 / 项目覆盖 / Worktree 覆盖 / 显式恢复 provider ID。
- 启动方式：新会话 / Codex resume / 应用重启后的会话恢复。
- Home：默认 Windows Home / 手动 Windows Home / WSL Home。
- Hook：完整安装 / 仅部分事件 / 未安装。
- 配置：有/无 MCP；显式/默认 sandbox；有/无插件、skills、project trust 和未知表。
- 终端：PowerShell / CMD / Git Bash / WSL；SSH 保持不注入本地供应商。
- 生命周期：应用前已运行终端 / 应用后新终端 / 快照垃圾回收。

## Discovery List

- [x] `src/stores/terminalStore.ts`：启动、恢复、provider snapshot 准备和持久化。
- [x] `src-tauri/src/provider/scope.rs`：global/project/worktree 解析、临时 Home 生成、`CODEX_HOME` 注入。
- [x] `src-tauri/src/provider/global.rs`：真实 Home 全局 writer 与非供应商字段保留。
- [x] `src-tauri/src/commands/terminal.rs`：供应商 launch config 进入 PTY 环境。
- [x] `src-tauri/src/commands/hook_settings.rs`：用户级 Codex Hook 文件与 `[features].hooks`。
- [x] `src/components/terminal/TerminalStatsPanel.tsx`：实时统计依赖 Hook 绑定的 `cliSessionId`。
- [x] `src-tauri/src/commands/history*.rs`：历史根目录和会话详情消费者；确认是下游症状，不在此处兜底。
- [x] SSH 启动链路：明确清除本地 provider launch config，确认与本回归无关但需保持。
- [x] 相关单元/脚本测试：供应商模块 100 项、启动命令脚本 11 项、Rust 编译与 TypeScript 类型检查通过。

## Out of Scope

- 不改 Codex 自身 MCP、Hook 或沙箱语义。
- 不改实时统计 UI、Token 聚合算法或历史格式。
- 不自动修改用户现有 MCP/Hook/sandbox 配置内容。
