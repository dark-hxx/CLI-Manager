# 执行计划：WebDAV 同步外观字段

前置阅读顺序：父任务 `prd.md` → 父任务 `design.md` §5 → 本文件。
开工前确认 `08-24-appearance-data-layer` 已合入。

## 步骤

1. `src/stores/syncStore.ts:132-133`：`PROJECT_SELECT` / `GROUP_SELECT` 列清单加 `icon, color`。
2. 同文件 `buildWorkspaceRestoreStatements`：
   - `:393` 的 `buildBatchInsertStatements("groups", [...])` 列数组加 `icon`, `color`，映射函数补 `item.icon ?? ""`、`normalizeAccentToken(item.color)`。
   - projects 的对应插入处同样处理。
   - `normalizeAccentToken` 复用 `src/lib/nodeAppearance.ts` 的 token 校验，不在 syncStore 里重写。
   - **不要改动语句顺序**（DELETE 子表先于父表、INSERT groups 先于 projects），恢复开了外键约束。
3. **与步骤 2 同一次提交**：`src-tauri/src/commands/sync.rs:30-56` 更新 `BACKUP_RESTORE_INSERT_COLUMNS` 的 `groups`（`:31`）与 `projects`（`:42`）列串，顺序必须与前端列数组逐字一致。
   - 漏改这里 → `validate_backup_database_statement`（`:72`）整批拒绝 → 事务回滚，恢复完全失败。
   - 校验方式：把前端列数组 `join(",")` 的结果与 Rust 字符串肉眼逐字比对（注意 Rust 侧无空格）。
4. 复核参数预算：`BACKUP_RESTORE_MAX_PARAMS_PER_STATEMENT = 30000`、`BACKUP_RESTORE_MAX_STATEMENTS = 1000`（`sync.rs:19-20`）。projects 20→22 列、groups 5→7 列，确认 `buildBatchInsertStatements` 的分片行数计算按列数动态推导；若是硬编码行数，改为按列数计算。
5. 核查 `BackupSnapshotV3` / `WorkspaceBackup` 类型定义与任何字段清单、canonicalize（`syncStore.ts:178`）参与的哈希计算，确认新增字段不会让旧快照校验失败。
6. 恢复预览提示：找到恢复预览渲染处，新增一行说明"外观标记将被所选快照覆盖；旧版快照不含外观信息，恢复后退回自动配色"。i18n 键补齐全部语言。
7. 恢复完成后确认走了 `projectStore.fetchAll()`（或等效刷新），否则内存态与库不一致。
8. 更新 `CHANGELOG.md`（追加到既有 `## [V1.3.8]` 段）与 `docs/功能清单.md`。

## 验证

```bash
npx tsc --noEmit
cd src-tauri && cargo check
```

人工往返验证（按顺序执行，每步记录结果）：

1. 设置若干分组/项目的颜色与 emoji → 触发备份 → 检查远端快照 JSON 含 `icon` / `color`
2. 手改本地外观 → 用步骤 1 的快照恢复 → 外观回到快照状态
3. 手工删掉快照 JSON 里的 `icon` / `color` 字段 → 恢复 → 不报错、退回自动配色
4. 把快照里某个 `color` 改成 `"#ff0000"` 之类非 token 值 → 恢复 → 落空串，不写脏值
5. 本地导入（`localImport`）路径重复步骤 2-3，确认与 WebDAV 路径行为一致

## 实现结果（与计划的偏差）

- **前后端白名单锁步按预期是必改项，而且被 Rust 测试当场抓住**：只改前端列清单后，`cargo test --lib sync` 有 3 个既有测试直接失败并返回 `backup_restore_database_statement_invalid`。更新 `BACKUP_RESTORE_INSERT_COLUMNS`（`sync.rs`）以及三个测试里的 fixture 表结构与 INSERT 语句后全部通过。测试 fixture 也需要加 `icon`/`color` 列，这一点计划里没写。
- **参数预算无需改动**：`buildBatchInsertStatements`（`src/lib/db.ts:149`）本来就是 `floor(30000 / colCount)` 动态分片，与 Rust 侧 `BACKUP_RESTORE_MAX_PARAMS_PER_STATEMENT = 30000` 对齐。projects 22 列 → 每语句 1363 行，语句数远低于 1000 上限。
- **`WorkspaceBackup` 类型无需改动**：`groups` / `projects` 声明为 `Record<string, unknown>[]`，对新增字段透明。
- **`contentHash` 无需特殊处理**：它是 `sha256(data)` 且只与自身 manifest 比对，新旧快照各自自洽。副作用：数据形态变化导致本次升级后首次自动备份的哈希必然不同，会重新上传一次（`syncStore.ts` 的 `lastHash` 短路失效一次），属预期。
- **步骤 7 无需改动**：恢复流程已在 workspace 域恢复后调用 `useProjectStore.getState().fetchAll()`。
- **提示文案挂在数据域选择器上**：只在勾选了"工作区"时显示，避免只恢复偏好/价格时出现无关提示。

## 已执行验证

- `npx tsc --noEmit`：无错误。
- `cd src-tauri && cargo check`：通过。
- `cargo test --lib sync`：27 passed（含 3 个先前失败的恢复测试）。第一个恢复测试的断言已扩展为同时校验 `icon` / `color` 的落库值（写入 `🚀` / `p3`，恢复后读出一致），即真实验证了外观往返而不只是通过 validator。
- `cargo test --lib db_repair`：15 passed（确认 migration 33 不在漂移修复窗口内）。
- 列清单锁步核查（脚本比对，非肉眼）：Rust 白名单与前端内联列数组逐字一致 —— `groups` / `projects` / `worktrees` / `command_templates` 全部 OK。
- 导出/恢复列集合核查：`PROJECT_SELECT` 22 列与 projects 插入列集合、顺序完全一致；`GROUP_SELECT` 7 列同理；两者都含 `icon` / `color`，往返不丢字段。
- 未执行：真实 WebDAV 端到端往返（备份 → 清空 → 恢复 → 篡改快照再恢复），需要配置好的远端与人工操作。

## 回滚点

- 步骤 1（导出）与步骤 2（恢复）可分别回滚，但**不要只回滚其中一个**：只导出不恢复会让往返静默丢字段。
- 步骤 4 提示文案独立，可单独回滚。
