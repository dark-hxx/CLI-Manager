# 项目栏节点外观标记与布局优化 (issue #213)

父任务：持有需求集、子任务地图、跨子验收与最终集成评审。本任务自身不承担直接实现。

## 需求来源

- GitHub issue #213 `[Feature]: 左侧项目栏布局优化`（ushaio，2026-08-17）：左侧栏"不易视觉区分"，建议文件夹图标支持自定义 icon / emoji / 颜色标记。
- 用户确认（2026-08-24）：
  1. 外观字段需要进 WebDAV 同步；
  2. 侧边栏 / History / Stats 三处项目树都要改；
  3. 复用 leading-icon 样式的其他位置同步修复；
  4. 新建文件夹**不弹框**：保持内联输入，创建即自动配色，内联行图标做成外观快选按钮。

## 现状证据

- 分组行恒定渲染 `<Folder size={16}>`（`src/components/sidebar/TreeNodeItem.tsx:457`），颜色统一来自 `.ui-tree-leading-icon { color: var(--accent) }`（`src/styles/components.css:1481`）→ 所有分组同质。
- `Project` / `Group`（`src/lib/types.ts`）无任何外观字段；当前最大 migration version = 32（`src-tauri/src/lib.rs:682`）。
- 按 CLI 工具的徽章配色 CSS 已存在（`src/styles/components.css:1549-1559`），但全仓 `.tsx` 中 `data-cli-tool` 出现 0 次 → 现成能力是死代码，所有终端数徽章圆点同色。
- 分组行无项目计数，折叠后信息全丢。
- History / Stats 各自重建项目树（`src/components/history/HistoryListPane.tsx:187`、`src/components/stats/StatsPanel.tsx:1218`），若只改侧边栏会出现三处观感漂移。
- 同步导出/恢复均为显式列（`src/stores/syncStore.ts:132-133`、`:393`），新增列不改这里不会被同步。

## Requirements

- R1 默认统一色（**2026-08-25 用户决定，取代原"零配置自动配色"**）：未设置颜色时不做任何自动配色，节点跟随统一的系统色；只有用户手动设置才改变。
- R2 自定义外观：分组与项目均可设置颜色标记与图标（内置图标 key 或单个 emoji 字符），可重置回默认。
- R3 创建交互：新建分组保持"输名字 → 回车"一步完成；内联行图标为可点快选（不点则用默认色）。
- R4 三处一致：侧边栏、History、Stats 共用同一份外观解析逻辑。
- R5 同步：外观字段进 WebDAV 备份与恢复，旧版快照缺字段不报错。
- R6 先行修复：补齐 `data-cli-tool` 属性激活既有配色；分组行增加折叠态项目计数。
- R7 主题安全：亮/暗主题下颜色对比度可用，不整行铺色（避免与 `data-status` 运行态背景冲突）。
- R8 色条克制（**2026-08-25 用户决定**）：项目行仅在设置了显式颜色后显示左侧细色条；分组行不显示色条，显式颜色直接作用于文件夹图标。

## Acceptance Criteria（跨子任务）

- [x] 未设置外观时界面不出现任何多余色条，节点使用统一系统色（R1/R8）
- [x] 同一节点的自定义 icon/color 在侧边栏、History、Stats 三处表现一致（R4）
- [x] 新建分组仍可一步完成，未点快选时落默认色（R3）
- [ ] WebDAV 备份 → 恢复往返后外观字段不丢；用旧版快照恢复不报错且退回系统色（R5）——代码与 Rust 测试已覆盖，真实远端往返待人工验证
- [ ] 折叠侧边栏、`.ui-split-project-picker`、`.ui-project-tree-root` 三处样式复用位置外观正常（用户确认项 3）——待人工验证
- [x] `npx tsc --noEmit` 与 `cd src-tauri && cargo check` 通过
- [x] `CHANGELOG.md`（追加到既有 `## [V1.3.8]` 段，不新建版本段、不改 app version 源）与 `docs/功能清单.md` 已更新

## 约束

- migration 只增不改，新增 version 33，不修改历史 migration。
- 不引入新依赖：emoji 走文本输入，不装 emoji picker（仓库无现成实现）。
- 不新增全局状态方案，外观读写走 `projectStore`。
- 数据库并发与执行顺序按 `design.md` §8 执行：迁移只追加、恢复语句顺序与后端 SQL 白名单锁步、外观随 INSERT 一次落库不做两步写。

## 子任务地图与建议顺序

| 顺序 | 子任务 | 依赖 |
|---|---|---|
| ① | `08-24-sidebar-visibility-p0` 先行可见性修复 | 无，可独立先发 |
| ② | `08-24-appearance-data-layer` 外观数据层与解析 helper | 无 |
| ③ | `08-24-sidebar-appearance-ui` 侧边栏渲染与编辑入口 | ② |
| ④ | `08-24-history-stats-appearance` History/Stats 对齐 | ②（可与 ⑤ 并行） |
| ⑤ | `08-24-webdav-appearance-sync` WebDAV 同步 | ②（可与 ④ 并行） |

共享技术契约见本任务 `design.md`，子任务不重复设计。

## Out of scope（本轮不做）

P2 布局重构：分组子级缩进引导线推广、弱化嵌套卡片、`sidebarDensity` 默认值调整与顶部密度切换入口。留待 issue #213 后续收集建议后另开任务。
