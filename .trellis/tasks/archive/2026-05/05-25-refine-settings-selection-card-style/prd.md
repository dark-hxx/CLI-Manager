# 重构设置页"选择卡片"的选中样式

## Goal

修复用户嫌"丑"的选中态：去掉按钮被整体染成主题色的内部填充，保留外发光作为标识，并在右上角加一个 ✓ 勾号角标，让选中识别清晰且不破坏卡片外观。

## What I already know

* 用户原话："设置界面有关主题设置（系统主题、终端主题）、侧栏密度 等这些按钮都有'选中阴影'太丑了，仅给个选中标记就可以 不需要整个按钮都变色"。
* 用户澄清：「选中阴影」≠ 外发光 box-shadow，而是 **按钮内部背景被染成主题色**。外发光是用户认可的选中标记。
* CSS 根源（两条规则在同一元素上叠加）：
  * `App.css:716-721` `.ui-interactive[data-selected="true"]` → 设置 `background-color: var(--interactive-selected-bg)`（= primary 28%~42% mix），这是用户嫌弃的"内部染色"。
  * `App.css:736-742` `.ui-selection-card[data-selected="true"]` → 设置外发光 + inset border + 文字加深，没有显式覆盖背景，所以继承了上面那条的染色。
* `--interactive-selected-bg` 在每个主题 palette 里独立定义（App.css:321/361/377/394/410/426/442），改 token 影响面广，**不动 token**。
* 受影响点位（设置页内 8 处）：
  * `GeneralSettingsPage.tsx:234/343/540` — PaletteCard、主题按钮、侧栏密度/视图模式
  * `ThemeSettingsPage.tsx:113` — 终端主题
  * `TerminalBackgroundSection.tsx:205/342` — fit 缩略图（无 data-selected，无影响）+ 9 宫格位置按钮
  * `SyncSettingsPage.tsx:275` — 同步提供商
* 项目树 / 终端标签使用独立 class（`ui-tree-project`、`ui-tab-trigger`），不受本次改动影响。

## Decision

**最终方案（已经用户确认）**：

1. `.ui-selection-card` 增加 `position: relative`（让 ::after 伪元素生效，不需要在每个 TSX 加 className）。
2. `.ui-selection-card[data-selected="true"]` 增加 `background-color: var(--surface-container-low)`，显式覆盖父 `.ui-interactive[data-selected]` 的 selected-bg 染色。
3. **保留**外发光 box-shadow（用户的"选中标记"语义）、inset 1px border 加深、文字 color 加深。
4. **新增** `.ui-selection-card[data-selected="true"]::after`：右上角 ✓ 勾号（Unicode "✓"，颜色 `var(--primary)`，font-size 12px），保证一目了然。
5. **9 宫格特例**：`TerminalBackgroundSection.tsx:342` 移除 `ui-selection-card` class（仅保留 `ui-interactive ui-focus-ring`），9 宫格回到 `ui-interactive` 默认 selected-bg 填充行为（无勾号），符合用户 Q2「整体填充背景色」选择。

### Amendment（2026-05-26，实施后用户决定）

* **取消** 右上角 ✓ 勾号角标：用户在 commit `bb25287` 实施后认为外发光 + border 加深 + 文字加深已足够清晰，不再需要 ✓。
* 删除 `.ui-selection-card[data-selected="true"]::after` 整段规则。
* `.ui-selection-card { position: relative; }` 防御性保留（对外形无影响，且避免反复改动），其余选中态样式（背景去染色、border、文字加深、外发光）全部按既定方案保留。
* 9 宫格特例（移除 `ui-selection-card` class）继续保留，与本次撤销无关。

## Requirements

* 应用主题、终端主题、PaletteCard、侧栏密度、视图模式、同步提供商按钮选中时：
  * 内部背景与未选中一致（不染主题色）
  * 保留外发光 + border 加深 + 文字加深作为选中信号
* 9 宫格位置按钮选中时：保留整体填充背景色

## Acceptance Criteria

* [ ] 主题/终端主题/密度/视图/同步按钮选中态：内部背景与默认态一致，仅外发光 + border + 文字加深表示选中
* [ ] PaletteCard 选中：色板 swatch 不被覆盖
* [ ] 9 宫格位置按钮选中：保留填充式选中，布局未变
* [ ] `npx tsc --noEmit` 通过
* [ ] 未引入新依赖
* [ ] ~~右上角有 ✓~~（Amendment：已取消）
* [ ] ~~✓ 不遮挡 swatch~~（Amendment：已取消）
* [ ] ~~✓ 颜色对比度可识别~~（Amendment：已取消）

## Out of Scope

* 不动 `.ui-tree-project` / `.ui-tab-trigger`
* 不动 `--interactive-selected-bg` token 定义
* 不引入新动画 / hover 效果
* 不调整未选中态外观

## Technical Approach

`App.css:730-744` 改为（Amendment 后的最终状态，已删除 ::after 段）：

```css
.ui-selection-card {
  position: relative;
  background-color: var(--surface-container-low);
  border-color: color-mix(in srgb, var(--border) 82%, transparent);
  color: var(--on-surface-variant);
}

.ui-selection-card[data-selected="true"] {
  background-color: var(--surface-container-low);
  border-color: var(--interactive-selected-border);
  color: var(--on-surface);
  box-shadow:
    inset 0 0 0 1px var(--interactive-selected-border),
    0 0 0 6px color-mix(in srgb, var(--primary) 16%, transparent);
}
```

`TerminalBackgroundSection.tsx:342`：删除 `ui-selection-card`，保留 `ui-interactive ui-focus-ring`。

## Risk & Rollback

* 风险：删除 ✓ 后，外发光 + border + 文字加深是否在所有主题下均可被肉眼识别——已由用户主观确认可接受。
* 回滚：单文件 revert 即可恢复。
