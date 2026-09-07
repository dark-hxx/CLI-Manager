# 修复供应商编辑删除确认弹框遮挡

## Goal

让供应商详情/编辑流程中的删除确认弹框始终显示在其父级 Mantine 弹框之上，并保持可访问、可点击。

## Confirmed Facts

- `NativeProviderSettingsPage` 通过 `useAppConfirm()` 创建供应商删除确认框。
- 通用 `ConfirmDialog` 默认使用 Radix 的 `z-50`；供应商详情和编辑界面使用 Mantine `Modal`。
- 相邻的嵌套确认场景已有显式较高层级的调用模式，需沿用而不修改通用确认组件的全局默认值。

## Requirements

- 删除供应商时，确认框和遮罩必须位于供应商详情/编辑/导入类父弹框之上。
- 取消、确认、Esc 与焦点行为维持现有语义。
- 仅调整供应商页面拥有的确认层级，不影响其他页面的确认框层级。

## Acceptance Criteria

- [ ] 在供应商详情/编辑弹框中触发删除，确认框内容与操作按钮完整可见且可交互。
- [ ] 确认或取消后，页面状态与现有删除流程一致。
- [ ] 类型检查通过，并有针对嵌套弹框层级的代码级回归保障或可复现的手动验证记录。

## Root Cause and Discovery

- 根因：确认框由 `NativeProviderSettingsPage` 创建时未指定层级，通用 `ConfirmDialog` 因而停留在 Radix 的 `z-50`；供应商详情使用 Mantine `Modal`，使 portal 中的确认框被父弹框遮挡。修复必须落在确认框拥有者，而不是全局抬升所有确认框。
- `src/components/settings/pages/NativeProviderSettingsPage.tsx`：删除请求与 `useAppConfirm` 的拥有者，需修改。
- `src/components/ConfirmDialog.tsx`：通用默认层级来源，确认后不修改，以免改变其他弹框堆叠。
- `src/components/settings/providers/NativeProviderDetailModal.tsx`：触发删除的 Mantine 父弹框，确认相关。
- `src/components/settings/providers/NativeProviderGlobalSection.tsx`：已有 `useAppConfirm({ zIndex: 220 })` 的同类嵌套弹框先例，确认复用该局部模式。
- `NativeProviderCatalog`、删除 IPC、i18n：只透传已有行为或文案，确认无关。
