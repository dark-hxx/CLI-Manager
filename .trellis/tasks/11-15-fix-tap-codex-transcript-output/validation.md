# V1.5.1 验证记录

## 结果

Codex 读取修复及追加的 Skill 补全需求已实现并完成自动验证，任务处于 review。已复现两类可以导致对话读取停止的故障机制，未取得用户当次浏览器现场，实机偶发触发条件及 Skill UI 仍待人工验收。

## 远程提交授权（2026-11-15）

- 用户明确要求“推送远程提交”，授权将本任务源码、测试、契约、变更记录与任务记录提交并推送至 `origin/master`；前述 session 中的“未提交”保留为当时事实。
- 提交前核对 `master` 与 `origin/master` 领先/落后均为 0，远程分支实值同为 `e6ae678e`。当前 GitNexus 索引匹配该 HEAD，重新执行 `detect-changes --scope all --repo . --limit 1000` 得到 27 文件、113 个索引符号、21 个执行流程；暂存新增文件后再次检查得到 34 文件、182 个索引符号、21 个执行流程，整体 risk critical，无 partial/truncated 提示。CLI 仅缩略显示前 15 个符号与前 10 个流程；图谱分析不替代上述测试及人工验收。
- `src-tauri/helpers/Cargo.lock` 中额外的传递依赖解析变动未伴随本任务的依赖声明修改，保留为本地未暂存改动，不纳入本次提交。严格架构既有问题和人工验收边界继续保留，远程提交不代表应用发布。

## 修复前复现

| 检查 | 基线结果 |
| --- | --- |
| Codex 同 UUID rollout 在来源目录内移动、目录缓存仍指向旧路径 | Rust 新增回归失败，返回 `session_file_not_found` |
| 精确 Codex 冷读取与全局目录缓存隔离 | Rust 新增回归失败，实时读取创建了全局目录缓存 |
| transcript 创建 HTTP 永不返回 | Node 新增回归失败，60 秒后仍未到期 |
| transcript 轮询 HTTP 永不返回 | Node 新增回归失败，60 秒后仍未到期 |

## 修复后验证

| 命令 | 结果 |
| --- | --- |
| `node --test apps/web-tap/src/operations.test.mjs apps/web-tap/src/transcript.test.mjs` | 9 项通过；包含请求卡住后 Conversation 恢复最终回复的集成回归 |
| `npm run tap:test` | 最终 128 项通过，包括 Skill 补全、旧宿主、隐藏页面、单请求尾随刷新、账号/设备隔离及中英文 UI |
| `node --test apps/web-tap/src/completion.test.mjs apps/web-tap/src/composerCompletion.test.mjs apps/web-tap/src/completionSession.test.mjs` | 31 项通过；桌面/手机斜杠只留草稿、Skill 插入语法/参数、输入法/长按 Enter、无能力/未绑定/失败/空列表及旧结果隔离 |
| `node --test scripts/webTerminalSkills.test.mjs` | Codex 反馈后最终 7 项通过；生产 dispatcher/Skill 读取模块验证主机上下文、只读投影、Worktree/WSL、错误身份、异步切换、700 KiB 结果预算及会话启动配置根优先级 |
| `cargo test --manifest-path src-tauri/agent-capabilities-core/Cargo.toml` | 19 项通过；自定义 Codex Home/Worktree 符号链接、循环去重、Windows Junction、超大链接清单与其他 Agent 排除规则 |
| `cargo test --manifest-path src-tauri/Cargo.toml agent_capabilities --lib` | 4 项通过；配置根显式/继承优先级、固定有界 WSL find 参数及原请求校验 |
| `cargo check --manifest-path src-tauri/ssh-agent/Cargo.toml` | 通过；共享发现布局新增内部扫描标识未破坏 SSH 消费者编译 |
| `node --test src/features/terminal/lib/webManagement.menu.test.mjs` | 3 项通过；既有菜单动作及确认边界保持 |
| `cargo test --manifest-path apps/server/Cargo.toml --lib` | 60 项通过；包括新 Skill 操作注册 ID/能力映射验证及既有所有权/确认规则 |
| `npm run tap:typecheck` | 通过 |
| `npm run tap:build` | 类型检查与 Tap 生产资源构建通过 |
| `npx tsc --noEmit` | 桌面前端类型检查通过 |
| `cargo test --lib live_transcript -- --nocapture` | 最终 11 项通过；覆盖 stale catalog、消失缓存、并发替换、元数据身份/cwd、目录歧义、最终磁盘写入通知、增量缓存和分页 |
| `cargo test --lib codex_lookup` | 4 项通过；复用的精确 UUID 查找保持原有行为 |
| `cargo check` | 最终版本通过 |
| `git diff --check` | 通过 |
| `npm run check:architecture -- --strict` | 未通过，见下方既有问题 |

测试使用临时日志、虚拟时钟和明确替代 I/O 的生产模块 fixture，没有新建真实 CLI/PTY、修改生产配置或复制用户对话正文。Skill 提示已同步中英文并通过静态渲染测试；桌面手动语言切换未执行。

