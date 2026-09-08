# 治理大 Git Diff 性能与边界

## Goal

避免大 Patch 在 WebView 主线程同步解析、全量语法高亮和完整 DOM 渲染时造成卡顿或内存峰值，并统一本地与 SSH 的大小边界。

## Changelog Target

`[TEMP]`

## Requirements

- Diff 内容超过 64 KiB 时在 Web Worker 解析；更小内容保留同步快速路径。
- 超过 256 KiB 或 5000 行时关闭语法高亮，但保留 insert/delete/Hunk 样式。
- Hunk 列表使用现有 `@tanstack/react-virtual` 按 Hunk 虚拟化，不新增依赖。
- Desktop 与 SSH Agent 统一拒绝超过 768 KiB 或 20000 行的 Diff。
- 超限返回稳定错误码和可翻译提示，不截断后继续允许回滚。
- payload 在 Transport 边界归一化 `byteLength` 和 `lineCount`，兼容旧 Agent 缺失字段。
- Worker 失败时回退无高亮解析；解析失败才进入 Monaco raw patch fallback。

## Acceptance Criteria

- [ ] 小 Diff 的渲染和交互无可感知回归。
- [ ] 64 KiB/256 KiB/5000 行/768 KiB/20000 行边界均有定向测试。
- [ ] 大 Diff 加载期间工具栏、关闭和取消操作保持响应。
- [ ] 只为可见 Hunk 生成高亮 token 和 DOM，滚动后高度不明显跳动。
- [ ] 切换文件会终止旧 Worker 结果，旧结果不会覆盖新 target。
- [ ] 本地与 SSH 使用相同错误语义，超限场景无部分回滚入口。

## Out of Scope

- 不实现无限大文件、服务端流式 Patch 或截断后回滚。
