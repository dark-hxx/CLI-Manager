# V1.4.2 历史删除验收记录

实现与自动化验证完成；用户于 2026-10-08 确认“功能验证成功 可以提交”，并要求先处理 `inspect` 未使用告警。告警已清理，用户随后追加授权提交并推送远程。

## 根因与已关闭触点

根因位于来源能力与删除分发边界：七个来源已有读取器，但删除命令未接入，前后端两份能力表和操作入口也未同步。修复覆盖原始转录删除、校验、备份和成功后的状态清理。

| 发现 | 最终处理 |
|---|---|
| F1 删除白名单缺失 | 接入 Pi、Gemini、Copilot、Antigravity、Kiro、Cursor、Cline 的单转录删除 |
| F2 前端入口/能力脱节 | 十二来源显式声明 delete；列表、单条/批量确认和 Store 共用资格判断 |
| F3 Cline 多根缺失 | 分别规范化已有合法根，并核对来源、项目和候选路径；拒绝共同父目录和链接逃逸 |
| F4 泛化子代理误删风险 | 新七来源只传一个明确文件；目录、旁文件、共享索引/数据库和相邻 subagents 保留 |
| F5 同名备份清单碰撞 | UUID 后缀配合排他创建变更目录，独立清单和旧备份读取兼容 |
| F6 批量预检/计数 | 整批先检查资格，再逐条执行；真实 I/O 失败停止并保留准确成功数 |
| F7 前端清理范围过宽 | 仅清实际删除行；Claude/Codex 只同步清理实际相邻子转录，其他来源不按父 ID 推断级联 |
| F8 后端能力副本过期 | 同步 `history_sources_list_descriptors` 的十二来源 delete；读取模板和其他写入能力不变 |

完整来源布局、未受影响触点和场景矩阵见 [source-audit.md](research/source-audit.md)。

提交前补充：Worktree 主检出恢复模块的旧 `inspect` 入口没有生产或测试调用，实际恢复命令使用 `probe/recheck`。GitNexus 未识别该符号（UNKNOWN），已按恢复契约和全后端引用确认；直接删除遗留函数和注释，没有增加告警抑制或改变恢复流程。

## 自动化结果

| 检查 | 最终结果 |
|---|---|
| `cargo test --manifest-path src-tauri/Cargo.toml --lib history -- --nocapture` | **262 passed，0 failed，0 ignored**；含 Windows junction 越界、文件占用回滚、七来源双会话重扫、备份隔离/兼容，以及旧五来源删除 |
| 全部 `scripts/history*.test.mjs` 加 `cliArgsHistory`、`kimiHistoryFrontend`、`grokHistoryFrontend` | **82 passed，0 failed，0 skipped** |
| `npx tsc --noEmit` | 通过 |
| `cargo check --manifest-path src-tauri/Cargo.toml` | 历史删除实现阶段通过；当时的 inspect 告警已在提交前清理 |
| `cargo check --manifest-path src-tauri/Cargo.toml --no-default-features` | **通过，无编译告警**；与开发启动的功能配置一致 |
| `cargo test --manifest-path src-tauri/Cargo.toml --no-default-features --lib recovery_tests -- --nocapture` | **8 passed，0 failed，0 ignored**；覆盖重启恢复、过期确认、损坏日志、外部 index 变化、冲突与 stash 恢复及清理边界 |
| `npm run check:architecture -- --strict` | 通过；1288 个源文件，0 个超过 2000 行，0 新违规，无新豁免 |
| `npm run report:architecture` | 已运行；Store 1837 行，Workspace 1605 行，ListPane 1378 行，删除策略 109 行；新 Rust 删除器 92 行，测试 385 行 |
| `git diff --check` | 通过 |
| `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` | **全仓未通过**：74 个文件存在既有格式差异；本次修改行无未格式化差异 |

格式问题已与 HEAD 和本次变更行对照：`backup.rs`、`scope.rs`、`conversion.rs`、`sources.rs`、`deletion.rs`、`tests/deletion.rs` 分别通过 rustfmt；`history/mod.rs` 剩余 22 处、`history/tests.rs` 剩余 4 处均未覆盖本次修改行。其他格式差异位于未修改文件，如 `src-tauri/src/commands/mod.rs`；没有扩大格式化范围。

前端复现命令（PowerShell）：

