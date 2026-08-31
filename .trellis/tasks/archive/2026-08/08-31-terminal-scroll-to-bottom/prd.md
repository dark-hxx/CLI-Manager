# 终端滚动条底部快捷跳转按钮

## Goal

在终端内容已经超出可视区域、用户向上滚动查看历史内容时，在当前终端 Tab 右下角提供一个“跳转到底部”按钮，帮助用户快速回到最新输出位置。

## Background

- 用户需求：当终端出现滚动条且当前滚动位置不在最下方时，显示跳转到底部按钮。
- 本任务是新增前端交互功能，版本记录目标为 `V1.3.9`。
- 需要保持现有终端、分屏、Tab 切换和中英文国际化行为不受影响。

## Confirmed Repository Facts

- 每个普通终端会话由 `src/components/XTermTerminal.tsx` 创建并持有独立的 xterm 实例；终端外层 wrapper 已是 `relative` 定位容器。
- `XTermTerminal` 当前已注册 `terminal.onScroll` 用于 TUI 颜色同步（约 `src/components/XTermTerminal.tsx:1832-1838`），但尚未把滚动位置映射为 React UI 状态。
- xterm 公共 Buffer API 提供 `buffer.active.viewportY` 与 `buffer.active.baseY`；现有终端缩放契约以 `buffer.type === "normal" && viewportY === baseY` 判定实时底部，`viewportY < baseY` 判定正在查看历史。
- `TerminalTabs` 的 `PaneLeafView` 为每个会话渲染 `XTermTerminal`，非当前会话通过 `display: none` 隐藏但保持挂载（约 `src/components/TerminalTabs.tsx:1893-1989`），因此滚动状态应归属于终端实例，而不是全局 store 或 Tab 栏共享状态。
- 终端右下角已有临时显示的 `FontSizeControl`（约 `src/components/XTermTerminal.tsx:2153-2168`）；新增按钮需要与其形成稳定的垂直控制组，不能互相遮挡。
- 中英文翻译集中在 `src/lib/i18n.ts` 的 `zh` 与 `en` 字典中，`TranslationKey` 由中文字典键推导；新增按钮的可见文案、tooltip 和 aria 标签必须同时补齐两套字典。
- 项目没有 React Testing Library/Vitest/Jest 测试基础设施，终端相关行为主要采用 `scripts/*.test.mjs` 的纯逻辑测试，加上 `npx tsc --noEmit` 与人工桌面检查。

## Confirmed UI Decision

- 使用 28×28 的圆形 `ArrowDown` 图标按钮，不显示常驻文字。
- 按钮使用 `terminal.scrollToBottom` 翻译键作为 tooltip 与 aria-label，补齐 `zh-CN` 和 `en-US`。
- 按钮与现有字号控件组成终端右下角垂直控制组；仅显示跳转按钮时仍保持原有右下角位置，同时显示时按钮位于字号控件上方。

## Scenario Matrix

| 维度 | 覆盖场景 | 预期 |
| --- | --- | --- |
| Window focus | 当前窗口聚焦 / 另一个窗口聚焦 / 应用未聚焦 | 按钮状态只绑定对应终端实例；失焦不改变状态，另一个窗口不共享状态。 |
| Split pane | 当前 Pane / 同窗口另一个 Pane / 深层 split 节点 | 每个 Pane 的按钮只反映自己的 XTerm，不串状态、不影响其他 Pane。 |
| Minimized / tray | 正常窗口 / 最小化 / 最小化到托盘 | 正常恢复后状态与对应 buffer 一致；不因最小化或托盘清空滚动状态。 |
| UI presentation | 展开侧边栏 / 折叠侧边栏 / compact 嵌入视图 | 按钮跟随终端内容容器定位，不依赖侧边栏宽度或固定窗口坐标。 |
| Multi-session / Workspan | 单会话 / 多会话 / 切换 Workspan | 非底部状态按会话独立保存；切换后显示当前会话自己的状态。 |
| Focus mode | 开启 / 关闭 | 不改变按钮的显示判定或点击行为。 |
| Runtime environment | 本地 PowerShell/CMD/Pwsh / WSL / Bash | 判定仅依据 xterm buffer，环境差异不改变按钮行为。 |
| Worktree | 主仓库 / Worktree 子目录 / 目录已不存在 / `.git` 为文件的链接 Worktree | 与路径类型无关，确认不触及 Worktree 解析逻辑。 |
| CLI Hook | Claude/Codex Hook 已安装 / 未安装 / 仅安装一种 | 与 Hook 安装状态无关，确认不触及 Hook 绑定逻辑。 |
| Terminal buffer | normal buffer 有 scrollback / normal buffer 已在底部 / alternate buffer | 仅 normal buffer 存在非底部 scrollback 时显示；底部与 alternate buffer 不显示。 |
| Buffer change | 滚轮、拖拽滚动条、键盘滚动、持续输出、resize/reflow、清屏/恢复快照 | 状态及时重算；点击后回到底部并隐藏，既有输出、resize、恢复与自动跟随契约保持不变。 |

## Discovery List

- [x] `src/components/XTermTerminal.tsx`：确认新增滚动位置状态、xterm buffer 事件同步、底部跳转处理及右下角控制布局。
- [x] `src/components/TerminalTabs.tsx`：确认每个 Pane/会话独立挂载与可见性行为；无需新增 props 或共享状态。
- [x] `src/hooks/useTerminalDisplay.ts`：确认输出、resize、replay 通过 XTerm 公开事件消费；不改 PTY/ACK/调度契约。
- [x] `src/lib/i18n.ts`：确认新增 zh-CN/en-US 翻译键；zh-TW 由现有转换机制覆盖。
- [x] `src/components/icons.ts`：确认可复用现有 `ArrowDown` 图标，无需新增图标导出。
- [x] `src/styles/components.css`：确认现有 xterm viewport 滚动条样式；复用 terminal control 风格，不修改滚动条本身。
- [x] `scripts/*.test.mjs`：确认无组件渲染测试基础设施，本任务以类型检查、构建、既有终端逻辑测试和人工桌面检查为主。
- [x] GitNexus：当前仓库索引已刷新；概念 query 因 FTS 扩展不可用而降级，已通过文件级图查询和源码检查确认上述触点。

## Requirements

- 仅当终端内容可滚动且当前滚动位置不在底部时显示按钮。
- 按钮位于对应终端 Tab 的右下角，不遮挡 Tab 标题及主要终端交互区域。
- 点击按钮后，当前终端滚动到最新内容的底部，并隐藏按钮。
- 用户通过滚轮、滚动条、键盘或程序输出改变滚动位置时，按钮显示状态应及时同步。
- 按钮文案、悬浮提示和无障碍标签同时支持 `zh-CN` 与 `en-US`，不得硬编码用户可见文案。
- 不改变现有终端自动跟随底部、分屏布局和多会话独立滚动状态。

## Acceptance Criteria

- [ ] 终端内容不足一屏或当前已在底部时不显示按钮。
- [ ] 终端内容超出一屏且用户位于非底部位置时，在对应 Tab 右下角显示按钮。
- [ ] 点击按钮后滚动位置到达底部，按钮消失，后续新输出继续遵循现有滚动行为。
- [ ] 在终端 Tab 切换、分屏、窗口尺寸变化和多会话同时存在时，按钮状态与对应终端实例一致。
- [ ] 中英文界面下按钮的可见文案、提示和 aria 标签均正确，英文时间/界面格式不受影响。
- [ ] 前端类型检查及相关测试/构建验证通过。

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- This task is treated as complex because it adds stateful behavior spanning terminal rendering and Tab layout.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
