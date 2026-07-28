# Large Diff Performance Design

## Pipeline

```text
load payload
  -> normalize byte/line metadata
  -> <=64 KiB: parse on main thread
  -> >64 KiB: parse in gitDiffParser.worker
  -> <=256 KiB and <=5000 lines: tokenize visible hunks
  -> otherwise: render visible hunks without syntax tokens
  -> virtualize hunk containers
```

Worker 输出可 structured-clone 的纯数据，不输出 DOM、React 节点或 Transport 对象。每次请求带 generation；Controller 只接受当前 target/options/generation 的结果。

## Limits

前端阈值集中到 `gitDiffLimits.ts`，Rust Desktop 和 Agent 各自定义同名常量并用契约测试锁定数值。超限在后端读取/格式化后、返回 WebView 前拒绝，错误码分别归一化为 `git_diff_too_large`。

## Virtualization

每个 Hunk 独立渲染为固定列宽的 Diff block，Virtualizer 使用测量元素处理动态高度。导航到未挂载 Hunk 时先 scrollToIndex，挂载后再聚焦 anchor。
