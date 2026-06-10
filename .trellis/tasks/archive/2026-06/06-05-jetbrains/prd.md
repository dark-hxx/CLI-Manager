# JetBrains 风格灵活终端分屏

## Goal

把当前终端区域从“单个活动 tab + 浅层双分屏”升级为类似 JetBrains 家族 IDE 的灵活分屏能力，让用户可以同时观察多个 Claude Code / Codex 等 CLI 终端任务，同时保留现有 terminal tab 的视觉状态体系。

## What I already know

* 用户需要灵活分屏，类似 JetBrains IDE，而不是固定观察台、同步输入或一条命令同时发送。
* 用户需要同时看多个项目里正在运行的 Claude Code CLI / Codex CLI 终端任务。
* 现有 tab 展示方式可以保持，包括脉冲、红色、绿色等运行状态提示。
* 第一版暂不需要布局恢复。
* 现有实现已有浅分屏：`src/components/SplitTerminalView.tsx` 只支持一个 primary session 加一个 `secondSessionId`。
* 现有状态模型：`src/stores/terminalStore.ts` 使用 `splits: Record<string, SplitState>`，只能表达单层二分，不能表达嵌套 pane tree。
* 现有持久化：`src/stores/sessionStore.ts` 保存 `splits: PersistedSplit[]`，但本任务第一版不扩展布局恢复。
* 现有 tab 状态：`src/components/TerminalTabs.tsx` 中 `TAB_NOTIFICATION_COLORS`、`PULSING_TAB_STATES`、`SortableTab` 负责展示运行状态，应复用。
* 命令面板 `src/components/CommandPalette.tsx` 也提供水平/垂直分屏入口，需要同步更新语义。
* `src/components/XTermTerminal.tsx` 通过当前 `splits` 反查 primary session，用于 Codex 换行等逻辑；pane tree 后需要有新的“session 所属/关联”查询能力。

## Requirements

* 保留现有 terminal tab 的视觉状态体系：运行中脉冲、待处理/失败/完成颜色与文案不做大改。
* 支持类似 JetBrains 的分屏操作：
  * Split Right：把当前终端所在 pane 向右分出一个新 pane。
  * Split Down：把当前终端所在 pane 向下分出一个新 pane。
  * Unsplit：关闭/移除当前分屏 pane，默认把当前 pane 内 terminal tab 合并到相邻 pane，不关闭终端。
  * Move to Other Split：把 terminal tab 移动到另一个已有 pane。
* Split Right / Split Down 的新终端来源按入口区分：
  * 从 terminal tab 发起：使用小弹窗/Popover 项目选择器，允许用户选择一个项目创建终端，也允许创建空终端。
  * 从左侧项目树发起：把当前活动 tab 所在 pane 分屏，分屏出来的新 pane 直接启动左侧项目树中选中的项目终端。
* 在“终端设置”的“终端行为”区域增加 `Unsplit` 行为设置，让用户选择取消分屏时是“合并到相邻 pane”还是“关闭当前 pane 内终端”。
* 支持嵌套分屏：例如左侧一个终端，右侧上下两个终端。
* 支持拖动分隔线调整 pane 比例。
* 支持拖拽 terminal tab 到其它 pane 的 tab bar 或 pane 中心区域，实现跨 pane 移动，并保留同 pane 内 tab 排序能力。
* 支持拖拽 terminal tab 到 pane 的 left / right / top / bottom 边缘，直接把目标 pane 分屏并把现有 session 移入新 pane；仅移动已有 session，不新建 PTY、不复制 terminal。
* 兼容现有“终端标签切换”快捷键：优先在当前 active pane 内循环切换；若当前 pane 只有一个 tab，再跳到下一个 pane 的 active tab。不新增 pane 焦点切换快捷键。
* 第一版不做布局恢复：关闭/重启应用后不要求恢复 pane tree。
* 不引入新的状态管理库或复杂布局库，优先沿用 React + Zustand + 现有 DnD/菜单体系。

## Acceptance Criteria

* [x] 在任意活动终端上执行 Split Right 后，当前区域变成左右两个 pane，两个 pane 都能显示可交互终端。
* [x] 在任意活动终端上执行 Split Down 后，当前区域变成上下两个 pane，两个 pane 都能显示可交互终端。
* [x] 已分出的 pane 还能继续 Split Right / Split Down，形成嵌套布局。
* [x] 拖动 pane 分隔线可以调整相邻 pane 比例，并限制最小尺寸，避免终端被压到不可用。
* [x] Unsplit 默认把当前 pane 内 terminal tab 合并到相邻 pane，不关闭终端。
* [x] 终端设置页提供取消分屏行为设置：合并到相邻 pane / 关闭当前 pane 内终端。
* [x] 当设置为关闭当前 pane 内终端时，Unsplit 只关闭该 pane 的终端，不影响其它 pane。
* [x] Move to Other Split 能把一个 terminal tab 移到其它 pane，tab 状态展示保持一致。
* [x] 拖拽 terminal tab 到其它 pane 的 tab bar 或 pane 中心区域能完成跨 pane 移动；拖到同 pane tab bar 仍能排序。
* [x] 拖拽 terminal tab 到任一 pane 的 left / right / top / bottom 边缘时显示灰色半透明落点预览，松手后分屏目标 pane 并移动现有 session。
* [x] 同 pane 边缘分屏仅在原 pane 还有其它 tab 时生效；拖唯一 tab 到自己边缘不会制造空布局。
* [x] 拖拽移动后，空 pane 会按 Unsplit 默认策略归并或规范化，不能留下不可交互空区域。
* [x] tab 上的运行状态颜色、脉冲、tooltip 语义保持现有表现。
* [x] 命令面板中的分屏动作仍可用，语义更新为 Split Right / Split Down / Unsplit。
* [x] 不要求重启后恢复分屏布局。

