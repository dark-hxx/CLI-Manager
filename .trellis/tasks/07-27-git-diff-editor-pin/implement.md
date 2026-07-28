# Implementation Plan

1. 对 gitStore context、GitChangesPanel、FileEditorPane 和 SSH Git context 做影响分析。
2. 实现依赖注入可测试的 lease registry，并用 fake transport 验证并发 acquire/refcount/idempotent release。
3. 迁移 GitChangesPanel 使用 lease，保持现有刷新和写操作行为。
4. 新增 gitDiffWorkspaceStore、标签 UI 和 GitDiffEditorHost。
5. 将 FileEditorPane 现有 Diff 逻辑移入 Host，消除直接本地 invoke。
6. 验证本地/WSL/SSH、嵌套仓库、关闭 Git 面板、切换项目和回滚刷新。
7. 运行 TypeScript、Node、Desktop/Agent 定向检查和 `git diff --check`。
