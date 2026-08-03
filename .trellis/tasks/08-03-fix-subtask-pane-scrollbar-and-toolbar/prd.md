# 修复子任务分屏滚动条与工具栏操作

## Goal

修复子任务 transcript 分屏的原生滚动条悬浮放大效果，并让子任务分屏工具栏只保留关闭按钮。普通终端分屏的还原、全屏和关闭操作保持不变。

## Changelog Target

`[TEMP]`

## Requirements

- 子任务 transcript 使用覆盖式滚动条，默认保持窄样式，悬浮、聚焦或拖动时放大。
- 当前活动会话为 `subagent-transcript` 时，Pane 工具栏隐藏“还原独立 Tab”和“终端全屏”按钮，只保留关闭按钮。
- 当前活动会话为普通终端或其他现有会话类型时，维持原有工具栏行为。
- 不新增后端、PTY、IPC 或依赖；不复制工具栏按钮。
- 不新增用户可见文案。

## Acceptance Criteria

- [ ] 普通 xterm 终端的滚动条与工具栏行为不变。
- [ ] 子任务 transcript 滚动条悬浮时可见放大。
- [ ] 子任务活动时工具栏只显示关闭按钮。
- [ ] 同一 Pane 切换到普通终端 Tab 后，还原和全屏按钮恢复。
- [ ] 子任务关闭行为保持正常。
- [ ] `npx tsc --noEmit` 通过。
- [ ] `CHANGELOG.md` 与 `docs/功能清单.md` 更新。

## Definition of Done

- 完成代码修改并通过静态检查。
- 记录根因、受影响触点和人工验证场景。
- 不启动 Tauri 或 CLI-Manager 服务进行运行时验证。

## Out of Scope

- 不修改子任务生命周期、历史解析、PTY 或 IPC。
- 不改变普通终端分屏的按钮集合。
- 不将全局所有原生滚动条改为悬浮放大。

## Technical Approach

- 在 `PaneTabBar` 根据当前活动会话的 `kind` 判断是否为 `subagent-transcript`，在 JSX 层条件隐藏还原和全屏按钮，保留关闭按钮。
- 在 `SubagentTranscriptView` 中隐藏浏览器原生滚动条，生成覆盖式 track/thumb，同步内容滚动、容器尺寸和拖拽位置。
- 保持 xterm 专用滚动条选择器不变，避免影响普通终端。

## Root Cause

- 滚动条：现有悬浮放大 CSS 只匹配 xterm.js 自绘 DOM，子任务使用的原生 `overflow-auto` 由 WebView2 生成，无法稳定复用 `.xterm-slider` 的 hover 行为。
- 工具栏：子任务复用了面向普通 Pane 的通用 `PaneTabBar`，还原和全屏按钮没有按 `TerminalSession.kind` 做会话类型过滤。

## Discovery List

- [x] `src/components/TerminalTabs.tsx:PaneTabBar`：按钮渲染与活动会话列表；GitNexus upstream impact 返回 LOW、0 个直接调用者（索引存在陈旧提示，已用当前源码复核）。
- [x] `src/components/TerminalTabs.tsx:PaneLeafView`：确认子任务 transcript 复用通用 Pane 工具栏；未修改渲染分支。
- [x] `src/components/terminal/SubagentTranscriptView.tsx:SubagentTranscriptView`：确认原生滚动容器；GitNexus upstream impact 返回 LOW、0 个直接调用者（已用当前源码复核）。
- [x] `src/styles/components.css`：确认现有放大规则只针对 xterm DOM。
- [x] `src/stores/terminalStore.ts`：确认子任务会话使用 `kind: "subagent-transcript"`；生命周期与本次 UI 修复无关。
- [x] Rust/IPC/PTY：确认本次不涉及，属于前端渲染与样式边界问题。

## Scenario Matrix

- [ ] 普通终端单 Pane、普通终端多 Pane：按钮和滚动条保持原行为。
- [ ] 子任务单 Pane、多 Pane：只保留关闭按钮，滚动条悬浮放大。
- [ ] 同一 Pane 在子任务 Tab 与普通终端 Tab 间切换：按钮按当前活动会话切换。
- [ ] Workspan 开关、项目作用域筛选：不改变子任务关闭语义。
- [ ] 本地 PowerShell/CMD/Pwsh、WSL、Bash：子任务 UI 判定不依赖运行时 shell。
