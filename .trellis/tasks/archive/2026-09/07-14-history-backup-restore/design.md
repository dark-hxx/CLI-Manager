# 历史备份与恢复技术设计

## 边界

- 本任务实现统一 Backup Service、manifest、配额清理、自动回滚和人工恢复。
- 来源 adapter 负责声明 artifact graph、fingerprint、backup/restore operation，不自行管理备份目录。
- History Index DB 只在 mutation/restore 完成后做定向重新解析。
- 真实 mutation 必须依赖对应来源已实现的备份能力。

## 核心接口

```rust
trait HistoryBackupService {
    fn preflight(&self, plan: &HistoryMutationPlan) -> Result<HistoryBackupEstimate>;
    fn create_backup(&self, plan: &HistoryMutationPlan) -> Result<HistoryBackupManifest>;
    fn build_restore_plan(&self, mutation_id: &str) -> Result<HistoryRestorePlan>;
    fn restore(&self, plan: &HistoryRestorePlan) -> Result<HistoryRestoreResult>;
    fn cleanup(&self, environment_key: &str) -> Result<HistoryBackupCleanupResult>;
}
```

## 状态

```text
creating -> ready -> mutationApplying -> completed
                         |
                         v
                    rollingBack -> rolledBack
                                   | failure
                                   v
                         manualRecoveryRequired

ready/completed/rolledBack -> restoring -> restored
```

## 阶段

1. B1：backup root resolver、manifest、estimate、文件型 snapshot。
2. B2：7 天 / 1 GiB 清理、自动 rollback、启动恢复。
3. B3：设置页备份列表、恢复 plan、永久清理。
4. B4：SQLite online backup、row graph、mixed artifact。

## 约束

- 每个环境独立配额。
- 临时超额备份不长期豁免默认配额；完成后按 7 天 / 1 GiB 自动清理。
- 无 restore strategy 不允许破坏性 mutation。
- 目标工具运行时禁止 restore/apply。
- shared artifact 不允许用旧快照覆盖无关新数据。
- 已验证 shared artifact 允许逻辑备份；未知 schema、独占文件或破坏性重写必须完整快照。
- manifest 和状态写入使用 atomic replace。
- 完整设计与测试矩阵见 `docs/历史备份与恢复设计.md`。
