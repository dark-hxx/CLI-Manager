# 全来源历史解析实现

## Goal

让 Claude、Codex、Gemini、Kiro、OpenCode、Antigravity、Copilot、Grok Build、Pi、Cline、Cursor 全部通过统一 adapter 写入 v2 History Index，并由同一套列表、详情、搜索、统计 API 读取。

## Requirements

- 实施顺序和来源格式以 `docs/历史来源解析器分批接入计划.md` 为准。
- 新来源不得接入只支持 `file_path` 的 legacy detail 链路。
- adapter 最小接口仅包含 discover/fingerprint/parse；writer/mutation 继续由 capability 隔离。
- active source instance 是唯一扫描入口；相同 source session id 在不同 instance 中不得冲突。
- 每个来源必须有脱敏 golden fixture，禁止测试依赖开发机实时历史。
- 单来源失败不阻断其他来源，失败记录包含 source instance、session ref、fingerprint、parser version 和稳定错误码。
- capability 只能在该来源完整 vertical slice 测试通过后从 planned 晋级 supported。
- Kiro 当前版本按 workspace-sessions JSON 解析，不按 SQLite 解析。

## Acceptance Criteria

- [ ] v2 refresh 直接调用 source adapter，不再通过 legacy catalog 搬运新来源。
- [ ] v2 list/detail/search/stats 覆盖所有 supported 来源。
- [ ] Claude/Codex adapter 与现有结果完成 parity 回归。
- [ ] Gemini 完成 discover/parse/index/query/fixture。
- [ ] Kiro 完成 discover/parse/index/query/fixture，能显示 `F:\\idea-work\\business-center` 的历史会话。
- [ ] OpenCode 完成 SQLite schema 校验、只读一致性读取、index/query/fixture。
- [ ] Antigravity 完成格式确认、discover/parse/index/query/fixture。
- [ ] Copilot 完成 discover/parse/index/query/fixture。
- [ ] Grok Build 完成 discover/parse/index/query/fixture。
- [ ] Pi 完成 discover/parse/index/query/fixture。
- [ ] Cline 完成 discover/parse/index/query/fixture。
- [ ] Cursor 完成混合制品 discover/parse/index/query/fixture。
- [ ] 来源下拉筛选、详情、全文搜索、项目过滤、统计对全部 supported 来源生效。
- [ ] 损坏、空、未知 schema、来源离线和增量删除均有回归测试。

## Out of Scope

- 外部来源 edit/delete。
- 新来源 native writer 与 convertTo。
- 清理 legacy catalog 的物理 schema。
