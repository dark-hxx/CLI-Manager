# 实施计划：路由历史用量异常详情

## 预改动门禁

- [x] GitNexus 初次重建受 `.gitnexus/lbug` 权限问题阻塞；代码改动前已对目标符号完成 impact 分析，交付前已完成 change detection。工作区级 critical 结果由并行供应商编辑器改动触发，本任务目标调用链保持 low risk。
- [x] 已读取 `trellis-before-dev`、历史统计契约与相关前端指南。
- [x] 已确认工作区中其他任务的改动未与目标文件重叠，未覆盖它们。

## 实施步骤

1. [x] 后端错误捕获与安全净化
   - 在 `usage.rs` 定义受控错误详情提取与脱敏/限长规则，并让 `UsageCapture` 承载可选详情。
   - 扩展 `record_route_usage` / best-effort wrapper，持久化 `error_detail`；保持 usage-status、attempt 和 circuit 语义不变。
   - 在 `route_http.rs` 的非流式错误 body、失败发送/skip 与流式结束分支传递正确的稳定 code、status 和安全详情。

2. [x] SQLite 与历史日志 payload
   - 为 `usage_records.error_detail` 添加连续迁移，并在新库建表及所有 `unified_usage_records` view 定义中保持字段一致。
   - 扩展 `RequestLogItem`、列表 SELECT 和 row 映射，返回 optional `error_code` / `error_detail`。
   - 添加迁移和列表回归测试，验证旧 `NULL` 行及聚合不受影响。

3. [x] 前端状态摘要与详情交互
   - 扩展 TypeScript 类型/normalization。
   - 在 `RequestLogsView` 中增加错误摘要解析、详情按钮与可访问 dialog；保持 session 双击、过滤、分页和 sticky action column 行为。
   - 增加中英文 i18n 键，包含按钮、aria、字段标签、空详情与未知 code 回退。

4. [x] 文档与质量
   - 更新 `history-stats-contracts.md`，明确错误诊断字段、脱敏边界、旧记录兼容和测试契约。
   - 更新 `CHANGELOG.md` 的 `[TEMP]` 条目及 `docs/功能清单.md` 中分析看板/请求日志相关项。
   - 运行格式、针对性 Rust tests、`cargo check`、`npx tsc --noEmit`、`npm run build`、`git diff --check`；提交前运行 GitNexus change detection（若工具仍不可用，明确报告原因）。

## 回滚

* 前端可回退为不读取新增 optional 字段；旧记录不会受影响。
* SQLite 新列为 nullable、只追加，回滚代码后数据库仍可被旧版本忽略；不删除已有记录。

## 验收检查

- [x] 路由失败不会再以“usage 不适用”作为唯一信息。
- [x] 点击异常入口显示安全诊断内容和可用上下文；键盘可关闭。
- [x] 脱敏与长度限制自动化覆盖。
- [x] 正常、旧、session-log、流式/非流式、skip/failover 记录未回归。
- [x] 交付文档、质量检查和变更检测完成。

## 验证记录

- `cargo test --lib`：1122 passed，1 ignored。
- `cargo check`、`npx tsc --noEmit`、`npm run build`、`git diff --check`：通过。
- 按任务限制未启动 Tauri 桌面运行时；交付后手动覆盖真实路由 HTTP/stream 失败、旧记录、中文/英文、长详情滚动、双击隔离与 Escape 关闭。
