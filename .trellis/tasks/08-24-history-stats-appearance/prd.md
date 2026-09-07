# History 与 Stats 项目树外观对齐

父任务：`08-24-sidebar-node-appearance`。技术契约见父任务 `design.md` §2、§3。
依赖：`08-24-appearance-data-layer`。可与 `08-24-webdav-appearance-sync` 并行。

## Goal

消除"只有侧边栏有外观标记"的三处观感漂移：History 与 Stats 面板各自重建的项目树，接入同一份 `resolveNodeAppearance`。

## Requirements

- R-H1 `src/components/history/HistoryListPane.tsx` 的 `renderProjectNode`（`:666` 起）分组行（`:680` 的 `Folder`）与项目行（`:230-231` 的图标解析）接入 `resolveNodeAppearance`。
- R-H2 `src/components/stats/StatsPanel.tsx` 的项目树渲染（`:1298`、`:1323`、`:1343-1347`、`:1383` 附近的 `Folder` / leading-icon）同样接入。
- R-H3 两处**禁止**自行实现 hash 或颜色映射，只能调用 `src/lib/nodeAppearance.ts`；出现第二份实现即视为验收不通过。
- R-H4 着色范围与侧边栏一致：仅 leading icon + 选中态色条，不铺整行；两个面板既有的选中/悬停样式语义不被破坏。
- R-H5 两个面板的行高、间距、图标尺寸（当前多为 13px）保持不变，本任务不做布局调整。

## 非目标

- 不改两个面板的树构建逻辑（`buildHistoryProjectTree` / `buildStatsProjectTree`）与筛选逻辑。
- 不给这两处新增外观编辑入口（编辑只在侧边栏与项目编辑弹框，属子任务 ③）。

## Acceptance Criteria

- [ ] 同一分组/项目在侧边栏、History、Stats 三处颜色与图标完全一致
- [ ] 自定义 emoji 在三处均正确显示，尺寸不撑破行高
- [ ] 未自定义的节点在三处均显示同一自动色
- [ ] 全仓搜索确认只有一处 hash / 调色板实现
- [ ] `npx tsc --noEmit` 通过
- [ ] `CHANGELOG.md` 与 `docs/功能清单.md` 已更新
