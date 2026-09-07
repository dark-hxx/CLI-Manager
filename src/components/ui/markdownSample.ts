export const MARKDOWN_STYLE_SAMPLE = `# Markdown H1 一级标题

这是一段普通段落，用来检查正文行高、段落间距、**加粗文本**、*斜体文本*、~~删除线~~、\`inline code\`、自动链接 https://example.com 和脚注引用[^note]。

## Markdown H2 二级标题

> 引用块用于展示重要上下文。
>
> 第二段引用需要保持间距清楚，并且不会压扁内部段落。

### Markdown H3 三级标题

- 无序列表第一项
- 无序列表第二项，包含嵌套：
  - 二级圆点
    - 三级方块
- 无序列表第三项，包含一段较长文本，用来检查换行后的缩进是否仍然对齐。

#### Markdown H4 四级标题

1. 有序列表第一项
2. 有序列表第二项
   1. 二级有序列表
   2. 二级有序列表第二项
      1. 三级有序列表
3. 有序列表第三项

##### Markdown H5 五级标题

- [x] 已完成任务
- [ ] 未完成任务
- [x] 带有 \`inline code\` 的任务项

###### Markdown H6 六级标题

| 项目 | 状态 | 对齐 | 说明 |
| --- | :--- | ---: | :---: |
| 历史记录 | Ready | 128 | 居中列 |
| Prompt 库 | Active | 64 | 表格隔行底色 |
| 子 Agent 转录 | Running | 32 | 超长内容需要横向滚动：abcdefghijklmnopqrstuvwxyz-0123456789-abcdefghijklmnopqrstuvwxyz |

## 数学公式

行内公式支持：$E = mc^2$、$a^2 + b^2 = c^2$。

块级公式支持：

$$
\\int_{0}^{\\infty} e^{-x^2} \\, dx = \\frac{\\sqrt{\\pi}}{2}
$$

---

\`\`\`tsx
function MarkdownPreview() {
  const rows = ["heading", "table", "list", "code"];
  return rows.map((item) => <span key={item}>{item}</span>);
}
\`\`\`

\`\`\`json
{
  "wide": "abcdefghijklmnopqrstuvwxyz-0123456789-abcdefghijklmnopqrstuvwxyz-0123456789",
  "enabled": true
}
\`\`\`

![远程图片不会被直接加载](https://example.com/preview.png "图片安全占位")

[^note]: 脚注区域用于检查上标、分隔线、返回链接和列表布局。`;
