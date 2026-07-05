# favorite session snapshots

## Changelog Target

[TEMP]

## Goal

历史会话点击收藏后，不只保存收藏标记，还保存会话内容快照到应用 SQLite 数据库。这样原始 Claude/Codex 历史文件被删除后，收藏会话仍能在历史收藏中查看。

## Requirements

* 保留现有 `session_meta.starred` 收藏标记。
* 收藏会话时写入完整会话详情快照到 SQLite。
* 取消收藏时删除对应快照，保持“取消收藏即不再归档”的简单语义。
* 历史列表加载时，正常扫描原始历史文件；同时补充源文件已不存在的收藏快照。
* 打开源文件已不存在的收藏会话时，从 DB 快照只读展示。
* 不修改 Claude/Codex 原始历史 JSONL。
* 关联 GitHub Issue：Refs #90。

## Acceptance Criteria

* [ ] 收藏一个历史会话后，DB 中存在该会话快照。
* [ ] 删除原始历史 JSONL 后，收藏会话仍出现在历史列表。
* [ ] 删除原始历史 JSONL 后，点击收藏会话能打开收藏时的内容。
* [ ] 取消收藏后，快照被删除，列表不再显示该收藏项。
* [ ] 原始历史文件存在时，仍优先使用现有扫描结果。

## Definition of Done

* TypeScript 类型检查通过。
* Rust 编译检查或相关测试通过。
* `CHANGELOG.md` 更新到 `[TEMP]`。
* `docs/功能清单.md` 更新收藏归档能力。

## Technical Approach

新增 `session_favorite_snapshots` 表保存收藏快照。前端收藏时如果目标会话详情已加载则直接序列化，否则调用 `history_get_session` 获取详情后写入。历史列表加载时先应用现有 `session_meta` 合并逻辑，再把 DB 中 `starred=1` 且当前扫描结果不存在的快照补成 `HistorySessionView`。打开会话时，如果扫描目标不存在但存在快照，则直接使用快照详情。

## Decision (ADR-lite)

**Context**: 当前收藏是引用式收藏，仅保存 `starred` 标记；原始历史文件删除后 UI 无法展示会话。

**Decision**: 实现“收藏即归档”，保存完整详情快照；取消收藏删除快照。

**Consequences**: DB 会随收藏数量增大；快照是收藏时内容，不追踪后续源文件变化；实现简单、行为明确。

## Out of Scope

* 不做独立收藏管理页。
* 不做快照压缩或自动清理策略。
* 不把收藏快照纳入云同步/本地同步。
* 不修复项目源代码文件被删除后的 diff 跳转失败。

## Technical Notes

* `src/stores/historyStore.ts`：收藏标记写入、历史列表加载、打开会话逻辑。
* `src/lib/types.ts`：历史会话与元数据类型。
* `src-tauri/src/lib.rs`：SQLite migrations。
* 现有收藏标记表：`session_meta`。
