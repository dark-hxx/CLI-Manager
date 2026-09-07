# 修复 Grok 供应商模式下历史与 Hook 未加载

## Goal

修复 CLI-Manager 自有 Grok Build 供应商在任意作用域启动后无法加载真实 Home 中的 Hook、既有会话历史及其他用户配置的问题。

## Background

- Changelog Target: `[TEMP]`
- 用户已确认 Codex、Claude 正常；Grok 启动后 Hook 未加载，历史会话也无法读取。
- 真实 Grok Home `C:\Users\1\.grok` 同时包含 `config.toml`、`hooks/` 与 `sessions/`。
- 供应商启动链路却在 `C:\Users\1\.cli-manager\providers\generated\grokbuild\<snapshot>\grok` 只生成 `config.toml`，随后把子进程 `GROK_HOME` 指向该临时目录。
- 历史源解析仍以 `CliHomeResolver` 选择的真实 Home 下 `.grok\sessions` 为准，因此运行时 Home、Hook Home 与历史 Home 出现身份分裂。

## Root-Cause Statement

根因位于供应商选择到 PTY 子进程环境注入的边界：Grok 的全局、项目、Worktree 和显式供应商选择都会创建隔离快照，`apply_launch_environment_inner` 再覆盖 `GROK_HOME`，使 Grok 看不到真实 Home；修复必须落在供应商作用域解析/启动注入层，而不是在 Hook 或历史读取层增加兜底。

## Requirements

- Grok 全局、项目、Worktree 和显式供应商启动都必须使用真实 `GROK_HOME`，不得创建或注入临时 Grok Home。
- Grok 的进程级供应商选择必须在不替换 Home 的前提下继续传递所选 API Key、Base URL 和模型；不得静默退回全局供应商。
- 全局应用写入真实 `.grok/config.toml` 的供应商配置继续生效；非全局作用域不得永久改写真实配置。
- 真实 Home 中的 Hook、会话、技能及未知用户文件必须保持可见且不被复制、移动或改写。
- 项目级、Worktree 级和显式供应商覆盖取消 Home 隔离，但仍必须保持进程级供应商配置隔离，不能污染其他同时运行的 Grok 会话。
- Claude 与 Codex 的现有启动行为不得回归。

## Technical Notes

- Grok 官方优先级为 CLI 参数 > 环境变量 > `~/.grok/config.toml`；作用域供应商使用 `--model`、`GROK_MODELS_BASE_URL`、`XAI_API_KEY`，真实 Home 继续提供 Hook、MCP、会话、技能与其他用户配置。
- Grok 快照仅保存启动完整性元数据与密钥，不再充当 Home。Base URL 和模型写入受 manifest 校验的非秘密运行时字段；密钥继续单独保存在快照密钥文件并只注入子进程。
- `api_format` 等无官方进程级覆盖入口的原始模型字段不写入真实 Home；自定义 endpoint 按 Grok 官方 custom-model endpoint 行为处理。
- GitNexus 索引已刷新到当前提交，但 LadybugDB 只读恢复失败，impact 结果为 `UNKNOWN`；本任务按 `fix-triage-guide` 降级使用 provider/history 契约与 `rg` 调用点清单。

## Scenario Matrix

| 场景 | 期望 |
| --- | --- |
| Grok 全局供应商 + Hook 已安装 + 有历史 | 使用真实 Home；Hook 与历史均可见 |
| Grok 全局供应商 + Hook 未安装/无历史 | 正常启动，不创建伪 Hook 或伪历史 |
| Grok 项目/Worktree/显式覆盖 | 使用真实 Home，并以进程级参数/环境传递所选供应商 |
| 两个 Grok 会话选择不同供应商 | 各自供应商生效，共享同一真实 Home，互不永久改写配置 |
| 本地 PowerShell/CMD/Pwsh | 不注入临时 `GROK_HOME` |
| WSL/Bash | 不注入 Windows 临时 `GROK_HOME`；沿用真实环境默认 Home |

## Discovery List

- [x] `src-tauri/src/provider/scope.rs::prepare`：确认全局 Codex已有 passthrough，但 Grok 未覆盖。
- [x] `src-tauri/src/provider/scope.rs::write_snapshot_bundle`：确认 Grok 快照只物化 `config.toml`。
- [x] `src-tauri/src/provider/scope.rs::apply_launch_environment_inner`：确认快照启动会覆盖 `GROK_HOME`。
- [x] `src-tauri/src/provider/home.rs` / `history_sources.rs`：确认自动历史根由真实 Home 解析，属于受影响消费者，不应在此修补。
- [x] `src-tauri/src/commands/history.rs`：Grok 会话收集/解析已存在，确认与根因无关。
- [x] `src-tauri/src/commands/hook_settings.rs`：Hook 默认目录遵循 `GROK_HOME`，确认是同一上游身份分裂的消费者。
- [x] 前端历史源设置与展示：源 ID `grok` 已受支持，确认与根因无关。
- [x] `src/lib/projectStartupCommand.ts` / `resumeCliArgs.ts`：Grok 模型必须走安全的直接命令参数替换。
- [x] `src/stores/terminalStore.ts` / `TerminalProcessManager.ts`：快照 DTO、旧快照失效和 PTY 启动配置必须同步。
- [x] `src-tauri/src/provider/global.rs` / `grok.rs`：旧项目临时配置物化机制已移除，防止两套 scope 机制并存。

## Acceptance Criteria

- [x] 任意来源的 Grok 供应商启动均不覆盖 `GROK_HOME`，已安装 Hook 能被 Grok 加载。
- [x] 项目、Worktree 和显式 Grok 供应商的 API Key、Base URL、模型在当前进程生效，且不改写真实配置。
- [x] Grok 新旧会话继续写入/读取真实 `.grok/sessions`，历史列表和详情可加载。
- [x] 两个不同供应商的 Grok 会话可并行运行，配置互不串线。
- [x] Codex 全局 passthrough、Codex scoped override 与 Claude snapshot 测试保持通过。
- [x] Rust 定向测试、provider 模块测试与 `cargo check` 通过。

## Verification Evidence

- `cargo test provider:: --lib`: 99/99 passed.
- `cargo test commands::terminal::tests --lib`: 2/2 passed.
- `cargo check`, `cargo fmt --all -- --check`, `npx tsc --noEmit`, `git diff --check`: passed.
- `node scripts/resumeCliArgs.test.mjs`: 12/12 passed, including Grok model replacement and injection rejection.
- Real installed `grok --model scoped-model inspect --json` with process endpoint/key overrides still discovered 35 Hooks, 10 MCP servers and 36 Skills from the real Home.
- GitNexus index was refreshed to the current commit, but impact/detect-changes remained unavailable because LadybugDB could not replay shadow pages in read-only mode; contract + `rg` touchpoint discovery and full diff review were used as the documented fallback.
