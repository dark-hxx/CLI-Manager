# 修复会话历史多选与编辑/删除持久化

## Goal

恢复会话历史中的会话/消息批量选择入口与可操作反馈，并确保编辑或删除消息后，重新打开、手动刷新或重启应用仍读取已写回的历史内容。

## Requirements

* 会话历史列表继续提供进入多选、选择可见会话、批量删除和取消选择；树形父会话与子 Agent 的选择语义保持一致。
* 已加载的本地可编辑会话继续显示消息批量选择入口；选择模式下可编辑消息可选，不可编辑、远程和收藏快照消息不可执行本地写操作。
* 编辑、单条删除、批量删除成功后，详情、列表摘要、收藏快照和派生历史目录之间保持一致；重新打开/刷新不能回显旧消息或已删除会话。
* 保留现有并发指纹、行定位、路径范围和目标工具运行保护，不以症状层 fallback 掩盖冲突。
* 新增回归测试覆盖 V2 派生目录陈旧、JSONL 文件被删除/修改后的读取，以及两类多选入口存在性和交互契约。

## Acceptance Criteria

- [ ] 会话列表可进入多选模式，选择/取消选择可见行与批量删除按钮可用，删除完成后选中状态清空。
- [ ] 本地 Claude/Codex 详情在默认视图和 Transcript 视图均可进入消息批量选择；选择后只允许删除可编辑消息。
- [ ] 编辑消息后关闭并重新打开会话，内容仍为新文本；单条/批量删除后重新打开，目标消息不再出现。
- [ ] 手动刷新历史索引或重启应用后，列表与详情不再使用编辑/删除前的 V2 目录数据；源文件不存在时不会返回幽灵会话。
- [ ] `npx tsc --noEmit`、相关 Node 历史测试、`cargo test history --lib`、`cargo fmt -- --check` 与 `cargo check` 通过。
- [ ] `CHANGELOG.md`（TEMP）与 `docs/功能清单.md` 更新对应历史会话板块，新增文案走中英文 i18n。

## Definition of Done

* Tests added/updated (unit and source regression where appropriate)
* Frontend and Rust quality gates green
* Product change records updated
* No unrelated dirty files included

## Out of Scope

* 不扩展 SSH 远程历史写操作，不改变 Kimi/Grok/OpenCode 的既有只读或专用删除能力。
* 不重做历史目录 schema，不引入新的依赖或持久化协议。

## Technical Notes

* 关键触点：`src/components/history/HistoryListPane.tsx`、`src/components/history/SessionDetailPane.tsx`、`src/components/HistoryWorkspace.tsx`、`src/stores/historyStore.ts`、`src-tauri/src/commands/history_edit.rs`、`src-tauri/src/commands/history.rs`、`src-tauri/src/commands/history/catalog.rs`。
* GitNexus：`update_message_in_file` 上游风险 MEDIUM（7 个直接调用/测试）；`delete_messages_in_file` LOW（4 个直接调用，10 个总影响）；UI 组件影响 LOW。以上风险在限定现有契约内修复。
* 规范：`.trellis/spec/backend/history-index-contracts.md`、`.trellis/spec/frontend/history-session-contracts.md` 要求派生目录可重建、编辑/删除标记 dirty、前端保留原始 message index 与批量选择行为。

## Open Questions

* 无；用户已确认继续修复并接受 TEMP 变更记录版本。

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
