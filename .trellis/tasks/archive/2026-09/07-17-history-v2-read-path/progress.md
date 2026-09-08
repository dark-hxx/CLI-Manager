# 历史 v2 读链路迁移进度

## 分片

| 分片 | 状态 | 完成口径 |
| --- | --- | --- |
| v2-list-search-read-path | done | list/search 合并 v2 与 legacy；v2 优先、legacy 缺口兜底 |
| v2-stats-read-path | done | stats 从 v2 usage/session 聚合读取并覆盖同 session legacy facts；legacy 缺口兜底 |
| v2-detail-read-path | done | 普通 detail 优先从 v2 message/usage/tool/file_change 组装；聚合子任务和缺口 legacy 兜底 |
| legacy-read-path-cleanup | done | legacy 已降级为兼容兜底，不删除代码 |

## 当前执行

- 当前分片：全部完成。
- 已完成：`v2-list-search-read-path`、`v2-stats-read-path`、`v2-detail-read-path`、`legacy-read-path-cleanup`。
- 场景边界：已完成分片只迁移只读 list/search，不触碰 detail、stats、delete、convert、resume。

## 分诊

- 任务类型：新功能迁移。
- 场景矩阵覆盖：多来源、Worktree 路径、本地/WSL 历史、旧 catalog 已存在、v2 shadow build 未完成、搜索无命中。
- Discovery：GitNexus impact `history_list_sessions` 与 `history_search` 上游风险 LOW。

## 已完成

- v2 shadow build 不再限制 `claude/codex`，active source instance 均可进入 v2。
- `list_sessions` 合并 v2 和 legacy catalog，按更新时间重新排序并去重。
- `search_sessions` 合并 v2 FTS 和 legacy FTS，v2 命中优先。
- 回归：非核心 source shadow build、v2 list/search 优先、legacy 缺口兜底。
- `history_get_stats` 接入 v2 facts，同 session 去重后覆盖 legacy facts。
- 回归：v2 usage events 可生成 stats facts。
- `history_get_session` 在非 aggregate subtasks 情况下优先读取 v2 detail。
- v2 detail 覆盖 messages、usage token trend、tool events、file changes。
- cleanup 结论：legacy 仍保留为 v2 缺口、旧缓存和 aggregate subtasks 的必要兜底；删除会降低兼容性。
