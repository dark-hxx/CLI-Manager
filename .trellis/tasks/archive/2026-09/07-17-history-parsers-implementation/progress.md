# 实现进度

## Parser 分片

| 分片 | 状态 | 完成口径 |
| --- | --- | --- |
| adapter-core-and-v2-read-path | done | v2 shadow 写入复用 adapter 输出；legacy catalog 保留为兼容读链路和 discovery 候选 |
| claude-parser-parity | done | Claude adapter parity 覆盖 session/message/raw pointers/tokens/tool/file change 写入 |
| codex-parser-parity | done | Codex adapter parity 覆盖 mixed raw pointers、state DB locator、token diff 与 message usage 回填 |
| gemini-parser | done | JSON parser、fixture、list/detail/search/stats 只读链路 |
| kiro-parser | done | workspace-sessions JSON parser，可显示 business-center 历史 |
| opencode-parser | done | SQLite session/message/part 只读 parser，虚拟 locator 接入旧 catalog |
| copilot-parser | done | `~/.copilot/session-state/*/events.jsonl` parser，fixture 覆盖 discover/detail/search/stats |
| antigravity-parser | done | transcript/history JSONL parser，fixture 覆盖 discover/detail/search/stats |
| grok-parser | done | `~/.grok/sessions/*/*/updates.jsonl` parser，fixture 覆盖 discover/detail/search/stats |
| pi-parser | done | `~/.pi/agent/sessions/**/*.jsonl` parser，fixture 覆盖 discover/detail/search/stats |
| cline-parser | done | Cline `tasks/*/api_conversation_history.json` parser，fixture 覆盖 discover/detail/search/stats |
| cursor-parser | done | `~/.cursor/projects/*/agent-transcripts/*/*.jsonl` parser，轻量读取 Cursor globalStorage SQLite 元数据补 title/time/cwd，fixture 覆盖 discover/detail/search/stats |
| all-source-regression | done | 全部 supported 来源 list/detail/search/stats/类型检查回归通过 |

## 当前执行

- 当前分片：全部完成。
- 说明：legacy catalog 仍作为兼容读链路保留；v2 shadow 写入已不再从 legacy message 表搬运正文，而是复用 adapter 解析输出。

## 已确认样本

- Gemini：`~/.gemini/tmp/*/chats/session-*.json`。
- Kiro：`%APPDATA%/Kiro/User/globalStorage/kiro.kiroagent/workspace-sessions`，已确认 business-center 有 3 个会话 JSON。
- OpenCode：`~/.local/share/opencode/opencode.db`，本机只读确认 20 个 session、97 条 message、442 个 part。
- Antigravity：`%APPDATA%/Antigravity`。
- Grok Build：`~/.grok/sessions/<encoded-cwd>/<session-id>/updates.jsonl` + `summary.json`。
- Pi：`~/.pi/agent/sessions/**/*.jsonl`。
- Cline：VS Code/Cursor globalStorage 下 `saoudrizwan.claude-dev` 或 `cline.cline` 的 `tasks/<task-id>/api_conversation_history.json`，同目录可读 `ui_messages.json`、`task_metadata.json`。
- Cursor：`~/.cursor/projects/<project-slug>/agent-transcripts/<session-id>/<session-id>.jsonl`；本机同时存在 `state.vscdb`、`conversation-search.db`，parser 以 transcript 为主体，轻量只读 DB 元数据补标题、时间和工作区路径。

## 已落地

- Copilot：只读解析 `~/.copilot/session-state/*/events.jsonl`，支持 session id、cwd、消息、模型与工具事件；fixture 覆盖 discover/detail/search/stats，不依赖本机安装。
- Antigravity：只读解析 `~/.gemini/antigravity-cli` 或 legacy `~/.gemini/antigravity` 下的 transcript/history JSONL；fixture 覆盖 discover/detail/search/stats。
- Grok Build：只读解析 `~/.grok/sessions/*/*/updates.jsonl`，从 `summary.json` 取 session id、cwd、标题与模型，支持消息、工具统计与工具事件；fixture 覆盖 discover/detail/search/stats。
- Pi：只读解析 `~/.pi/agent/sessions/**/*.jsonl`，支持 session metadata、消息、模型与工具事件；fixture 覆盖 discover/detail/search/stats。
- Cline：只读解析 Cline task `api_conversation_history.json`，从同目录 `task_metadata.json` 取 session id/cwd/model/title，从 `ui_messages.json` 补时间，支持消息、工具统计、工具事件与文件变更摘要；fixture 覆盖 discover/detail/search/stats。
- Cursor：只读解析 `~/.cursor/projects/*/agent-transcripts/*/*.jsonl`，从路径取 session id/project slug，支持消息、工具统计、工具事件与文件变更摘要；额外只读 `conversation-search.db.conversations` 与 `state.vscdb.composerHeaders` 补 title/time/cwd，不解析 `cursorDiskKV`/`bubbleId:*`；fixture 覆盖 discover/detail/search/stats，SQLite helper 有独立回归。
- OpenCode：只读解析 SQLite `session/message/part`，写入 legacy catalog 虚拟 locator `<opencode.db>#session=<id>`；支持 list/detail/search/stats/prompts，edit/delete/convert/resume 保持禁用。
- OpenCode fixture：单测创建临时 SQLite，不依赖用户真实 DB。
- v2 core：Claude/Codex shadow build 改为复用 adapter 输出，写入 `history_sessions`、`history_messages`、`history_usage_events`、`history_session_model_usage`、`history_tool_events`、`history_file_changes`；Claude/Codex parity fixture 覆盖 token、model、raw pointer、tool/file change 与 Codex mixed locator。

## 网络调研结论

- Grok Build：官方源码确认本地历史在 `~/.grok/sessions/<encoded-cwd>/<session-id>/updates.jsonl`，session metadata 在同目录 `summary.json`；updates envelope 使用 `method` + `params.update.sessionUpdate`，核心 tag 包括 `user_message_chunk`、`agent_message_chunk`、`tool_call`、`tool_call_update`。
- GitHub Copilot CLI：默认历史在 `~/.copilot/session-state/<session-dir>/events.jsonl`；核心事件为 `session.start/user.message/assistant.message/tool.execution_start/tool.execution_complete`，session id 优先 `session.start.data.sessionId`，cwd 来自 `session.start.data.context.cwd`。
- Cline：官方源码任务历史入口确认 task history 管理存在；本地 task 主体按 Cline 既有文件名 `api_conversation_history.json`、`ui_messages.json`、`task_metadata.json` 只读解析。
- Cursor：本机确认 `%APPDATA%/Cursor/User/globalStorage/state.vscdb` 有 `composerHeaders`/`cursorDiskKV`，`conversation-search.db` 有 `conversations`/FTS；同时存在 `~/.cursor/projects/*/agent-transcripts/<sessionId>/<sessionId>.jsonl`。实现策略为 transcript 主体 + DB 元数据增强，不读取私有正文 KV。

## Fixture blockers

- 当前无 parser fixture blocker；Cursor 标题/时间/cwd 已用临时 SQLite fixture 覆盖，归档状态暂不接入现有 API。
