# 历史删除来源核查

核查日期：2026-10-08；基线：`c2c4ca75`；版本：V1.4.2。

## 根因陈述

缺口位于历史来源能力与删除命令的接线边界：七个原生读取来源已进入统一列表，但后端删除分发未接入这些来源，前端也未按删除能力约束入口。修复应落在来源删除分发、目标校验和共同入口，而不是吞掉错误或仅隐藏记录。

## 发现清单

| ID | 判断 | 证据 | 处理 |
| --- | --- | --- | --- |
| F1 | 当前缺陷：七个来源被删除白名单拒绝 | `src-tauri/src/features/history/mod.rs:549`、`:565` | 接入七个来源的精确文件删除 |
| F2 | 当前缺陷：前端删除入口和能力声明脱节 | `src/features/history/components/HistoryListPane.tsx:1262`、`store/historyStore.ts:1078`、`src/shared/lib/historySources.ts:86`、`:105`、`:274`、`:294` | 对齐十二个来源声明与 Store/按钮/批量资格检查 |
| F3 | 必须补齐：Cline 多根读取没有对应删除校验 | `roots.rs:321`、`source_files.rs:482`、`scope.rs:67` | 删除专用的合法根集合校验，复用现有候选与项目校验 |
| F4 | 直接扩展旧删除器会带来误删风险 | `conversion.rs:137` 调用 `session_detail.rs:572`，后者扫描父目录下 `subagents` | 新七个来源只删除选中转录；旧来源的树删除保留原来的显式目标集 |
| F5 | 同名文件备份的清单存在碰撞条件 | `backup.rs:496` 目录仅由毫秒/操作/文件 stem 组成；`:203` 快照文件名虽包含路径摘要，但 `:661` 每个目录只写一份单文件 manifest | 每次快照独占变更目录；验证同名会话的备份都能被独立找回 |
| F6 | 批量队列没有来源预检，遇首个失败即停止 | `HistoryWorkspace.tsx:1107`、`:1175` | 共用资格判断；保留真实 I/O 失败时现有部分成功语义 |
| F7 | 前端按父子关联清理，须与实际删除目标一致 | `historyStore.ts:1094`、`historySubagents.ts:6` | 新文件级删除仅清目标记录，原有来源的级联语义回归测试 |
| F8 | 最终跨层对照发现后端另有一份过期能力表 | `features/history/sources.rs` 的 `SOURCES` / `SUPPORTED_CLAUDE_CODEX`，经 `history_sources_list_descriptors` 暴露 IPC | 与前端同步十二来源的 delete，保留其他能力与通用模板，新增公开描述回归 |

## 来源与删除对象

本次删除对象是 CLI-Manager 当前读取的原始会话转录文件。第三方工具的其他数据结构只读，不据此推断整个父目录归当前会话所有。

| 来源 | 当前扫描对象 | 新删除范围 | 保留边界 |
| --- | --- | --- | --- |
| Pi | `~/.pi/agent/sessions/**/*.jsonl`，`source_files.rs:441`、`roots.rs:314` | 被选中的 JSONL | 同项目其他 JSONL、配置和相邻目录 |
| Gemini CLI | `~/.gemini/tmp/**/session-*.json`，`source_files.rs:109` | 被选中的会话 JSON | 项目缓存目录、其他会话 |
| Copilot CLI | `~/.copilot/session-state/**/events.jsonl`，`source_files.rs:133` | 被选中的 events JSONL | 其他事件日志、整个 session-state 根和未确认的伴随文件 |
| Antigravity | `brain/<id>/.system_generated/logs/transcript.jsonl`，`source_metadata.rs:56` | 被选中的 transcript | `history.jsonl` 工作区映射、brain 下其他文件和产物 |
| Kiro | `workspace-sessions/**/*.json`，排除 `sessions.json`，`source_files.rs:459` | 被选中的 session JSON | 共享 `sessions.json`、设置及其他会话 |
| Cursor | `.cursor/projects/<project>/agent-transcripts/<dir>/<id>.jsonl`，`source_metadata.rs:338` | 被选中的 transcript | `state.vscdb`、conversation-search DB、其他 transcript |
| Cline | 五类已支持根中的 `tasks/`、`data/tasks/` 或扫描回退下的 `api_conversation_history.json`，`roots.rs:321`、`source_files.rs:482` | 被选中的 API 历史 JSON | `task_metadata.json` / `metadata.json`、`ui_messages.json`、共享存储和其他任务 |