## Definition of Done

* TypeScript 类型检查通过。
* 相关组件状态更新保持不可变，不直接 mutation React/Zustand state。
* 至少覆盖核心 reducer/helper 的单元测试，若项目现有测试结构不足，则补充可独立验证的纯函数测试。
* 手动验证：创建 3 个终端，左右/上下嵌套分屏，拖动比例，移动 tab，取消分屏，确认 tab 状态视觉不变。
* 不引入新依赖，除非后续明确批准。

## Research References

* [`research/cc-pane.md`](research/cc-pane.md) — 参考其外层 pane tree、每 pane 独立 tab bar、split/normalize/moveTab/store tests；不复制内部 terminal-in-tab split、布局恢复和 AI 会话元数据。

## Technical Approach

推荐把分屏状态从浅层 `Record<primarySessionId, SplitState>` 改为内存态 pane tree：

* `PaneLeaf`：持有该 pane 内的 terminal session ids、active session id。
* `PaneSplit`：持有方向、比例、first/second child。
* `terminalStore` 提供纯函数式操作：split leaf、unsplit leaf、move session between leaves、resize split。
* `TerminalTabs` 负责复用现有 `SortableTab` 的视觉结构；分屏后采用每个 pane 各自一条 tab bar，符合 JetBrains 式分屏模型，`Move to Other Split` 表示把 tab 从当前 pane 移动到另一个 pane。
* `SplitTerminalView` 改造为递归渲染 `PaneSplit` / `PaneLeaf`，分隔线组件复用现有 requestAnimationFrame 节流拖拽模式。
* 第一版不扩展 `sessionStore.saveSplits`；可以清理或忽略旧浅分屏持久化，避免为不需要的布局恢复付复杂度。

## Decision (ADR-lite)

**Context**: 现有浅分屏只能表达一个主终端和一个副终端，无法支持 JetBrains 式任意嵌套、移动 tab、多个 pane。

**Decision**: 使用 pane tree 表达当前运行时布局，保留现有 tab 状态视觉，不做布局恢复。

**Consequences**: 实现会触及 `terminalStore`、`TerminalTabs`、`SplitTerminalView`、`CommandPalette`、`XTermTerminal` 中与分屏相关的逻辑。短期内会移除/弱化旧 `PersistedSplit` 的价值，但符合“不做布局恢复”的范围收缩。

## Implementation Plan

1. **State model and helpers**
   * Add pane tree types and pure helper functions for split, unsplit, resize, active pane/session lookup, tab move, and tree normalization.
   * Keep runtime layout in `terminalStore`; do not persist pane tree for MVP.
   * Add focused tests for helper behavior.

2. **Pane rendering and existing tab reuse**
   * Replace shallow `SplitTerminalView` rendering with recursive pane rendering.
   * Extract/reuse existing tab visual/status logic so each pane has its own tab bar while preserving current colors, pulse, close/edit behavior, and tooltips.
   * Keep inactive terminal contents mounted where needed to avoid xterm session teardown.

3. **Split entry points**
   * Update tab context menu to use Split Right / Split Down with Popover project picker, including empty terminal option.
   * Add left project tree context actions Split Right / Split Down that split the current active pane and launch the selected project in the new pane.
   * Update Command Palette actions to target the active pane semantics.

4. **Unsplit, settings, and keyboard compatibility**
   * Add terminal setting for Unsplit behavior: merge to adjacent pane / close current pane terminals.
   * Update next/previous terminal tab shortcuts to prefer active pane, then fall through to next pane active tab.
   * Update `XTermTerminal` primary/project lookup so Codex newline and status handling work with pane tree.

5. **Drag and resize**
   * Support divider resize with min-size constraints and stable keys.
   * Support same-pane tab reorder, cross-pane tab drag into another pane tab bar/center, and edge-drop split by moving the existing session.
   * Exclude pane drag/reposition from MVP.

6. **Verification**
   * Run typecheck and targeted tests.
   * Manually verify split right/down, nested split, project-tree split, Popover split source, drag reorder, cross-pane move, unsplit strategies, and existing tab status visuals.

## Out of Scope

* 不做分屏布局持久化/恢复。
* 不做同步输入。
* 不做固定多项目观察台/卡片视图。
* 不改 tab 状态颜色、脉冲、tooltip 的基本视觉语义。
* 不新增第三方布局库。
* 不做跨窗口/外部 Windows Terminal 分屏。

## Open Questions

* 已确认：分屏后每个 pane 各自有 tab bar，不再使用顶部全局 tab bar 表达所有 pane。

## Technical Notes

* 已检查 `src/components/SplitTerminalView.tsx`：当前递归能力为 0，只渲染 primary + second。
* 已检查 `src/components/TerminalTabs.tsx`：全局 tab bar、右键菜单、拖拽排序、tab 状态展示集中在这里。
* 已检查 `src/stores/terminalStore.ts`：分屏生命周期、状态通知 primary 映射、restoreSessions 都依赖旧浅分屏结构。
* 已检查 `src/stores/sessionStore.ts`：当前会持久化 `PersistedSplit[]`，本任务不扩展该能力。
* 已检查 `src/components/CommandPalette.tsx`：分屏操作需要从水平/垂直中文语义收敛到 Split Right / Split Down。
* 已检查 `src/components/XTermTerminal.tsx`：需要替换对 `terminalState.splits` 的 secondSessionId 反查。
