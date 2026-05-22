# 本地 TODO（不提交 git）

> 位置：`.trellis/workspace/hxx/TODO.md`（位于 `.trellis/` 之下，gitignore 已忽略整目录）。

## 待办

### 1. 终端换行快捷键可配置

**问题**：当前在终端 / Prompt 输入框中换行被硬编码为 `Alt+Enter`，体验差。

**期望**：
- 移除强制 `Alt+Enter` 的换行绑定
- 在设置中新增可配置项（建议复用 `settingsStore.keyboardShortcuts` 现有快捷键系统）
- 允许用户改成 `Shift+Enter` / `Ctrl+Enter` 等任意组合

**改动点提示**：
- `src/components/XTermTerminal.tsx` 的 `attachCustomKeyEventHandler` 处理键盘组合
- `src/stores/settingsStore.ts` 的 `keyboardShortcuts` 字段加新 action（如 `terminal.newline`）
- `src/components/settings/pages/ShortcutsSettingsPage.tsx`（或对应快捷键设置页）增加录制项

---

### 2. 终端 Tab 栏关闭按钮放大

**问题**：终端 Tab 栏右侧的关闭按钮（`×`）目前太小，点击命中率低。

**期望**：
- 增加点击热区（padding / hit-slop）
- 视觉尺寸适度增大（图标不必显眼放大，但鼠标 hover 区要明显）

**改动点提示**：
- `src/components/TerminalTabs.tsx` 中 `SortableTab` 组件的关闭按钮节点
- 注意保持与 Tab 整体高度协调
