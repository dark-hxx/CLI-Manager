# 实施计划

1. 在 `db_repair.rs` 增加 migration 32 兼容登记检查，复用 `lib.rs` 中原始 SQL常量计算 checksum。
2. 在 `db_repair.rs` 增加单飞、批处理的后台 project-path 回填命令与纯映射辅助函数。
3. 在 `lib.rs` 注册命令，在 `db.ts` 的 `Database.load` 成功后非阻塞触发。
4. 补充 Rust 回归与大数据量批次测试，验证 migration checksum 和最终数据等价性。
5. 更新 `[TEMP]` CHANGELOG、功能清单与 verification。
6. 执行格式化、聚焦测试、Rust/TypeScript 编译、Git diff/影响范围检查。
7. 复用缓存，仅构建 NSIS 并输出路径、大小和 SHA256。
