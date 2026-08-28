# 优化历史会话索引数据库体积

## Changelog Target

- `[TEMP]`

## Goal

降低 `C:\Users\1\.cli-manager\history-cache\history-catalog.db` 的异常体积，同时保留历史会话列表、三字符全文搜索、增量刷新和 V2 统计能力，不删除用户原始历史文件。

## Confirmed Facts

- 当前数据库大小约 2.05 GiB（2,198,007,808 bytes）。
- SQLite `page_count=536623`、`page_size=4096`、`freelist_count=68217`，约 267 MiB 是可回收空闲页。
- 旧目录消息表 102,713 条，正文约 145 MiB；其 trigram FTS 数据约 1.21 GiB。
- V2 消息表 33,167 条，正文约 46 MiB；其 trigram FTS 数据约 294 MiB。
- 旧目录与 V2 各自保存消息正文和 FTS，迁移期间存在重复物化。
- 当前 schema 版本为 5，FTS 使用 `tokenize='trigram case_sensitive 0'`，未指定 `detail='none'`，未配置数据库碎片回收维护。
- 搜索结果当前使用 FTS5 `snippet()`，因此 FTS 降级必须同步调整结果摘要生成。
- 索引库是可重建派生缓存；原始 JSONL 不得被修改或删除。

## Root Cause

历史索引把完整消息正文同时写入普通表和 trigram FTS；FTS 默认保存位置/列细节，三元组索引对长文本产生远大于正文的膨胀；更新删除后 SQLite 又保留大量 freelist 页面，最终形成“正文约 191 MiB、索引约 1.5 GiB、碎片约 267 MiB”的体积结构。

## Requirements

- R1：继续支持至少 3 个字符的中英文/ASCII 字面量搜索。
- R2：使用更小的 FTS5 存储模式，并保持搜索结果中的会话、角色、时间和可读摘要。
- R3：schema 升级兼容现有 v5 数据库，升级失败不得提前写入新版本号。
- R4：升级时重建 FTS 并回收历史碎片；正常增量刷新不得每次执行重型全库 `VACUUM`。
- R5：新增或修改测试覆盖 FTS 升级、搜索结果、增量写入和数据库维护行为。
- R6：不新增依赖，不修改原始历史文件，不改变前端 IPC 契约。

## Acceptance Criteria

- [ ] AC1：现有 v5 数据库可自动升级，表数据和搜索结果不丢失。
- [ ] AC2：FTS 数据体积显著小于当前默认 detail 模式，搜索三字符中英文结果仍正确。
- [ ] AC3：升级后数据库 freelist 明显下降，数据库大小不再因升级残留旧 FTS 页面。
- [ ] AC4：文件变更、删除、重新索引后的 FTS 结果与正文表一致。
- [ ] AC5：`cargo fmt -- --check`、`cargo test history --lib`、`cargo check` 通过；不主动运行受 guardrail 禁止的前端/桌面启动命令。

## Out of Scope

- 不清理用户原始 Claude/Codex/OpenCode 等历史目录。
- 不在本任务中拆除 legacy/V2 双写架构；只控制其索引存储和维护成本。
- 不修改前端历史搜索交互和 IPC 字段。

## Open Questions

- 无。实现方案采用 FTS5 `detail='none'` + 兼容摘要生成；版本继续记录在 `[TEMP]`。
