# 实施计划

## 实施步骤

- [x] 对 `ConversationRowCard`、`HistoryMessageCard`、`SessionDetailPane` 执行 GitNexus 影响分析；索引不可用时按历史会话契约和当前源码降级记录。
- [x] 在 `SessionDetailPane.tsx` 提取同文件私有消息操作栏，并替换原文页的重复按钮标记。
- [x] 为 `ConversationRowCard` 注入原始消息、可编辑性和操作回调，在消息头部渲染共享操作栏。
- [x] 让编辑/插入启动函数返回是否通过既有编辑闸门；对话页仅在成功后切换到 `transcript`。
- [x] 更新 `CHANGELOG.md` 的 `V1.3.7` 及 `docs/功能清单.md` 中历史会话相关功能条目。

## 验证

- [x] `npx tsc --noEmit`。
- [ ] 检查对话页：本地可编辑 user/assistant 消息显示四个操作；不可编辑消息只显示复制。
- [ ] 检查编辑/插入：闸门获准后切换原文并打开同一消息表单；拒绝时停留在对话页。
- [ ] 检查删除、复制、搜索跳转、虚拟滚动与消息选择模式不回归（批量选择时对话页不显示单条操作栏）。
- [ ] 手动切换 `zh-CN` 与 `en-US`，确认现有 tooltip、aria-label 和 24 小时时间格式正常。
- [x] `git diff --check`、GitNexus `detect_changes()`，并核对未带入用户已有的 `AGENTS.md`、`CLAUDE.md` 与临时目录改动。

## 已完成的静态验证

- `npx tsc --noEmit` 通过；`npm run build` 通过。
- GitNexus 索引未覆盖本次新增符号，`detect_changes()` 仍报告风险 `low`、无受影响流程；影响分析与范围判断以当前源码和 `history-session-contracts.md` 为准。
- 未启动 Tauri 桌面应用；剩余未勾选项需要人工在本地、SSH、收藏快照及中英文界面中验证。

## 回退点

- 产品代码只触及 `SessionDetailPane.tsx`；回退该文件中的共享操作栏和对话接线即可。
- 文档记录只在功能验证完成后写入，不引入不可逆数据变更。
