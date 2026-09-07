# 修复供应商编辑删除确认弹框遮挡：设计

## Root Cause

`NativeProviderSettingsPage` 是删除确认请求和确认框 portal 的拥有者，却使用通用 `z-50` 默认值；当供应商详情 Mantine `Modal` 打开时，确认框在其下方。将局部确认框提升到供应商域已使用的 220 层，能修复父子弹框关系且不影响其他页面。

## Change

- 将 `useAppConfirm()` 改为 `useAppConfirm({ zIndex: 220 })`。
- 不修改共享 `ConfirmDialog`、Mantine Modal、删除后端和文案。

## Verification

- 手动在供应商详情中打开删除确认，检查内容、遮罩、按钮、Esc 和取消/确认。
- 运行 TypeScript 类型检查。
