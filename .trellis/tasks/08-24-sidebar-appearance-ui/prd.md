# 侧边栏外观渲染与编辑入口

父任务：`08-24-sidebar-node-appearance`。技术契约见父任务 `design.md` §3、§4、§6。
依赖：`08-24-appearance-data-layer`（需要 `icon`/`color` 字段与 `resolveNodeAppearance`）。

## Goal

让侧边栏真正呈现外观差异，并提供三个一致的编辑入口；同时保证新建分组的一步式快路径不被打断。

## Requirements

- R-U1 `TreeNodeItem` 分组行、项目行按 `resolveNodeAppearance` 结果渲染：行容器写 `--node-accent`，仅给 leading icon 上色 + 选中态左侧 2px 色条，不铺整行背景。
- R-U2 图标优先级 emoji → iconKey → 类型默认；worktree 行继承所属项目的 `--node-accent`，不单独配置。
- R-U3 新建分组内联行（`TreeNodeItem.tsx:464-472`）的 `Folder` 图标改为可点按钮，打开 `NodeAppearancePopover`；**不点直接回车仍能一步建组**，落自动色。
- R-U4 新增 `NodeAppearancePopover`（基于 `src/components/ui/popover.tsx`）：10 色板 + 「自动」重置 + 单 emoji 输入；分组与项目共用同一组件。
- R-U5 编辑入口三处：内联新建行按钮、右键菜单新增「外观」（分组 `sidebar/index.tsx:2540-2601`、项目 `:2301-2338`）、项目编辑弹框内嵌同一组控件。
- R-U6 写入统一走 `projectStore`，不新增 store；写入后侧边栏即时反映（沿用现有 store 刷新路径）。
- R-U7 同步修复样式复用点：`.ui-project-tree-root` 的 leading-icon 重置（`components.css:1497`）、`.ui-split-project-picker`（`:2089`）、折叠侧边栏窄条 —— 三处着色均需正常且可区分。
- R-U8 新增文案走 `src/lib/i18n.ts`，覆盖全部已支持语言。

## 非目标

- 不改行高、缩进、引导线、卡片层级（属父任务 Out of scope 的 P2）。
- 不动 History / Stats（子任务 ④）。

## Acceptance Criteria

- [ ] 未做自定义时相邻分组/项目已可凭颜色区分；设置颜色/emoji 后即时生效
- [ ] 新建分组"输名字 → 回车"仍是一步，未点快选时为自动色
- [ ] 三处编辑入口打开的是同一组件、行为一致，可重置回自动
- [ ] 折叠侧边栏、分屏项目选择器、`.ui-project-tree-root` 三处外观正常（亮/暗主题各验一次）
- [ ] 运行中项目的 `data-status` 背景语义未被外观色破坏
- [ ] 键盘导航与 `aria-*`（`role="treeitem"`、`aria-level`、roving tabIndex）未回退
- [ ] `npx tsc --noEmit` 通过
- [ ] `CHANGELOG.md` 与 `docs/功能清单.md` 已更新