读取器以转录文件是否存在为枚举依据：Antigravity 的共享文件只补工作区，Kiro 共享 registry 明确不作为会话，Cursor SQLite 仅补标题/时间/工作区，Cline 伴随文件仅补元数据。因此删除目标原文并失效派生索引可以使目标从 CLI-Manager 消失；本任务不承诺清理第三方客户端全部缓存/列表。

## 已确认无需改动的触点

- `pi_parser.rs`、其他原生 parser、`source_files.rs` 的文件识别/枚举规则：当前已有目标文件证据，读取格式不变。
- `roots.rs` 的现有根选择：沿用当前已读取的位置，不扩展自定义实例或新增 WSL 扫描位置。
- `session_detail.rs` 的子代理发现：读取用途保留；仅删除调用者改用明确目标集。
- `edit.rs`：消息编辑/插入权限和格式语义不因删除开放而改变。
- `opencode.rs`：保留选中会话的 SQLite 事务删除；不把 locator 当成文件。
- `kimi.rs`、Grok 删除器：保留 tombstone/目录删除/备份补偿语义。
- `messageStars.ts`、`messageStarStore.ts`、历史编辑审计：保留现有星标/审计留存策略，不把本次来源支持扩展为数据保留策略变更。
- SSH bridge、daemon、PTY、Hook：不承担本地删除来源分发；继续遵循远端只读协议。

## 影响分析与工具状态

- 无 `.codegraph/`，按项目要求跳过 CodeGraph。
- 已执行 `npx gitnexus analyze --index-only` 刷新当前工作区索引；FTS 扩展不可用。
- GitNexus query/context 和 impact 对删除入口、列表组件、路径校验、删除事务及备份函数均返回目标未找到，impact 风险为 `UNKNOWN`，不是低风险或零影响。
- 按项目允许的降级路径，使用历史契约、精确符号搜索和当前源码核查。
- 备份快照上游覆盖 `create_file_backup_snapshot`、`ensure_file_backup`、消息编辑、Claude/Codex 文件树删除以及 Kimi/Grok 删除。因此快照目录唯一性调整要跑现有备份与删除回归。
- 路径校验同时被转换/编辑消费，Cline 扩展采用删除专用入口，避免无意扩展消息写入能力。
- 补充的后端能力表触点是既有需求 R3/AC4 的同层副本，不增加新来源或新 IPC。`SOURCES`、`SUPPORTED_CLAUDE_CODEX`、`history_sources_list_descriptors` 的 impact 仍为 UNKNOWN；源码确认直接消费者为描述转换/公开 IPC，检测和校验继续沿用相同位置规格。
- 实现前已对 history_delete_session、HistoryListPane、HistoryWorkspace、deleteSession、validate_session_file_ref、delete_session_tree_with_backup_root、create_file_backup_snapshot_with_limit、ensure_source_mutation_unlocked 执行 impact；补查 confirmDeleteSession、handleRequestBulkDelete 和 HISTORY_SOURCE_DESCRIPTORS 也均为 UNKNOWN。使用上述契约和实际调用链完成降级核查。

## 场景维度

| 维度 | 本轮处理/验证 |
| --- | --- |
| 来源 | 新七个逐一双会话 fixture；已有五个保留各自语义 |
| 单条/批量 | 同源、混合来源、不可删除项、第一项失败、中间项失败，结果计数真实 |
| 主会话/子代理/收藏快照 | 子代理直接删除保留限制；文件级删除不带走旁边子目录；快照沿用本地清理流程 |
| 路径与项目 | 主项目/Worktree cwd、相同文件名、不同根、越界、符号链接或 Windows junction、文件缺失 |
| 环境 | 七个来源当前本地根；现有 WSL 支持回归；SSH 继续只读，不新增扫描位置 |
| 文件/恢复状态 | 可读、被占用/只读、备份失败、人工恢复锁、同名备份、回滚失败 |
| 窗口焦点/分屏/托盘/Workspan | 删除身份来自捕获的 sessionKey/source/filePath；不能由当前焦点或终端推导 |
| UI 展示模式 | 所有已存在删除入口共用资格，不按侧栏展开模式分叉 |
| Hook | 删除基于磁盘与索引，安装/未安装 Hook 均不改变删除权限 |
| 国际化 | zh-CN/en-US 提示、禁用态与确认文案，维持现有 24 小时时间格式 |

## 验证限制

自动化仅使用临时历史 fixture。依据 `.trellis/spec/frontend/quality-guidelines.md:246`，AI 不启动 CLI-Manager/Tauri 作原生 UI 验证；交付需列出人工检查项和未验证状态。
