# 当前实现触点与分诊结论

## 分诊

- 类型：新增 Kimi Code CLI/Hook 能力，同时修复“远程 CLI 集成只渲染 Claude/Codex”的能力缺口。
- 路径：按 `.trellis/spec/guides/fix-triage-guide.md` §5 + §4 走完整场景枚举和发现清单，不走静态 UI 最小修复。
- Git：开始时 `master` 与 `origin/master` 同步（0/0）；已有 file-preview 未跟踪文件与本任务无关，必须保留且不进入 PR。
- GitNexus：MCP tools 未配置；仓库内 `.claude/skills/gitnexus/*` 不存在；`npx gitnexus status` 在 30 秒内只能临时安装包且未返回索引状态。按契约降级为 CLI Hook/SSH Agent contracts + fast-context + `rg` 全量引用分析。

## 根因陈述

Kimi 已存在于 CLI descriptor 和图标层，但远程 `SshToolSource` 同时承担“Hook 可支持 source”和“远程历史可支持 source”两个职责，且本地 Hook 状态、安装器、bridge admission、Settings UI 与 SSH Agent 每层都硬编码既有 source；因此只改渲染数组会在 IPC、配置写入或事件接收边界失败，修复必须落在 source capability 契约并贯穿完整链路。

## 数据流

### 本地 / WSL

`HookSettingsPage` → Tauri `hook_settings_*_kimi` → 结构化更新 `~/.kimi-code/config.toml` → Kimi 执行 `<cli-manager> __hook --source kimi --event ...` → `hook_client` 归一化 stdin → `/api/claude-hook` admission → Tauri event → `terminalHookBinding` / `terminalStore` → Tab、Toast、系统通知、Replay、第三方通知。

### SSH

`SshCliIntegrationDialog` → host/tool root persistence → `ssh_agent_hook_*` one-shot command → remote Agent 结构化更新 `~/.kimi-code/config.toml` → session launch 注入 `KIMI_CODE_HOME` + source-bound bridge env → Agent Hook spool → desktop daemon source/binding validation → shared frontend notification flow。

## 发现清单

### 需要修改

- [ ] `src/lib/types.ts`：扩展 `SshToolSource`，新增只含 Claude/Codex 的 `SshHistorySource`。
- [ ] `src/lib/sshToolIntegration.ts`：Kimi 默认根、命令识别、stored report admission；提供独立 history resolver，避免误开 Kimi 历史。
- [ ] `src/lib/projectCapabilities.ts`、`src/lib/sshAgentHistory.ts`：仅通过 `SshHistorySource` 启用远程历史。
- [ ] `src/components/settings/pages/SshCliIntegrationDialog.tsx`：渲染 Kimi、维护 root/report/preview/apply 全状态。
- [ ] `src/components/ConfigModal.tsx`：项目级 Kimi config root 默认提示与 source resolver。
- [ ] `src/stores/sshAgentIntegrationStore.ts`、`src-tauri/src/commands/ssh.rs`、`src-tauri/src/commands/ssh_db.rs`、`src-tauri/src/commands/ssh_integration.rs`：持久化 `kimiRoot`，让远端 Hook request/report validator 接受 Kimi；history report 仍拒绝 Kimi。
- [ ] `src/stores/terminalStore.ts`、`src-tauri/src/ssh_launch.rs`：SSH launch 接受 `kimi`，注入并安全格式化 `KIMI_CODE_HOME`。
- [ ] `src-tauri/hook-schema`：共享 Kimi Hook specs、精确 owner command parser、结构化 TOML planner和 optional history candidate，供本地和 SSH Agent 复用。
- [ ] `src-tauri/ssh-agent/src/hook_config.rs`：新增 Kimi config adapter，保留事务、fingerprint、owner/conflict 语义。
- [ ] `src-tauri/ssh-agent/src/hook_runtime.rs`：承认 Kimi 事件并 spool。
- [ ] `src-tauri/ssh-agent/Cargo.toml` / lockfiles / SSH Agent contract：Agent 功能版本递增，protocol 保持兼容。
- [ ] `src-tauri/src/commands/hook_settings.rs`：本地 Kimi 目录解析、状态、全量/模块安装卸载。
- [ ] `src-tauri/src/lib.rs`：注册 Kimi Tauri commands。
- [ ] `src/stores/settingsStore.ts`、`src/lib/syncSettings.ts`：Kimi bridge enable、config dir、折叠状态及迁移默认值。
- [ ] `src/components/settings/pages/HookSettingsPage.tsx`：Kimi 状态、模块卡、目录、安装/删除、双语说明。
- [ ] `src/components/sidebar/SidebarFooter.tsx`、`src/components/TerminalTabs.tsx`、`src/App.tsx`、`src/stores/terminalStore.ts`：健康灯、启动检测、统计面板 Hook 健康门禁、`PermissionResult`/`Interrupt` 状态及 Kimi Subagent no-split 纳入 Kimi；本地不注入 `KIMI_CODE_HOME`。
- [ ] `src/stores/terminalHookBinding.ts`：识别 `kimi` source 并保持 exact/session/path/ambiguity 绑定顺序。
- [ ] `src-tauri/src/claude_hook.rs`、`src-tauri/src/hook_client.rs`：Kimi source/event admission、诊断与标题。
- [ ] `src/stores/replayStore.ts`、`src-tauri/src/third_party_notification/dispatcher.rs`：Kimi 显示名称。
- [ ] `src/lib/i18n.ts`：所有受影响说明和 Kimi Replay 文案同步 zh-CN/en-US。
- [ ] `.trellis/spec/backend/cli-hook-contracts.md`、`.trellis/spec/backend/ssh-agent-contracts.md`：更新 source、事件、配置和 history 分界。
- [ ] `CHANGELOG.md`、`docs/功能清单.md`：按版本板块记录。

