# 优化侧边栏项目树 UX

## Goal

解决项目树三个体验问题：折叠状态不记忆（每次启动全展开）、行内悬浮按钮过多易误触、右键菜单样式松散留白多。

## Requirements

* R1 折叠状态持久化：`collapsedIds`（index.tsx:122，纯内存 state）持久化到 settingsStore（存 `collapsedGroupIds: string[]`），启动时恢复；删除分组时清理对应记录；新建分组默认展开。
* R2 行内按钮精简为「只留启动」：项目行只保留 Play（启动终端），目录行只保留 Play（启动本目录）；Clone / 编辑 / 删除 / 新增子目录 / 新增终端 / 重命名等全部仅保留右键菜单入口（右键菜单已完整覆盖，无需新增菜单项）。
* R3 右键菜单收紧：密度收紧（减小 min-width 与行高内边距）+ 菜单项加左侧图标 + 分隔线按「启动类 / 编辑类 / 删除」分组，删除项保持 danger 红色。

## Decision (ADR-lite)

**Context**: 行内按钮保留策略与右键菜单样式属于 UX 偏好，需用户拍板。
**Decision**: 用户选定 A「只留启动」+「密度+图标+分组」。折叠状态存 settingsStore 而非 SQLite groups 表（UI 偏好非业务数据，且有 sidebarWidth/historySidebarWidth 先例）。
**Consequences**: `.context-menu` / `.context-menu-item` 样式被 HistoryListPane 共用，密度收紧同步生效于历史右键菜单（预期收益）；图标与分隔线仅在侧边栏菜单逐项添加，不强加给历史菜单。

## Acceptance Criteria

* [ ] 折叠若干目录后重启应用，折叠状态保持不变；展开后重启同样保持。
* [ ] 删除分组后其折叠记录从 settings 中清理，不残留。
* [ ] 项目行 hover 仅显示启动按钮；目录行 hover 仅显示启动按钮；原有其余操作均可通过右键菜单完成。
* [ ] 侧边栏右键菜单：更窄更紧凑、菜单项带图标、按操作类型分隔线分组、删除项红色。
* [ ] 历史列表右键菜单仅密度变化，无功能回归。
* [ ] `npx tsc --noEmit` 通过。

## Definition of Done

* typecheck 通过；变更范围报告给用户，由用户验证 UI（既有协作约定）。

## Out of Scope

* 不改动拖拽排序、多选、键盘导航逻辑。
* 不引入菜单组件库，沿用自绘 `.context-menu`。
* 不为行内按钮增加设置开关（YAGNI）。

## Technical Notes

* 涉及文件：
  - `src/stores/settingsStore.ts` — 新增 `collapsedGroupIds: string[]` 持久化字段
  - `src/components/sidebar/index.tsx` — collapsedIds 初始化/写回 settingsStore；删除分组时清理；右键菜单加图标与分隔线
  - `src/components/sidebar/TreeNodeItem.tsx` — 删除多余行内按钮（项目行去 Clone/Pencil/Trash2，目录行去 FolderPlus/Plus/Pencil/Trash2）
  - `src/App.css` — `.context-menu` / `.context-menu-item` 密度收紧，新增分隔线样式
* 图标沿用 `src/components/icons`（lucide），与行内按钮原图标一致：Play/Copy/Pencil/Trash2/FolderPlus/Plus 等。
