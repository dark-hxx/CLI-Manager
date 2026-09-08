# 历史来源接入规划/基础设施进度

说明：本任务的 `done` 只表示规划和第一阶段基础设施完成，不表示新来源 parser 已实现。真实解析由 `07-17-history-parsers-implementation` 跟踪。

- [x] P0：规划文档、索引库设计、备份恢复设计落地。
- [x] H1：历史来源 descriptor、设置页、检测候选、保存前校验。
- [x] H1：新建项目 CLI 工具注册表，内置 Claude/Codex/Gemini/OpenCode。
- [x] H1：历史读取目录从 Hook 设置解耦，改为历史来源设置优先、旧 Hook 设置兜底。
- [x] H2：在现有 `history-catalog.db` 内创建 v2 History Index DB schema，不切换旧读取链路。
- [x] H2：提供 v2 index schema/status 只读 IPC，用于后续 shadow build 自检。
- [x] H2：把 active history source settings 快照写入 `history_source_instances`。
- [x] H2：Claude/Codex adapter 输出统一 sessionRef/rawPointers 模型。
- [x] H2：shadow build 写入 v2 sessions/messages，并与旧链路对比。
- [x] H2：删除检测、parser/model version 失效、失败记录。
- [x] H3：登记 parser 分批 roadmap 和晋级门槛。
- [x] H3：Gemini、Kiro、OpenCode、Antigravity、Copilot、Grok、Pi、Cline、Cursor 真实 parser（已由 `07-17-history-parsers-implementation` 完成）。
- [x] H6：v2 read path 分片迁移（已由 `07-17-history-v2-read-path` 完成）。
- [ ] H4（部分完成）：备份恢复基础能力和部分 subagent 约束已落地；完整 mutation plan 尚未完成。
- [ ] H5（部分完成）：转换矩阵已落地；除 Claude/Codex 外的目标 writer 尚未实现。
