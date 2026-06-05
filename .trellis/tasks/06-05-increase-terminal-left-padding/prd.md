# Increase Terminal Left Padding

## Goal

内嵌终端内容左侧目前贴近边框，需要增加一点左内边距，让提示符和输出更舒适，不改变终端行为。

## Requirements

- 只调整内嵌终端内容区域的左侧视觉间距。
- 不修改 PTY、会话、搜索、背景图或终端写入逻辑。
- 不新增依赖，不改全局主题体系。

## Acceptance Criteria

- [ ] 终端首列内容距离左边框增加少量间距。
- [ ] 终端仍占满可用高度和宽度，不出现明显布局溢出。
- [ ] 搜索浮层、背景图层和终端输出逻辑不受影响。

## Definition of Done

- TypeScript 静态检查可运行则通过。
- CLI-Manager 运行态终端视觉由人工验收。

## Technical Approach

在 `src/components/XTermTerminal.tsx` 的 xterm host 容器上增加小幅左 padding，保持改动局部化。

## Decision (ADR-lite)

**Context**: 问题是终端内容贴左边框，源头在 xterm 挂载容器视觉间距。
**Decision**: 调整 host 容器左 padding，而不是改 xterm 写入、fit 或 PTY 逻辑。
**Consequences**: 影响范围限于终端内容区域；终端列宽可能因可用内容宽度减少极少量，需要人工看一眼视觉效果。

## Out of Scope

- 不调整顶部标签栏、分屏拖拽、命令面板或历史视图。
- 不增加设置项让用户自定义 padding。
- 不改终端主题颜色或背景图配置。

## Technical Notes

- `src/components/XTermTerminal.tsx:873` 是 xterm 实际挂载容器。
- `src/App.css:1948` 附近是终端 chrome 样式，但本次不需要新增全局样式。
- GitNexus impact: `XTermTerminal` upstream risk LOW, direct callers 0, affected processes 0。
- 项目记忆要求：CLI-Manager 运行态/桌面 UI 不由 AI 启动服务验证，最终需人工验收视觉。