# Recall / 多来源历史会话验收清单

适用任务：

- `.trellis/tasks/07-14-history-sources-integration-plan`
- `.trellis/tasks/07-14-history-backup-restore`

## 1. Trellis 进度状态

- `07-14-history-sources-integration-plan/progress.md`：13 / 13 已完成。
- `07-14-history-backup-restore/progress.md`：18 / 18 已完成。
- 两个 `task.json` 状态均为 `done`，`completedAt=2026-07-14`。

## 2. 自动验证命令

在仓库根目录或指定子目录执行：

```powershell
npm exec tsc -- --noEmit
```

预期：通过。

```powershell
cd src-tauri
cargo check
```

预期：通过。

```powershell
cd src-tauri
cargo test v2_adapter_outputs --lib
cargo test shadow_build_v2_populates --lib
cargo test record_v2_index_failure_upserts_retry_count --lib
cargo test history_backup --lib
cargo test backup_created_once_and_restore_recovers_original --lib
cargo test delete_session_tree_rejects_subagent --lib
cargo test build_session_detail_marks_direct_subagent --lib
cargo test conversion_matrix_supports_current_writers --lib
```

预期：全部通过。

```powershell
git diff --check
```

预期：无 whitespace error。Windows 下可能出现 `LF will be replaced by CRLF` 警告，可忽略。

## 3. 历史来源设置验收

打开 `设置 -> 历史来源`：

1. 每个来源只能保存一个 active 读取位置。
2. 内置来源列表包含 Claude、Codex、Gemini、Copilot、OpenCode、Cursor、Kiro、Cline、Antigravity、Grok、Pi。
3. 保存 Claude/Codex 读取位置前会做后端校验。
4. 未配置或不可写的目标来源不开放转换。
5. 新建项目 CLI 工具下拉保留 `custom`，并内置 Claude/Codex/Gemini/OpenCode 等选项。

## 4. History Index v2 验收

后端能力：

1. `history_get_index_v2_status` 可返回 v2 schema 状态。
2. `history_index_v2_preview_adapter_sessions` 可输出 `sessionRef + rawPointers`。
3. shadow build 会写入 `history_sessions/history_messages`，并记录 sync run、source state、failure retry。
4. 当前阶段不改变旧 Claude/Codex 历史读取主链路。

## 5. 转换矩阵验收

后端：

1. 调用 `history_get_conversion_matrix`。
2. Claude -> Codex、Codex -> Claude 为 `supported`。
3. 同源转换为 `unsupported`。
4. 其他已登记来源组合为 `planned`，不是永久只读。

前端：

1. 历史列表和详情只在 capability 支持时显示转换入口。
2. 有损转换必须弹确认。
3. subagent 行不允许单独转换。
4. 后端直接转换 subagent 返回 `history_subagent_mutation_not_allowed`。
5. 目标工具运行中转换返回 `history_target_tool_running`。

## 6. Subagent 验收

1. 直接打开 subagent 详情时，所有消息 `editable=false`。
2. subagent 不允许单独编辑、删除、转换。
3. 删除主会话时，关联 subagent 一起物理删除。
4. 任一删除步骤失败时，已删除文件按逆序恢复。
5. 回滚失败返回 `manualRecoveryRequired`，并锁定该来源后续 mutation。

## 7. 备份与恢复验收

设置页 `历史来源 -> 备份与恢复`：

1. 显示默认 backup root：当前运行环境 `$HOME/.cli-manager/backups`。
2. 显示 environment key、当前占用、1 GiB 上限、7 天保留和受保护条目数。
3. “打开目录”能打开 backup root。
4. “立即清理”执行 `history_backup_cleanup`。
5. 输入原始历史文件路径和来源后，“生成恢复计划”执行 `history_backup_build_restore_plan`。
6. 恢复计划展示 backup path、manifest path、是否可恢复和阻塞原因。
7. “导出 manifest”执行 `history_backup_export_manifest`。
8. “执行恢复”执行 `history_backup_execute_restore`，目标工具运行中必须阻止。

后端：

1. 文件备份落在完整 mutation 目录下，包含 `manifest.json` 和 `files/` 快照。
2. manifest 使用原子写入。
3. 单次快照超过默认 1 GiB 返回 `history_backup_size_limit_exceeded`。
4. 临时上限只通过 preflight/当前 mutation 生效，不写入长期设置。
5. 清理以完整 mutation 目录为单位。
6. `running/restoring/manualRecoveryRequired` 和 manifest 异常目录不会被自动删除。
7. 普通消息级恢复保留“首次备份恢复”兼容语义。
8. 主会话删除使用本次 mutation 独立快照，不能复用旧消息编辑备份。
9. manual recovery 状态下 fingerprint 不一致时，restore plan 返回 `history_backup_fingerprint_conflict`。

## 8. 数据库 / mixed artifact 阶段边界

当前阶段不开放 SQLite/WAL/mixed artifact 的真实外部写入。

验收方式：

1. 设计文件 `docs/历史备份与恢复设计.md` 明确 SQLite online backup、row graph、mixed artifact 策略。
2. `docs/历史来源接入规划.md` 明确未知 schema、缺少 restore strategy、目标工具运行中均阻止 mutation。
3. conversion matrix 中未完成 writer 的来源为 `planned`，不能误报 `supported`。

## 9. 保留的已知边界

- 本阶段没有新增 Gemini/Copilot/OpenCode 等真实 parser；只登记 descriptor、roadmap 和 capability。
- 数据库/混合来源的真实 mutation 仍需后续单独实现 adapter writer、restore strategy 和目标版本基准测试。
- `cargo fmt --check` 未作为本次验收项；当前环境未确认 rustfmt 可用。
