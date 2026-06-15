# fix term stats relative time freeze

## 问题

终端右侧「实时统计」面板头部的相对时间（`刚刚 / N 分钟前`）在终端空闲时一直停留在「刚刚」，不随时间走字。

## 根因

`src/components/terminal/TerminalStatsPanel.tsx`：

- 头部显示 `formatRelativeTime(updatedAt)`，该文案随时间推移应从「刚刚」变为「N 分钟前」，但只在组件重渲染时才用 `Date.now()` 重新计算。
- 数据轮询（10s）只有在会话数据真的变化（`result !== "unchanged"`）时才 `setUpdatedAt(Date.now())` 触发重渲染。
- 终端空闲时轮询返回 `unchanged`，组件不重渲染，相对时间文案冻结在上次渲染值（「刚刚」），直到切 Tab 等其它 state 变化才突变。

## 方案

在 `TerminalStatsPanel` 增加一个轻量 tick：当面板 `open` 且 `updatedAt` 存在时，每 30s 触发一次重渲染，仅用于驱动 `formatRelativeTime` 重新计算，不改任何数据/轮询逻辑。

## 验收

- [ ] 终端空闲、统计数据不变时，头部相对时间能随时间从「刚刚」走字到「1 分钟前 / 5 分钟前」。
- [ ] 终端活跃、数据持续变化时，仍显示「刚刚」（本就正确）。
- [ ] 面板关闭后定时器被清理，无泄漏。
- [ ] `npx tsc --noEmit` 通过。

## 非目标

- 不改轮询间隔、不改数据获取/解析逻辑。
