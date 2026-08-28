# 技术设计

## 边界

只修改 `src-tauri/src/commands/history/catalog.rs` 及必要的测试、`CHANGELOG.md`。索引数据库是派生缓存，升级逻辑位于 `ensure_schema` / `ensure_v2_schema`。

## 方案

1. schema 版本从 5 升至 6。
2. 两个 FTS5 表改用 `detail='none'`，保留 trigram tokenizer 和 MATCH 能力。
3. v5→v6 升级时删除并重建两个 FTS 表及触发器，再从正文表执行 `rebuild`。
4. FTS 无位置明细后，查询把用户输入拆成重叠三元组并用 `AND` 找候选，再由正文表执行连续子串过滤，保持字面量搜索语义。
5. 搜索命中通过普通表内容生成有界摘要，不再依赖 `snippet()` 的 offset 计算。
6. 升级完成后执行一次 `VACUUM` 回收旧 FTS 和 freelist；日常刷新只做轻量维护，避免每次阻塞索引刷新。
7. 版本号只在全部 DDL、重建、维护成功后写入。

## 风险与回滚

- 升级期间需要额外临时磁盘空间；失败时保留旧数据库，不写入新版本号。
- `detail='none'` 不支持多 token phrase 查询和 FTS5 snippet，因此查询拆分、正文过滤和摘要逻辑必须有单元测试。
- 若升级失败，删除派生 `history-catalog.db` 后可从原始历史重建；不影响原始数据。
