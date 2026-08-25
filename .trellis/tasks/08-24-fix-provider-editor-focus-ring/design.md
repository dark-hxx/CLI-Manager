# 修复供应商编辑关闭后的焦点残留：设计

## Root-Cause Statement

缺陷位于 Mantine 详情 Modal 的焦点返回边界：它在关闭时重新聚焦打开详情的供应商行主按钮，触发该按钮的焦点环；修复必须在该 Modal 边界提供可访问的替代焦点落点，而不是再修改目录的选中样式。

## Boundary Map

`NativeProviderCard` 主按钮 → `NativeProviderSettingsPage.handleProviderSelect` → `NativeProviderDetailModal` → Mantine `useFocusReturn` → 主按钮 `.ui-focus-ring:focus-visible`。

详情 Modal 的表单层为独立路径：`NativeProviderDetailModal.onEdit` → `NativeProviderFormModal` → 关闭后回到详情 Modal。此路径不应采用新的页面焦点落点。

## Decision

- 仅为 `NativeProviderDetailModal` 设置 `returnFocus={false}`，停止 Mantine 将焦点交回目录行。
- 利用 Modal 的 `onExitTransitionEnd`，在详情退出动画完成、DOM 已稳定后回调父页面。
- 父页面把焦点放到现有目录 surface 导航的已选中 radio input。该控件已有可见、小范围的焦点提示和可访问名称；不能将焦点放到新增的 `tabIndex={-1}` 页面根节点，因为 Chromium 仍会为它绘制整页默认轮廓。
- 回调用 one-shot close ref 限定为已接受的详情关闭，并且只在目录 surface 仍显示、根元素仍连接到 DOM 时执行；切换设置页、CLI 类型或卸载会清除该标记，避免抢走新页面焦点。
- 不触碰 `NativeProviderFormModal` 的默认返回焦点；嵌套表单关闭应继续回到详情内的触发控件。

## State-Dependency Scenario Matrix

| 场景 | 预期 |
|---|---|
| 鼠标点击供应商行后关闭详情 | 焦点不回到行按钮，行没有矩形焦点环；目录 surface 导航接收焦点。 |
| 键盘 Enter/Space 打开详情后按 Escape 关闭 | 焦点落在可见的目录 surface radio；Tab 可继续导航，且行不显示残留环。 |
| 点击关闭按钮或遮罩关闭详情 | 与 Escape 一致。 |
| 详情内打开编辑表单后取消/保存 | 焦点仍回到详情 Modal；不提前落到目录页。 |
| 编辑后再关闭详情 | 仅在详情退出完成后落到页面区域。 |
| Claude / Codex / Grok Build | 三者均使用同一详情 Modal，行为一致。 |
| 切换目录/Home/路由 surface 或关闭设置窗口 | 根节点未连接或目录不再显示时不强制聚焦，避免抢占新页面焦点。 |

## Discovery List

- [x] `src/components/settings/providers/NativeProviderCard.tsx`：确认矩形来自主按钮的 `.ui-focus-ring`，目录 `selected` 样式不是当前截图根因；无需修改。
- [x] `src/components/settings/pages/NativeProviderSettingsPage.tsx`：拥有详情开关和常驻 surface 导航；应将该导航的已选 radio 作为关闭后焦点目标。
- [x] `src/components/settings/providers/NativeProviderDetailModal.tsx`：拥有 Mantine Modal 的 `returnFocus` 和退出生命周期；需要修改。
- [x] `src/components/settings/providers/NativeProviderFormModal.tsx`：嵌套编辑 Modal 必须维持默认焦点返回；确认不修改。
- [x] `src/styles/components.css`：确认焦点环符合全局可访问性样式；确认不修改。
- [x] Mantine 9.3.1 文档及安装包：`returnFocus` 默认开启，`onExitTransitionEnd` 可用于退出后手动恢复焦点。

## Compatibility and Rollback

- 不改变供应商数据、缓存、IPC、可见文案或全局 CSS。
- 回滚只需撤回详情 Modal 的显式焦点策略及页面根区域的焦点回调；Mantine 默认行为会恢复。