### 需要新增或扩展测试

- [ ] TypeScript/Node：Kimi command/path resolver、Kimi 不启用 SSH history、Kimi Hook target binding。
- [ ] 本地 Rust：Kimi TOML 安装幂等、模块卸载、用户 Hook/注释保留、无效 TOML/错误 root 显式失败、source admission。
- [ ] Kimi doctor：当前产品 capability、旧 `kimi-cli` unsupported、candidate validation failure 原文件不变。
- [ ] SSH Agent Rust：Kimi source/default root/config report/runtime event、transaction preview/apply/uninstall、用户条目保留、history candidate 缺失。
- [ ] SSH launch Rust：Kimi source 与 `KIMI_CODE_HOME` 的 home path quoting/validation。
- [ ] 静态检查：`npx tsc --noEmit`、focused Node tests、focused Rust tests、`cargo check`、`git diff --check`。

### 已确认不在范围

- [x] Kimi history parser/index/resume：本任务不新增，必须继续显示 SSH history unsupported。
- [x] Provider switching、cc-connect handoff、statusline：Kimi 尚无对应 provider/handoff 产品契约，不因 Hook source 扩展而加入。
- [x] OpenCode marker plugin、Pi Extension、Grok cross-vendor isolation：实现机制独立，回归测试确认不受影响即可。
- [x] 数据库 schema migration：source 列为开放 TEXT，新增值无需迁移；仅 command payload/persistence loop 扩展。
- [x] daemon remote source binding：字符串 exact-match，除 admission 与 launch validator 外无需 Kimi 专属分支。

## 影响风险

- 风险等级：HIGH（跨前端状态、Tauri IPC、本地文件配置、SSH Agent 文件事务、远程 runtime 与事件 admission）。
- 主要回归风险：误启用 Kimi 远程历史；破坏用户 `config.toml`；旧 SSH Agent 不支持新 source；本地安装成功但 receiver 丢弃；disabled bridge 仍影响健康灯；custom root 未注入 `KIMI_CODE_HOME`。
- 编辑前策略：共享 TOML planner；每个 admission/validator/source union 有 focused test；不加入 fallback、mock 或吞错路径。
