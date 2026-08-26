# WebDAV 同步外观字段

父任务：`08-24-sidebar-node-appearance`。技术契约见父任务 `design.md` §5。
依赖：`08-24-appearance-data-layer`。可与 `08-24-history-stats-appearance` 并行。

## Goal

让 `icon` / `color` 进入 WebDAV 备份与恢复往返，并把"旧版快照恢复会清空外观"这一副作用变成用户可预期的行为。

## Requirements

- R-S1 导出侧：`src/stores/syncStore.ts:132` `PROJECT_SELECT` 与 `:133` `GROUP_SELECT` 加入 `icon, color`（两处均为显式列，不改则字段不会被同步）。
- R-S2 恢复侧：`buildWorkspaceRestoreStatements`（`:362` 起）中 `groups` 的插入列表（`:393`）与 `projects` 的插入列表补同名列，取值 `item.icon ?? ""` / `item.color ?? ""`。
- R-S3 向后兼容：旧客户端生成的快照缺这两个字段时，恢复不得报错，落空串并退回自动配色。
- R-S4 非法值防御：远端快照里的 `color` 若不是调色板 token，恢复后按空串处理（与 `resolveNodeAppearance` 的回落一致），不写入脏值。
- R-S5 恢复预览提示：由于恢复是 `DELETE FROM` + 重插（`:377-392`），用旧版快照恢复会清空本地手动标记。需在恢复预览界面给出提示文案（新增 i18n 键，覆盖全部语言）。
- R-S6 备份快照的版本/校验逻辑（`BackupSnapshotV3` 相关）如含字段清单或哈希，需同步更新，保证新旧快照都能通过校验。
- R-S7 **后端 SQL 白名单锁步**：`src-tauri/src/commands/sync.rs:30-56` 的 `BACKUP_RESTORE_INSERT_COLUMNS` 是精确字符串白名单（`groups` 见 `:31`、`projects` 见 `:42`）。前端 INSERT 列变更必须与该白名单在同一次提交内同步，且列顺序完全一致；否则 `validate_backup_database_statement`（`:72`）整批拒绝，恢复在 `BEGIN IMMEDIATE` 事务内全量回滚。
- R-S8 **顺序与预算不变**：恢复开启了外键约束，DELETE 子表先于父表、INSERT 父表（groups）先于子表（projects）的既有顺序不得改动；单语句参数上限 30000、单次语句上限 1000（`sync.rs:19-20`），projects 20→22 列后需复核 `buildBatchInsertStatements` 分片行数。

## 非目标

- 不改同步的冲突处理策略与自动同步时机。
- 不为外观字段做字段级合并（沿用现有整域覆盖语义）。
- 不引入任何 `UPDATE` 类恢复语句（validator 只放行白名单 DELETE 与 INSERT）。

## Acceptance Criteria

- [ ] 设置外观 → 备份 → 清空本地 → 恢复，外观字段完整还原
- [ ] 用不含外观字段的旧快照恢复：不报错，节点退回自动配色
- [ ] 快照中被人为篡改成非法 `color` 的数据恢复后不产生脏值
- [ ] 后端白名单与前端列清单一致，恢复不出现 `backup_restore_database_statement_invalid`
- [ ] 恢复预览界面能看到"外观标记会被远端覆盖"的提示，且各语言有文案
- [ ] `npx tsc --noEmit` 与 `cd src-tauri && cargo check` 通过
- [ ] `CHANGELOG.md`（追加到既有 `## [V1.3.8]` 段）与 `docs/功能清单.md` 已更新

## 备注

后端 `src-tauri/src/sync/mod.rs` 中 projects / groups 为 `Vec<serde_json::Value>`（`:34-35`），上传/下载链路对新增字段透明；真正需要改的后端点是 `commands/sync.rs` 的 INSERT 列白名单（见 R-S7）。并发与顺序细节见父任务 `design.md` §8。
