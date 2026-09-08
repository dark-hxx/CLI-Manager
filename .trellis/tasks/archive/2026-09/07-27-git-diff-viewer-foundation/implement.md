# Implementation Plan

1. 对 `GitDiffViewer`、`DiffViewerModal` 和四类消费者执行影响分析。
2. 先新增类型和 Controller，再迁移渲染组件，保持旧入口可用。
3. 迁移 GitChangesPanel、FileEditorPane、History DiffModal、TerminalStatsPanel。
4. 删除视图层的直接 `invoke` fallback；实时调用方必须显式注入 load。
5. 验证 loading/error/empty/解析失败/非 UTF-8 提示和回滚入口无变化。
6. 运行 `npx tsc --noEmit`、相关 Node 检查和 `git diff --check`。
