# Kimi Code CLI 与 Hook 集成实施计划

## Phase 0 · 前置

- [x] Git 分支/上游预检：`master` 与 `origin/master` 0/0，同步。
- [x] 保护现有未跟踪 file-preview 文件，不纳入本任务。
- [x] 创建并激活 Trellis planning task，建立 `agent/kimi-code-cli-hooks`，base=`master`。
- [x] 读取 fix triage、cross-layer、code-reuse、CLI Hook、SSH Agent contracts。
- [x] Context7 核对 Kimi 官方命令、目录、TOML schema 和事件。
- [x] GitNexus 不可用，记录 contracts + fast-context + `rg` 降级发现。

## Phase 1 · 契约与 shared core

- [x] 更新 CLI Hook / SSH Agent contracts，声明 Kimi source、事件和 history 分界。
- [x] 在 hook-schema 增加 Kimi definitions 与结构化 TOML planner/单测。
- [x] 将 SSH installation record 的 history candidate 改为 capability-dependent optional，并补 validator tests。
- [x] 运行 hook-schema focused tests（16 passed）。

## Phase 2 · 本地 Hook

- [x] 执行受影响 symbols 的降级 impact 报告后，扩展 backend status/commands/dir resolver。
- [x] 扩展 `normalize_source`、event admission、hook client diagnostic/title。
- [x] 接入 `PermissionResult`/`Interrupt` 状态闭环，并让 Kimi Subagent 绕过 transcript split-pane 特殊链路。
- [x] 增加当前 Kimi Code doctor capability/candidate validation 与本地原子替换。
- [x] 注册 Tauri commands。
- [x] 扩展 settings store/sync exclusions/migration defaults。
- [x] 在 HookSettingsPage、Sidebar health、App、terminal env、binding、Replay/third-party label 加入 Kimi。
- [x] 增加 focused Rust/Node tests。

## Phase 3 · SSH CLI/Hook

- [x] 分离 `SshToolSource` / `SshHistorySource` 并补 history capability regression。
- [x] 扩展 root persistence、dialog、project config root 和 stored report validation。
- [x] 扩展 SSH launch source/`KIMI_CODE_HOME`。
- [x] 扩展 remote Agent Kimi config adapter/runtime，并递增 Agent version/locks。
- [x] 保证 Kimi Hook 安装不生成 history candidate/metadata，history RPC 继续拒绝 Kimi。
- [x] 增加 SSH Agent、launch、DB、frontend focused tests。

## Phase 4 · 文案与交付记录

- [x] 更新 zh-CN/en-US 公共说明与 source labels。
- [x] 增加本地 root 不注入 `KIMI_CODE_HOME`、旧 Kimi unsupported、活动 TUI `/reload` 的双语说明。
- [x] 更新 `CHANGELOG.md`（用户未指定，使用 TEMP）。
- [x] 更新 `docs/功能清单.md` 对应 CLI/Hook/SSH 板块。

## Phase 5 · 验证

- [x] `npm` focused Node tests（23 passed）。
- [ ] `npx tsc --noEmit`：仅被任务外未跟踪 File Preview 文件的 3 个既有类型错误阻断。
- [x] `cargo fmt --check`。
- [ ] hook-schema / desktop Hook focused Rust tests（hard timeout）：schema 16 passed；desktop 在编译项目前被宿主缺少 `glib-2.0.pc` 阻断。
- [x] ssh-agent Hook/runtime focused Rust tests（hard timeout，103 passed）。
- [ ] `cargo check`（desktop + agent，hard timeout）：SSH Agent 已通过；desktop 同样被宿主 `glib-2.0.pc` 阻断。
- [x] `git diff --check` 与 Trellis context validation。
- [x] GitNexus detect-changes 不可用；已用 diff stat、symbol refs、contracts、完整主审与独立检查降级。
- [x] 已明确人工清单：zh-CN/en-US 下检查 Hook 页、SSH CLI 集成页与 24 小时时间格式；使用真实 current Kimi Code 验证本地/SSH install、`/reload`、事件与卸载。按仓库约束未启动 Tauri desktop。

## Phase 6 · 独立验收与发布

- [x] 交给 `check` preset agent 独立验证预期链路与测试；两个 P2 修复后复验 APPROVE。
- [x] 使用 code-review-expert checklist 审查 current diff；最终无 P0/P1/P2。
- [x] 确认 PR 文件范围不包含用户 file-preview 文件。
- [x] 按明确路径 stage、commit。
- [ ] 实际 `git push` 前请求用户回复 confirm/continue/yes。
- [ ] 推送后创建 Draft PR，正文包含 root cause、变更、影响、验证和人工检查。
