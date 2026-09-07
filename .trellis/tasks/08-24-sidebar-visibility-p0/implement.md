# 执行计划：先行可见性修复

前置阅读顺序：父任务 `prd.md` → 父任务 `design.md` §6 → 本文件。

## 步骤

1. `src/components/sidebar/TreeNodeItem.tsx:334-342`：终端数 chip 补 `data-cli-tool={p.cli_tool}`。
   - 注意 `p.cli_tool` 可能为空串或未知值，CSS 无匹配时自然落回 `--cli-chip-color: var(--primary)`，无需在 TS 里做映射。
2. 确认 `src/styles/components.css:1549-1559` 的选择器与实际 `cli_tool` 取值一致（对照 `src/lib/cliTools.ts` 的 `resolveCliToolIconKey`）。若取值是 `claude-code` 之类的长 key，则在 CSS 补选择器而不是在组件里改写属性值。
3. 分组项目数：在 `src/components/sidebar/index.tsx` 的 tree actions 中新增 `getGroupProjectCount(groupId)`，递归口径复用 `handleStartGroup`（`:1667` 起）已有的 `childMap` + `walk` 递归写法，避免两套统计逻辑。
   - 通过 `TreeContext` 暴露，供 `TreeNodeItem` 读取。
4. `src/components/sidebar/TreeNodeItem.tsx:458` 之后（分组名与 `ui-tree-item-actions` 之间）插入计数 chip，`count > 0` 才渲染。
5. `src/lib/i18n.ts` 新增 `sidebar.tree.groupProjectCount`，补齐所有语言。
6. 更新 `CHANGELOG.md`：追加到既有 `## [V1.3.8]` 段下的新 `###` 小节（app version 源仍为 1.3.7，本任务不改版本号），并更新 `docs/功能清单.md` 对应功能小节。

## 验证

```bash
npx tsc --noEmit
```

人工验证清单（父任务 design §6 的复用点）：

- 侧边栏正常态 / 折叠态
- `.ui-split-project-picker` 分屏项目选择器
- 亮色与暗色主题各看一遍徽章配色

## 实现结果（与计划的偏差）

- 步骤 3 未新增 store 级计数 map：发现 `ProjectTree.tsx` 的折叠侧边栏窄条已有分组项目数徽章（`countProjects` + `ui-tree-collapsed-badge`）。改为把该递归提取为 `projectStore.countProjectsInNode(node)` 导出，`TreeNodeItem` 直接对自己的 `node` 调用。因此 `TreeContext` / `sidebar/index.tsx` 完全没有改动，触点更少、两处口径天然一致。
- 步骤 5 未新增 i18n 键：`sidebar.tree.directoryProjectCount`（`目录 {name}（{count} 个项目）`）已存在且语义完全匹配，直接复用作 chip 的 `title` / `aria-label`，i18n.ts 未改动。
- 步骤 1-2 的属性值不是原始 `p.cli_tool`：`cli_tool` 是自由文本命令（可能带参数、可能是 `npx claude`），直接塞进 `data-cli-tool` 匹配不到 CSS。改为写归一化后的 `resolveCliToolIconKey(p.cli_tool)` 结果（`claude-code` / `codex` / `gemini-cli`），CSS 侧按计划"补选择器"而非改组件值，短别名 `claude` / `gemini` 一并保留。
- 额外一处：分组计数 chip 加 `.ui-tree-count-chip` 去掉 `.ui-tree-meta-chip::before` 的工具色圆点，避免与项目行的终端数徽章混淆。

## 已执行验证

- `npx tsc --noEmit` 通过（无错误）。
- 改动文件：`src/stores/projectStore.ts`、`src/components/sidebar/TreeNodeItem.tsx`、`src/components/sidebar/ProjectTree.tsx`、`src/styles/components.css`、`CHANGELOG.md`、`docs/功能清单.md`。
- 未执行：应用内人工视觉验证（亮/暗主题、compact/comfortable、折叠态、分屏项目选择器）——需要用户在应用里确认。

## 回滚点

两处改动互相独立：徽章属性（步骤 1-2）与计数 chip（步骤 3-5）可分别单独回滚。