```powershell
$historyRegressionFiles = @(rg --files scripts -g 'history*.test.mjs')
node --test $historyRegressionFiles scripts/cliArgsHistory.test.mjs scripts/kimiHistoryFrontend.test.mjs scripts/grokHistoryFrontend.test.mjs
```

关键新增测试：

- `src-tauri/src/features/history/tests/deletion.rs`：真实读取器 fixture 的枚举→校验→删除→重扫；七来源各保留另一条会话与旁文件，数据库/目录替代拒绝，Cline 多根和 Windows 目录联接边界，备份失败、删除失败补偿。
- `src-tauri/src/features/history/backup.rs`：相同固定时间/操作/文件名前缀生成独立清单，可分别发现和恢复；旧平铺备份与新目录共存；七来源恢复锁。
- `src-tauri/src/features/history/sources.rs`：公开能力表的十二来源删除状态和保守模板边界。
- `scripts/historyDeletion.test.mjs`：资格策略、来源能力、快照/只读、批量预检与中途失败、跨根/WSL 文件范围；从真实 Store 提取 action，在 IPC/数据库边界验证清理顺序和失败时状态保留。

## 验证边界

- Windows 原生符号链接创建需要本机未具备的特权，最终测试改用无需该特权的目录联接并已实际执行通过；Unix 符号链接分支未在本机执行。
- 原有恢复 UI 要求原文件仍存在。本次验证了删除快照字节完整、回滚复制和现有覆盖恢复流程，没有增加缺失文件的一键恢复 API。
- 删除执行器的回滚失败→人工恢复锁分支按原实现迁移并核对等价；未另做恢复失败故障注入。已实际验证删除失败后恢复此前文件及恢复锁阻止后续变更。
- 七来源范围仍是现有本地读取根，没有新增 SSH 写入、自定义扫描根或 WSL 发现位置；没有运行第三方 CLI 删除用户真实会话。
- GitNexus impact 返回 UNKNOWN，FTS 降级；已使用领域契约、精确符号/调用点以及最终删除相关全仓符号搜索核对范围，没有将工具空结果当作低风险结论。
- 暂存范围的 GitNexus detect_changes 返回 CRITICAL（6 个符号、298 个受影响项）；对 HistoryListPaneProps 上溯又列出 107 个直接依赖、153 个总依赖及 16 个模块。已向用户提示并核查：SessionGroup 本体未变；未导出的 HistoryListPaneProps 仅新增 deletionPlan 属性，实际只由 HistoryWorkspace 传给列表组件。图谱却列出 FakeWebSocket、AppErrorBoundary 等无对应源码引用的关系；remote_requests/kimi_source 也只是邻近模块声明被归因。以 26 个实际暂存路径、声明差异、真实引用和已通过的类型/历史回归核对变更范围，未发现终端或远程请求实现改动；不将该图谱结果视作准确调用链。

## 人工桌面验收（用户确认通过）

用户明确反馈“功能验证成功 可以提交”，据此记录功能验收通过。用户未提供逐项操作记录，不能据此声称每种语言切换和下面每个交互场景均已单独实测。

依据 `.trellis/spec/frontend/quality-guidelines.md` 的规则，AI 未启动产品服务/Tauri 作 UI 验证：

> AI agents must not start CLI-Manager services or the Tauri desktop app to verify runtime UI behavior.

原交付验收建议留档如下：

1. 为七种新增来源各选择一条测试会话删除，刷新并重新打开历史；确认目标消失、另一会话及旁文件保留。
2. 混合来源批量选择，确认操作数与成功/失败数；检查不可删除项的禁用提示及子代理选择。
3. 删除本地收藏快照，确认不操作原文件；检查 SSH/只读条目以及切换项目/Worktree 后的目标。
4. 在“设置 → 通用 → 界面语言”切换 zh-CN/en-US，检查确认文案、禁用提示和错误消息；时间仍为 24 小时制。

## 交付状态

- 工作提交：`14e9de2e`（未使用恢复入口清理）、`70ea97ea`（历史来源删除支持）；归档与会话日志作为后续记录提交。
- `CHANGELOG.md` 的 V1.4.2 条目、`docs/功能清单.md` 的历史/来源/安全及 Worktree 条目、前后端历史契约已同步。
- 告警处理开始时 `master` 相对已配置的 `origin/master` 为 0/0；用户已授权本次提交和推送 `origin/master`，未授权版本发布。
- 本次提交仅包含任务相关改动；规则文件、二维码、README/许可说明等其他并行改动独立保留。提交后按 Trellis 流程归档当前任务并记录会话。
