# 先行可见性修复：CLI 工具徽章配色与分组计数

父任务：`08-24-sidebar-node-appearance`（需求集与共享契约见其 `prd.md` / `design.md`）。
依赖：无，可独立实现与独立验收，不需等外观数据层。

## Goal

用两处最小改动先拿到可见的区分度：激活仓库里已存在但从未被触发的按 CLI 工具配色，以及让分组折叠后仍能看出规模。

## Requirements

- R6-1 项目行的终端数徽章输出 `data-cli-tool={project.cli_tool}`，使 `src/styles/components.css:1549-1559` 的 claude / codex / gemini 配色生效；未匹配的工具沿用现有 `--primary` 默认值。
- R6-2 分组行增加"内含项目数"chip，复用 `.ui-tree-meta-chip` 样式；计数为该分组**含子分组递归**的项目总数。
- R6-3 计数 chip 在折叠与展开态都显示，避免展开时布局跳动。
- R6-4 chip 需要 `title` 与 `aria-label`，与现有 `sidebar.tree.terminalCount` 的写法保持一致；新增文案走 `src/lib/i18n.ts`，覆盖既有全部语言键。

## 非目标

- 不引入 `icon` / `color` 字段，不做外观自定义。
- 不调整行高、缩进、卡片样式。

## Acceptance Criteria

- [ ] claude / codex / gemini 三类项目的徽章圆点颜色互不相同，其余工具保持蓝色
- [ ] 分组折叠后可读出项目数，且数字含子分组内的项目
- [ ] 空分组不显示计数 chip（与终端数为 0 时不显示徽章的现有行为一致）
- [ ] 新增 i18n 键在所有已支持语言下均有值，无 key 回显
- [ ] `npx tsc --noEmit` 通过
- [ ] `CHANGELOG.md` 与 `docs/功能清单.md` 已更新
