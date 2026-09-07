# 实现清单

- [x] 完成历史索引 schema/FTS 升级逻辑。
- [x] 调整查询拆分和搜索摘要生成，保持 legacy/V2 结果字段兼容。
- [x] 增加 v5→v6、FTS 搜索、替换/删除一致性测试。
- [x] 更新 `[TEMP]` 下的 CHANGELOG；本任务不改变产品功能清单。
- [x] 运行 `cargo fmt -- --check`、`cargo test history --lib`、`cargo check`。
- [x] 加载并执行 `trellis-check` 与 `trellis-update-spec`。
