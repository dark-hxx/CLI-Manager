# 实现设计

## 数据流

本地历史解析器 → `RequestLogDocument` → 现有 `request_logs` 增量同步 → 新请求级统计聚合 IPC → StatsPanel；记录页继续查询同一张表。

## 后端

- 在现有 request-log 同步模块中扩展来源白名单和目录/数据库扫描。
- Gemini 为每个带 usage 的消息构造事件；Grok 为每个 `turn_completed`/模型 usage 构造事件；复用 Claude、Codex、OpenCode 已有事件。
- OpenCode 使用现有 session locator 作为稳定文件引用，不改变数据库路径策略。
- 新增 `history_get_request_log_stats`，复用现有定价和筛选规则，返回四类 Token、real total、cache hit rate、成本/未定价、趋势和来源/模型分布。
- 不改变 `history_get_stats` 的既有会话统计契约。

## 前端

- 增加请求级统计类型、查询和归一化逻辑。
- StatsPanel 并行读取旧会话统计和新请求统计：新增 CC Switch 风格概览/趋势/来源/模型视图，保留现有项目和热力图区域。
- RequestLogsView 将来源筛选扩展到五类，接入统一日期/项目/模型范围。
- 所有新增文案写入 `src/lib/i18n.ts` 的中英文资源。

## 风险控制

- 复用现有表结构，避免迁移风险。
- 新 API 与旧统计 API 并存，降低远程/历史视图回归风险。
- 请求级统计仅依赖五类已确认来源；其它来源仍由旧会话统计展示。
