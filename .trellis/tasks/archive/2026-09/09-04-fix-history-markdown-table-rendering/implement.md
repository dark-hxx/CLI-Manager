# 实施计划：历史会话 Markdown 表格渲染与主题

## Phase 1：共享解包能力

- [x] 新增 `src/lib/markdownSource.ts`，抽取终端预览已有的顶层 `md`/`markdown` 围栏解包逻辑。
- [x] 修改 `HistoryMarkdownContent`：仅 history 变体调用共享工具。
- [x] 修改 `TerminalMarkdownPreview` 使用共享工具，保持终端现有输出。
- [x] 增加/调整针对解包边界和两个调用入口的脚本测试。

## Phase 2：主题跟随

- [x] 将基础 Markdown 代码块、标题栏的固定深色值替换为 `--md-*` 语义变量。
- [x] 确认默认语法高亮仍由应用解析主题决定，终端专属 CSS 覆盖和显式终端代码主题不变。
- [x] 运行 TypeScript 检查、相关 Node 测试和生产构建。

## Phase 3：文档与交付检查

- [x] 更新 `.trellis/spec/frontend/component-guidelines.md`，记录历史变体仅解包完整顶层 Markdown 源码围栏的契约。
- [x] 更新 `CHANGELOG.md` 的 `V1.3.9` 条目。
- [x] 更新 `docs/功能清单.md` 历史会话/Markdown 渲染对应板块。
- [x] 运行 `node .gitnexus/run.cjs detect_changes`（或等价 `detect_changes()`）确认影响范围符合预期；结果同时包含工作区中已有的布局相关改动，整体风险标为 critical，需与本任务变更分开解读。
- [ ] 检查工作区差异，保留用户已有 `AGENTS.md`、`CLAUDE.md` 与未跟踪任务目录变更；交付时列出自动化结果和人工验收项。
