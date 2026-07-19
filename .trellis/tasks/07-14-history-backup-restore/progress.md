# 历史备份与恢复实现进度

- [x] B1：默认 backup root 解析为当前运行环境 `$HOME/.cli-manager/backups`，并返回 environment kind/key。
- [x] B2：Backup Service 提供 root status IPC，展示占用、7 天保留、1 GiB 上限和受保护条目。
- [x] B3：文件型备份使用 mutation 目录 + `manifest.json`，manifest 原子写入。
- [x] B4：保留旧消息级“首次备份可恢复”语义，兼容既有 `history_restore_session_backup`。
- [x] B5：主会话物理删除使用本次 mutation 独立快照，不复用旧消息编辑备份。
- [x] B6：单次快照超过默认 1 GiB 时阻止 mutation，不跳过备份、不静默超限。
- [x] B7：Backup Service 提供仅当前 mutation 生效的临时上限 preflight IPC，不写入长期设置。
- [x] B8：7 天 / 1 GiB 清理按完整 mutation 目录执行，并兼容 legacy 文件备份。
- [x] B9：执行中、恢复中、`manualRecoveryRequired` 和 manifest 异常目录不会被自动清理。
- [x] B10：restore plan 展示 backup/original/manifest、可执行状态、目标进程检查、fingerprint 冲突和执行动作。
- [x] B11：提供 restore execute IPC，执行恢复后刷新历史缓存入口。
- [x] B12：提供 manifest export IPC，支持人工恢复时导出 manifest。
- [x] B13：目标工具运行中禁止 restore、delete、convert，无 override。
- [x] B14：回滚失败写入来源 mutation lock，后续 edit/delete/convert/普通 restore 被后端阻止。
- [x] B15：主会话级联删除失败时按逆序恢复已删文件；恢复成功返回 `failedRolledBack`，恢复失败返回 `manualRecoveryRequired`。
- [x] B16：SQLite/WAL、row graph、mixed artifact 的备份策略和写入闸门已在设计文档中明确；真实执行在对应 Backup Service 能力前不开放。
- [x] B17：设置 -> 历史来源新增备份状态、打开目录、立即清理、恢复 plan、执行恢复、导出 manifest 入口。
- [x] B18：新增/更新后端单测覆盖 mutation 目录、临时上限、fingerprint 冲突、restore execute、subagent/delete 级联。
