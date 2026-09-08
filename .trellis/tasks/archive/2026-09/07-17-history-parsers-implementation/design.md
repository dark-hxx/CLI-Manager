# 实现设计

## 主链路

```text
history_source_instances
  -> adapter registry
  -> discover + fingerprint
  -> parse NormalizedSession
  -> history_sessions/history_messages/history_tool_events
  -> list/detail/search/stats
```

## KISS 边界

- 一个 adapter trait，一个 registry；不为每个来源创建额外 service/factory 层。
- 文件来源直接用 `serde_json`/逐行读取；数据库来源复用 `sqlx` 只读连接。
- parser 输出统一模型，查询层不判断来源格式。
- raw pointer 保留原始定位，详情常规展示不回源读取。

## 交付顺序

1. adapter core + Claude/Codex parity + v2 read path。
2. Gemini + Kiro JSON parser。
3. OpenCode SQLite + Antigravity。
4. Copilot + Grok Build + Pi + Cline。
5. Cursor mixed storage。
6. 全来源回归、capability 晋级、旧链路退场评估。

每一步都必须能独立构建和测试，不允许等全部 parser 写完后一次性切换。
