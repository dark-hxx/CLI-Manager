# 执行计划：History 与 Stats 项目树外观对齐

前置阅读顺序：父任务 `prd.md` → 父任务 `design.md` §2/§3 → 子任务 ③ 的实现（对齐渲染写法）→ 本文件。

## 步骤

1. `src/components/history/HistoryListPane.tsx`
   - `:230-231` 的项目图标解析函数改为先取 `resolveNodeAppearance`，emoji 优先，回退 `resolveCliToolIconKey` → `Terminal`。
   - `renderProjectNode`（`:666`）分组分支：`:680` 的 `<Folder size={13}>` 改为按 appearance 渲染，并在该行容器写 `--node-accent`。
   - `:709`、`:863` 的 `ui-tree-leading-icon` 用法确认是否属于项目树行；属于则一并接入，不属于（如来源选择器）则不动。
2. `src/components/stats/StatsPanel.tsx`
   - `:1142` 的图标解析函数同样接入。
   - `:1298`、`:1323`、`:1343-1347`、`:1383` 逐处判断是分组行、项目行还是筛选器装饰；只改项目树的行，装饰性 `Folder` 不动。
3. 抽一个共享的小渲染组件（如 `NodeAppearanceIcon`，放 `src/components/` 下）承担 emoji/iconKey/默认三级回退，供侧边栏与这两个面板复用，避免三处各写一遍分支。
   - 若子任务 ③ 已在 `TreeNodeItem` 内联实现了这段分支逻辑，本任务负责把它提取为共享组件并回改 ③ 的调用点。
4. 全仓核查：搜索 `hashName` / 调色板 token 常量，确认只有 `src/lib/nodeAppearance.ts` 一处实现。
5. 更新 `CHANGELOG.md`（追加到既有 `## [V1.3.8]` 段）与 `docs/功能清单.md`。

## 验证

```bash
npx tsc --noEmit
```

人工验证：

- 同一项目在侧边栏、History 列表、Stats 项目树三处并列截图对比，颜色与图标一致
- History 的搜索过滤态、Stats 的筛选态下外观不丢
- emoji 节点在 13px 图标尺寸下不撑行高
- 亮/暗主题各验一次

## 实现结果（与计划的偏差）

- **步骤 3 的共享图标组件已在子任务 ③ 完成**（`src/components/NodeAppearanceIcon.tsx`），本任务只做替换，没有回改 ③ 的代码。
- **Stats 的项目图标口径被统一**：`StatsProjectFilterIcon` 原本走 `inferVendor` + `VendorIcon`，是三处项目树里唯一的第三种图标实现（侧边栏与 History 都走 `CliToolIcon`）。按 PRD 的"三处图标完全一致"验收标准改为 `NodeAppearanceIcon`。副作用：Stats 项目筛选里的图标外观会从 VendorIcon 变成 CLI 工具图标，属预期变化。`VendorIcon` / `inferVendor` 在该文件已无其他用途，import 一并移除。
- **两处的"全部项目"合成行不接外观**（`HistoryListPane` 的 `history.allProjects`、Stats 同类行）：它们不是真实分组，保留原 `Folder` 图标。
- History 项目筛选下拉的触发按钮复用了 `ProjectFilterIcon`，因此自动跟随外观，无需单独改。

## 已执行验证

- `npx tsc --noEmit`：无错误。
- 唯一实现核查：全仓搜索 `hashName` / `NODE_ACCENT_TOKENS` / `autoAccentToken`，除 `src/lib/nodeAppearance.ts` 自身外只有 `NodeAppearancePanel` 引用 token 列表用于渲染色板，没有第二份 hash 或调色板实现。
- 未执行：三处并列的人工视觉比对（需要在应用里同时打开侧边栏、History、Stats）。

## 回滚点

两个面板互不依赖，可分别回滚。步骤 3 的组件提取若引起 ③ 的回归，可先保留两处各自实现、只保证视觉一致，再单独提交提取重构。
