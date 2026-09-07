# 修复历史索引压缩迁移检测

## Goal

当历史索引 user_version 已为 6 但 FTS 表仍为旧 detail=full 时，启动迁移必须检测真实 schema 并重建压缩索引。

## Requirements

- 启动时不能只相信 `PRAGMA user_version`，还必须确认两个历史 FTS 表确实使用 `detail='none'`。
- 发现版本号为 6 但 FTS 仍为旧 schema 时，复用现有压缩重建流程，保留普通消息表数据。
- 已经是压缩 schema 的数据库保持快速路径，不重复重建。
- 不修改源 JSONL 历史文件，不自动提交 Git。

## Acceptance Criteria

- [ ] `user_version=6` 且 FTS 为旧 schema 的数据库会在启动时重建为 `detail='none'`。
- [ ] `user_version=6` 且 FTS 已压缩的数据库不会重复重建。
- [ ] 现有历史消息和英文/中文搜索能力保持不变。
- [ ] 通过格式检查、历史 Rust 测试和 `cargo check`。

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
