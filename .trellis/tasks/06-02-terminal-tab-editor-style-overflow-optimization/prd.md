# Terminal Tab Editor-Style Overflow Optimization

## Goal

将终端 Tab 栏优化成更接近 VS Code、JetBrains、Chrome 等主流工具的单行编辑器式体验：Tab 过多时保持单行横向滚动，通过溢出入口快速定位，并在切换时自动确保当前 Tab 可见，避免换行或过度压缩导致布局混乱。

## What I already know

* 用户同意采用“单行可滚动 + 溢出菜单 + 自动滚动到当前 Tab”的方向。
* 当前 `src/components/TerminalTabs.tsx` 已有横向滚动容器、溢出下拉、`scrollIntoView` 自动可见、拖拽排序、右键菜单、关闭其它终端、新建终端、分屏相关操作。
* 当前 `src/hooks/useKeyboardShortcuts.ts` 已支持通过设置中的 `nextTab` / `prevTab` 快捷键顺序切换 Tab。
* 当前默认切换快捷键在 `src/stores/settingsStore.ts` 中是 `Alt+ArrowRight` / `Alt+ArrowLeft`。
* `gitnexus_impact` 对 `TerminalTabs` 的上游影响分析结果为 LOW：direct=0，processes_affected=0，modules_affected=0。

## Requirements

* MVP 选择“最小改动”。
* 保持终端 Tab 栏单行显示，不引入多行 Tab。
* Tab 过多时支持横向滚动，并提供明确的左右导航按钮。
* 切换到某个 Tab 后，当前 Tab 必须自动滚动到可见区域。
* 保留右侧“全部 Tab”溢出下拉，用于从列表中快速选择隐藏 Tab。
* Tab 标题保持固定可读宽度，超出使用省略号，不无限压缩。
* 关闭按钮降低视觉噪音：当前 Tab 常显，非当前 Tab hover/focus 时显示。
* 保留现有右键菜单、拖拽排序、通知状态、分屏、背景图隐藏/显示、新建终端、历史入口行为。
* 不新增依赖。

## Acceptance Criteria

* [ ] 打开多个终端直到 Tab 溢出时，Tab 栏仍保持单行，不换行、不挤压主内容区。
* [ ] 溢出时显示左右导航按钮，点击后 Tab 列表横向滚动。
* [ ] 通过点击、下拉选择、快捷键切换 Tab 时，当前 Tab 自动滚动到可见区域。
* [ ] 溢出下拉可以看到全部终端 Tab，并能切换到指定 Tab。
* [ ] 当前 Tab 的关闭按钮可见；非当前 Tab 不常驻打扰，但 hover/focus 时可关闭。
* [ ] 拖拽排序、右键菜单、关闭其它终端、新建终端、分屏入口不回退。
* [ ] `npx tsc --noEmit` 通过。

## Definition of Done

* Tests or checks: run TypeScript typecheck at minimum.
* Manual verification: run the app and manually verify Tab overflow, navigation buttons, overflow menu, shortcut switching, close button visibility, and drag/right-click behavior where possible.
* No dependency changes.
* No unrelated refactor.

## Technical Approach

在现有 `TerminalTabs` 组件上做局部增强：复用已有横向滚动容器、滚动状态、溢出 Popover 与 Tab 元素注册机制，只补充左右滚动按钮、滚动处理函数和关闭按钮可见性样式。样式集中在现有 `src/App.css` 的终端 Tab 相关规则中调整。

## Decision (ADR-lite)

**Context**: 终端 Tab 过多时需要更符合主流编辑器习惯的处理方式，同时避免复杂重构。

**Decision**: 采用单行横向滚动 + 左右导航按钮 + 全部 Tab 下拉 + 当前 Tab 自动可见的方案。

**Consequences**: 方案符合常见编辑器体验，实现范围局部且低风险；暂不实现多行 Tab、搜索式快速切换器或 MRU `Ctrl+Tab` 覆盖层，后续可单独扩展。

## Out of Scope

* 不实现多行 Tab。
* 不实现 Tab 搜索输入框。
* 不实现 MRU 顺序的 `Ctrl+Tab` 覆盖层。
* 不调整终端分组模型或会话持久化数据结构。
* 不修改快捷键设置页和默认快捷键。

## Verification Notes

* `npx tsc --noEmit` passed.
* `npm run build` passed.
* `git diff --check` passed.
* `gitnexus_detect_changes(scope=all)` reported changed symbols: `TerminalTabs`, `SortableTab`; risk level MEDIUM; affected processes are TerminalTabs-related flows.
* User chose not to start the local app, so manual UI runtime verification was not performed.

## Technical Notes

* Relevant files inspected:
  * `src/components/TerminalTabs.tsx`
  * `src/hooks/useKeyboardShortcuts.ts`
  * `src/stores/terminalStore.ts`
  * `src/stores/settingsStore.ts`
  * `src/App.css`
* Applicable Trellis specs read:
  * `.trellis/spec/frontend/index.md`
  * `.trellis/spec/frontend/quality-guidelines.md`
  * `.trellis/spec/guides/index.md`
  * `.trellis/spec/guides/code-reuse-thinking-guide.md`
* Code reuse note: existing `TerminalTabs` already contains most required primitives; implementation should extend them, not introduce a parallel Tab system.
