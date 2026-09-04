# SQLite Lock Contention Fix Implementation Plan

## 1. Gates

- [x] 当前 `feat/git-history` 与 `fork/feat/git-history` 同步（ahead 0 / behind 0），初始工作区干净。
- [x] 用户同意创建 Trellis task。
- [x] 按根因修复处理并完成根因陈述、场景检查和发现清单。
- [x] codebase-memory 调用链分析对核心符号给出 HIGH/CRITICAL 风险；GitNexus MCP/CLI 未暴露，已按规则降级并用源码、查询计划和运行日志复核。
- [x] 用户确认本实施计划。
- [x] 启动 Trellis task。

## 2. Schema Bootstrap

- [x] 为健康用量 Schema 增加只读一致性检查。
- [x] 仅在相应表缺失时执行 request/usage 建表 bootstrap，禁止健康连接重复执行 189 万行 `INSERT OR IGNORE`。
- [x] `error_detail` 与 migration marker 已一致时直接返回；不一致时在写事务内复查后修复。
- [x] 增加完整 Schema 可在只读连接重复检查的回归测试。

## 3. Request Log Replacement

- [x] 提取事务内按文件删除助手，先通过既有 `request_logs(file_path, event_key)` 索引取得 ID，再按 `usage_records.record_id` 主键删除。
- [x] `replace_document` 与 `remove_missing_files` 复用同一清理实现。
- [x] 增加查询计划/行为测试，确认不扫描全部 `usage_records` 且数据结果不变。

## 4. Records And Verification

- [x] 更新 `[TEMP]` CHANGELOG 和功能清单。
- [x] 刷新代码索引并执行变更影响检查。
- [x] 运行 Rust 定向测试、格式检查、`cargo check`、TypeScript 检查和前端生产构建。
- [x] 仅构建 NSIS 安装包，复用 Cargo/npm 缓存，跳过 MSI 与更新签名。
- [x] 记录验证结果、剩余风险和安装包路径。
