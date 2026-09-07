# 技术设计：历史会话 Markdown 表格渲染与主题

## 数据流与边界

历史详情沿用现有渲染链路：

`SessionDetailPane` → `SessionTranscriptContent` → `HistoryMarkdownContent` → `MarkdownContent` → `react-markdown + remark-gfm`

`SessionTranscriptContent` 继续负责 transcript 特殊块分段；本任务只在 `HistoryMarkdownContent` 将普通 Markdown 段落交给共享渲染器前做一次“完整源码围栏”适配。后端、IPC 和消息原文不变。

## 代码方案

1. 新增 `src/lib/markdownSource.ts`，导出 `unwrapFencedMarkdown(content)`。
   - 先统一换行，再用锚定正则匹配整段内容。
   - 开头和结尾必须是同种、同长度（至少三字符）的反引号或波浪号围栏，语言必须为 `md` 或 `markdown`。
   - 匹配成功返回围栏内部内容；否则返回原始内容。
2. `HistoryMarkdownContent` 在 `variant === "history"` 时调用该工具，再将结果传给 `MarkdownContent`；`variant === "terminal"` 保持当前行为并继续使用终端主题参数。
3. `TerminalMarkdownPreview` 改为使用同一工具，删除本地重复正则和函数，保持现有选中消息的解包行为。
4. 修改 `src/styles/components.css` 的基础 `.ui-markdown-code-block` 与 `.ui-markdown-code-header`：使用已有 `--md-canvas-subtle`、`--md-canvas-muted`、`--md-border`、`--md-subtle` 等语义变量。保留更具体的 `.ui-markdown-terminal ...` 覆盖，确保终端专属色板不被改变。

## 兼容性与安全

- GFM 表格解析仍由现有 `remark-gfm` 完成，不新增第二套 Markdown parser。
- `skipHtml`、链接处理、数学公式、查询高亮和特殊 transcript 块保持原入口。
- 解包只接受整段顶层源码围栏，避免把普通代码样例或消息中的局部围栏误解析为 Markdown。
- 该工具是无状态纯函数，无持久化、并发或运行环境分支。

## 验证策略

- 单元/脚本：覆盖反引号、波浪号、CRLF、最小围栏、错误语言、未闭合、围栏前后文本和不同长度嵌套围栏。
- 静态回归：确认历史入口和终端入口都引用共享工具，基础 Markdown 样式不含固定深色容器色，终端专属覆盖仍存在。
- 工程验证：`npx tsc --noEmit`、相关 `node --test`、`npm run build`。
- 人工验收：历史会话在浅色/深色/跟随系统主题下查看截图同类表格；检查普通代码、嵌套代码、特殊 transcript 块、历史切换和终端预览。

## 风险与回滚

- 风险：共享 CSS 变量变更会触及多个 Markdown 消费方。缓解：只替换基础容器的固定色，保留语法高亮和终端覆盖，并运行全量前端检查。
- 风险：历史分段后可能形成多个 Markdown 段落。缓解：每个普通 Markdown 段独立调用严格的整段匹配，非匹配内容完全保留。
- 回滚点：若主题回归，可单独回退基础 CSS 变量提交；若解析回归，可回退 `HistoryMarkdownContent` 的 history 变体接入，终端共享工具仍可独立保留。
