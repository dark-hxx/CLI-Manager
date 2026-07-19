# 设计：历史 v2 读链路迁移

## 原则

- 不重写 parser。
- 不引入新依赖。
- 每个分片保留 legacy 兜底，避免一次性切断现有用户历史。

## 顺序

1. `list/search`：只读、风险最低，可先验证 v2 索引完整性。
2. `stats`：统一统计口径。
3. `detail`：触达 tool/file/diff/raw pointer，最后切。
4. cleanup：确认 v2 稳定后再删重复逻辑。

## 本分片

`v2-list-search-read-path` 只改会话列表和搜索入口：

- v2 有索引：优先从 `history_sessions` / `history_messages` 读取。
- v2 无索引或查询失败：继续走 legacy catalog。
- 不改变 IPC 参数和前端类型。
