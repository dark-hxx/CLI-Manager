## Bug Analysis: 供应商详情关闭后目录行残留焦点环

### 1. Root Cause Category

- **Category**: D/E — 测试覆盖缺口与隐式焦点生命周期假设。
- **Specific Cause**: 目录卡片的选中状态和 Mantine Modal 的焦点返回是两套独立状态；详情 Modal 默认把焦点交还给触发它的供应商行，行的标准焦点环看起来与残留选中效果相同。

### 2. Why Fixes Failed

1. **首次修复**：仅让 `selectedProviderId` 在详情关闭后不再传入目录。它正确移除了卡片的 selected/`aria-current` 样式，但没有改变 Modal 关闭时的 DOM 焦点，故截图中的主按钮焦点环仍然存在。
2. **第二次修复**：将焦点交给 `tabIndex={-1}` 页面根节点。它移除了行焦点环，但 Chromium 对程序聚焦的根节点显示了整页默认黑色轮廓；应复用已有的 surface 导航 radio 作为可见且范围受限的目标。

### 3. Prevention Mechanisms

| Priority | Mechanism | Specific Action | Status |
|---|---|---|---|
| P0 | Architecture | 详情 Modal 显式关闭自动焦点回退，并在退出后交给页面拥有者的既有 surface 导航设置稳定焦点。 | DONE |
| P0 | Test coverage | 静态回归测试同时覆盖 selected 状态、Modal `returnFocus`、退出回调、已选 surface radio 及表单保留默认返回。 | DONE |
| P1 | Documentation | 在供应商域契约中记录“选择状态”和“焦点返回”必须分别处理。 | DONE |

### 4. Systematic Expansion

- **Similar Issues**：其他 Modal 只有在“焦点回到触发控件会被误读为持久状态”时才需要同样的显式策略；不能全局关闭 Mantine 的 `returnFocus`。
- **Design Improvement**：Modal 的焦点去向由拥有稳定页面根节点的父组件决定，嵌套编辑 Modal 继续遵守标准的返回焦点行为。
- **Process Improvement**：遇到“关闭弹窗后仍高亮”的报告时，先区分 ARIA/数据 selected 样式与 `:focus-visible`，并验证 `document.activeElement`，而不是只修改显示状态。

### 5. Knowledge Capture

- [x] `.trellis/spec/frontend/ccs-provider-domain-contracts.md` 已记录详情 Modal 焦点返回契约。
- [x] 仓库没有 `src/templates/` 的 spec 镜像目标，无需模板同步。
