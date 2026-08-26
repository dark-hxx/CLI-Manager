# 修复供应商列表残留选中态

## Goal

关闭供应商详情/编辑流程后，供应商目录不应继续显示任何行的选中样式；同时保留现有的内存选择缓存，以便页面重新打开时仍可恢复上次查看的供应商上下文。

## Requirements

- 供应商卡片的视觉选中态和 `aria-current` 仅在对应供应商详情弹窗处于打开状态时生效。
- 关闭供应商详情弹窗后，目录中的所有供应商卡片恢复普通样式，不保留灰色背景、边框或当前项无障碍标记。
- 不清除 `useNativeProviderCatalog` 的内部 `selectedProviderId` 或页面缓存；新增、编辑、删除、CLI 类型切换和详情加载的既有数据行为保持不变。
- 不新增用户可见文案，避免不必要的 i18n 变更。
- 产品记录使用 `CHANGELOG.md` 的 `TEMP` 版本，并更新 `docs/功能清单.md` 的供应商目录说明。

## Acceptance Criteria

- [x] 点击供应商后仍将原有选择 ID 传给详情流程；本次未改动选择、详情加载或编辑状态。
- [x] 关闭详情后，目录收到 `null`，因此无卡片满足 `selected`，也不会输出 `aria-current`。
- [x] 重新进入详情或新增供应商后，详情打开时继续传递 Hook 缓存的选择 ID。
- [x] `node --test scripts/nativeProviderCatalogSelection.test.mjs` 通过，锁定视觉选择与详情打开状态的边界。
- [x] `npx tsc --noEmit` 与 `npm run build` 通过。
- [x] `CHANGELOG.md`（`TEMP`）与 `docs/功能清单.md` 已更新。

## Validation Notes

- Chrome DevTools 无法稳定附着到本地 Vite 页面（目标在导航后重置为空白页），因此未完成独立的浏览器运行时点击验收。
- 该 UI 状态边界由新增回归测试、TypeScript 检查和生产构建覆盖；桌面端手测可按“打开供应商详情/编辑 -> 关闭详情 -> 确认目录无高亮”复核。

## Out of Scope

- 不改变供应商选择的持久化/页面缓存规则。
- 不重构供应商目录、详情弹窗、拖拽排序或供应商 CRUD 行为。
- 不修改后端、数据库、IPC 契约或翻译资源。

## Technical Notes

- 根因：`NativeProviderSettingsPage` 在详情关闭时仅将 `detailOpened` 设为 `false`，而 `NativeProviderCatalog` 始终以 `catalog.selectedProviderId` 给卡片传递 `selected`，使已关闭详情的目录继续渲染选中样式。
- 根因修复层：父页面同时拥有详情打开状态和传给目录的选择状态，应在该边界将视觉选择限制为详情实际打开的期间，而不是清除 Hook 的选择数据。
- GitNexus 发现清单：
  - `src/components/settings/pages/NativeProviderSettingsPage.tsx`：拥有 `detailOpened` 和传给 `NativeProviderCatalog` 的 `selectedProviderId`；本次修改目标。
  - `src/components/settings/providers/NativeProviderCatalog.tsx`：将 `selectedProviderId` 映射为每个卡片的 `selected`；确认不需要修改。
  - `src/components/settings/providers/NativeProviderCard.tsx`：根据 `selected` 渲染视觉状态和 `aria-current`；确认不需要修改。
  - `src/components/settings/providers/useNativeProviderCatalog.ts`：拥有详情数据加载、选择锚点和刷新后的恢复；确认应保持不变。
  - `src/components/settings/providers/NativeProviderDetailModal.tsx` 与 `NativeProviderFormModal.tsx`：消费打开/关闭状态；确认不需要修改。
- GitNexus 影响分析：`NativeProviderSettingsPage` 上游风险 `LOW`，直接调用方、受影响流程和模块均为 0。

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
