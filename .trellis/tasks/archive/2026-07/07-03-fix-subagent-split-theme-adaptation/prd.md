# fix subagent split theme adaptation

## Goal

修复 Claude/Codex 子任务在自动分屏后，转录面板配色没有跟随当前终端主题的问题，使子任务输出内容在浅色/深色终端主题下都保持可读且风格一致。

## Changelog Target

V1.2.5

## What I already know

* 问题出现在自动分屏打开的子任务转录面板，不是 PTY 主终端本身。
* [`src/components/terminal/SubagentTranscriptView.tsx`](../../../src/components/terminal/SubagentTranscriptView.tsx) 使用 `TERM` 变量渲染外层容器，但内部角色卡片与空状态文案依然依赖硬编码暗色值或暗色语义。
* [`src/styles/components.css`](../../../src/styles/components.css) 中 `.subagent-transcript-shell`、`.subagent-transcript-message`、`.ui-markdown-terminal` 大量使用固定暗色背景/边框/文字色。
* 终端区域实际上已经在 [`src/components/TerminalTabs.tsx`](../../../src/components/TerminalTabs.tsx) 和 [`src/App.tsx`](../../../src/App.tsx) 注入了 `--terminal-theme-*` 与 `--term-panel-*` CSS 变量。
* [`src/components/ui/MarkdownContent.tsx`](../../../src/components/ui/MarkdownContent.tsx) 对 `variant="terminal"` 固定使用 `oneDark` 代码高亮主题，因此浅色终端下代码块仍会偏暗。
* `variant="terminal"` 目前不仅用于子任务转录，也用于文件编辑器 Markdown 预览，因此共享组件改动需要谨慎。
* GitNexus 影响分析结果：
* `SubagentTranscriptView`：LOW，1 个直接调用方，来自 `PaneLeafView`。
* `MarkdownContent`：CRITICAL，5 个直接调用方，影响 History / Settings / Files / Prompts / Terminal 等 4 条流程。

## Assumptions (temporary)

* 用户要的是“跟随当前终端主题”，不是单独增加新的子任务面板主题设置。
* 本次以最小修复为主，不调整自动分屏逻辑、不改 Hook 协议、不新增设置项。
* 允许顺带修正 `variant="terminal"` 下代码块高亮与终端浅/深主题不一致的问题，但普通 `variant="default"` Markdown 行为必须保持不变。

## Open Questions

* 无

## Requirements (evolving)

* 子任务自动分屏打开的 transcript 面板应使用当前终端主题衍生出的前景色、背景色、边框色与强调色。
* 子任务 transcript 中 user / assistant / tool 三类消息卡片应在浅色和深色终端下都保持可区分。
* 本次修复范围仅限子任务 transcript 专用链路；共享 `MarkdownContent` 默认行为不得改变。
* 子任务 transcript 内部的 Markdown 文本、引用、表格、内联代码、代码块、链接颜色应跟随当前终端主题，而不是固定暗色方案。
* 普通页面和其他 `variant="terminal"` 使用点的默认表现必须保持不变。

## Acceptance Criteria (evolving)

* [ ] 浅色终端主题下，子任务 transcript 面板不再出现“深色背景 + 偏暗文本/边框”的失配。
* [ ] 深色终端主题下，现有 transcript 可读性不退化。
* [ ] 子任务 transcript 中的代码块在浅色终端下不再固定使用暗色高亮主题。
* [ ] 其他 Markdown 使用点默认视觉不变。

## Definition of Done (team quality bar)

* 相关前端代码已更新
* 类型检查通过
* 行为变更已写入 CHANGELOG
* 若属于产品功能表现修复，同步更新 docs/功能清单.md

## Out of Scope (explicit)

* 不新增独立“子任务面板主题”设置
* 不改 PTY/xterm 实际配色算法
* 不改子任务发现、订阅、自动分屏布局逻辑
* 不顺带调整 FileEditor / Prompt / History / Settings 的 Markdown 主题行为

## Technical Notes

* 关键文件：
* [`src/components/terminal/SubagentTranscriptView.tsx`](../../../src/components/terminal/SubagentTranscriptView.tsx)
* [`src/components/ui/MarkdownContent.tsx`](../../../src/components/ui/MarkdownContent.tsx)
* [`src/styles/components.css`](../../../src/styles/components.css)
* [`src/lib/terminalThemes.ts`](../../../src/lib/terminalThemes.ts)
* 终端主题亮暗判断已有现成工具：`isLightTerminalTheme(theme)`。
* 当前分支 `master` 跟踪 `origin/master`，`git branch -vv` 显示本地 `ahead 2`，未见远端领先；工作区当前脏文件仅为本任务目录。

## Technical Approach

* 在 [`src/components/terminal/SubagentTranscriptView.tsx`](../../../src/components/terminal/SubagentTranscriptView.tsx) 内直接复用现有 settings + terminal theme 解析逻辑，只计算当前终端主题的亮/暗模式，不改转录解析逻辑。
* 在 [`src/components/ui/MarkdownContent.tsx`](../../../src/components/ui/MarkdownContent.tsx) 增加一个向后兼容的可选参数，仅当子任务 transcript 显式传入时才切换代码高亮明暗主题；其余调用点默认行为保持不变。
* 在 [`src/styles/components.css`](../../../src/styles/components.css) 把主题修复限制在 `.subagent-transcript-shell` 作用域和其派生类内，避免放大全局 `.ui-markdown-terminal` 的样式波及面。

## Decision (ADR-lite)

**Context**: `SubagentTranscriptView` 的 blast radius 很小，但 `MarkdownContent` 的 GitNexus 影响分析是 `CRITICAL`，因为它被历史、设置、文件预览、Prompt、终端多处复用。

**Decision**: 不直接修改 `MarkdownContent` 的共享默认行为；改为增加一个可选、默认关闭的终端代码高亮模式，并且只在 `SubagentTranscriptView` 这条链路启用。CSS 也优先做子任务 transcript 局部作用域修复。

**Consequences**: 共享行为不漂移，改动面进一步收窄到 transcript 组件、其局部样式和一个向后兼容的共享参数，真实 blast radius 更小，回归风险更低。
