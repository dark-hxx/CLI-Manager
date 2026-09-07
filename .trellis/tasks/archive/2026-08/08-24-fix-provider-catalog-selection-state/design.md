# 修复供应商列表残留选中态 - Design

## Context

供应商详情由页面状态 `detailOpened` 控制；供应商目录却直接使用 Hook 保存的 `selectedProviderId` 绘制卡片选择样式。关闭详情不会清空选择 ID，因此视觉状态的生命周期长于详情交互生命周期。

## Decision

在 `NativeProviderSettingsPage` 向 `NativeProviderCatalog` 传递选择 ID 时，以 `detailOpened` 作为视觉选择的门控：详情打开时传递当前选择 ID，详情关闭时传递 `null`。

## Rationale

- 页面仍保留 `selectedProviderId`，不影响详情数据、刷新锚点、页面缓存或重新进入详情时的上下文。
- 视觉选择与其唯一可见的交互上下文（详情弹窗）绑定，关闭后不会残留。
- 仅改变一个父组件的展示输入，不扩大供应商 Hook 或卡片组件的职责。

## Data Flow

`catalog.selectedProviderId` -> `NativeProviderSettingsPage` -> `detailOpened ? selectedProviderId : null` -> `NativeProviderCatalog` -> `NativeProviderCard.selected` -> card class and `aria-current`.

## Compatibility

- 点击行打开详情：详情打开后照常显示对应的选择上下文。
- 编辑表单打开/关闭：只要详情仍打开，选择上下文保持；关闭详情后目录无选择视觉状态。
- 新增、删除、切换类型或离开目录：保留既有 Hook 状态更新逻辑，视觉选择仍受详情状态控制。

## Rollback

回退该父组件传参即可恢复此前目录选择样式，不涉及数据迁移或后端状态。