## 严格架构检查的既有问题

1. `src/features/stats/api/StatsPanel.tsx` 为 2020 个物理行，超过 2000 行限制。
2. `src/features/settings/components/pages/TerminalStatusBarSettingsPage.tsx` 从 `../../../terminal/lib/terminalStatusBarItems` 跨功能导入内部实现。

已用 `git show HEAD:<path>` 核对两项在起始 HEAD 存在，本次没有修改这些文件或添加豁免。严格架构验收尚未通过，不宣称可发布。

## 影响及记录

- 使用与当前起始 HEAD 匹配的 GitNexus CLI 精确 impact；主要符号为 LOW，`read` 为 lower-bound，新符号未索引的 UNKNOWN 已用契约、源码引用和回归验证补充。
- Codex 读取修复批次的图谱风险为 medium；加入 Skill 补全及共享能力声明后，`detect-changes --scope all` 报告 26 个受影响流程、risk critical，包含 helper `Handle_request → Default_capabilities`、server create_operation 与 Tap 输入/操作流程。修改前已告知 helper 共享入口的 CRITICAL 风险，能力声明只新增一个读能力标识，Rust 检查、服务器 60 项及 Tap/主机 fixture 回归通过。MCP 存储版本不兼容、CLI FTS 缺失和新函数尚未进入起始索引的限制仍存在；不把完整图谱覆盖作为交付结论。
- 已更新 CHANGELOG V1.5.1、功能清单、Web 服务契约及本任务的根因/触点清单。
- 契约已读回核对，session 138 已写入 `.trellis/workspace/hxx/journal-3.md` 并核对指向 Web 服务契约的 topic 链接；未自动提交。
- Skill 补全边界已更新同一 Web 契约并读回核对，session 139 追加到同一 journal，topic 链接与 index 均已核对；未自动提交。

## 人工验收边界

- 用包含新 Rust 主机和 Tap 资源的构建验收一个新 Codex 终端：首次提交、运行中输出、结束后最终回复，以及连续第二轮。
- 验证浏览器隐藏后恢复、终端/对话切换、同目录多个终端和 Worktree；确认内容只来自选中的会话。
- WSL 继续复用原有 guest find 和 UNC 边界，但本轮未启动 WSL 或真实桌面应用验证。
- 如果仍出现空白，需取得当次 `terminal.transcript` 的完成状态、`available/reason` 与所选设备能力，以确认是否属于未绑定、旧宿主或其他现场条件；当前资料不足以唯一确定用户原始事件的触发原因。
- 在中英文、电脑和手机分别输入 `/`：确认仅显示 Skill 候选、无原生菜单切换；用方向键/Enter/Tab/点击填入，检查 Claude `/name` / Codex `$name`，加参数及 `@` 引用后发送，确认原 CLI 调用及回复。
- 验证中文选字 Enter、长按 Enter、旧主机/旧 Web 服务、未绑定 Hook、断线、快速会话/Worktree 切换；手动进入「终端」和「直接键入」继续操作原生菜单。按仓库规则未启动桌面服务，静态/fixture 通过不替代此实机验收。
- Codex 漏识别补修包含 Rust 主机改动，使用更新后的主机再刷新 Tap；分别验证继承/项目/会话显式 CODEX_HOME 与符号链接目录。WSL 只校验了构造的固定参数和 guest 路由 fixture，本轮未启动 WSL。

## Codex 漏识别的复现及实际目录核对

- 修复前：生产请求构建把会话根 `D:/session-home` 覆盖为当前项目根；两个共享 Rust 回归中，自定义 Home 与 Worktree 符号链接都读出 0 项而非预期 1 项。
- 修复后：使用临时目录的 Windows 符号链接/Junction 测试通过；核心深度/数量/文件大小限制保持，规范目录身份阻止循环扩散。
- 独立只读 Rust 探针直接调用真实共享发现库核对本机现有目录，输出 `installed_link_directories=6 discovered_link_manifests=6 available_skills=27`。仅输出计数，未复制清单正文或用户对话，未启动桌面/CLI 服务；临时源码、可执行文件及符号文件均已清理。
- 本轮起始分支为 master，领先 origin/master 1 个提交，无落后；未同步或提交。GitNexus 索引匹配 d84b5820，编辑前 shared scanner/layout 与请求构建 HIGH 已告知，详见 design.md。
- 最终 `cargo check --manifest-path src-tauri/Cargo.toml` 通过；包含会话环境根在 I/O 中途改变的主机 7 项回归再次通过，`git diff --check` 通过。
- 本轮最终 CLI graph analysis（scope all / limit 1000）报告当前工作区 27 文件、113 个索引符号和 21 个受影响流程，整体 risk critical；包含此前共享 helper 能力入口及其他已存在改动，不作为新增代码完整覆盖或低风险结论。新辅助函数及 WSL 实机行为的验证边界保持显式。
- Agent 诊断契约及 Web 契约已读回核对；session 142 记录至 `.trellis/workspace/hxx/journal-3.md`，topic 指向 Agent 诊断契约，index 链接已核对；未自动提交。
