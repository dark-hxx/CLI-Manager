# 执行计划：顶层 Workspan Tab 顶部/底部停靠

## 前置与依赖

- 父任务：`09-03-workspace-custom-layout`。
- 依赖阶段 B 已建立并迁移 `workspaceLayout`；背景视觉依赖阶段 A。
- 修改 `TerminalTabs` Workspan Tab、拖拽和 Popover 相关符号前执行 GitNexus upstream impact。
- 开始前建立文件职责清单；顶层 Tab 交互、布局槽位、浮层锚点、设置控件和契约测试按职责拆分，不把新逻辑集中回 `TerminalTabs`。
- 不按固定行数机械拆分既有代码；只有新增职责造成职责混杂时才抽取最小模块。

## 步骤

1. 接入 `workspaceLayout.workspanTabBarPosition`，默认 top，在阶段 B 的 `WorkspaceLayoutSection` 中增加顶部/底部选项并复用同一个恢复默认布局动作。
2. 将职责单一的 Workspan Tab bar 与 terminal body 保持在 flex 文档流中，按位置切换顺序；disabled/隐藏时不渲染占位；不改变 pane tree、session key 或 DnD id。
3. 保持现有横向排序、滚动、左右按钮、列表 Popover、右键菜单、重命名、关闭确认和滚轮逻辑；位置编排不复制这些交互实现。
4. 复核底部触发器锚点、插入预览、焦点与键盘顺序；Pane 内 `PaneTabBar` 保持顶部。
5. 适配 fullscreen、History、Workspan disabled/empty、workspace background 和辅助面板左右组合。
6. 更新 `CHANGELOG.md` `V1.3.9` 与 `docs/功能清单.md`，执行 `detect_changes()`。

## 验证

```powershell
npx tsc --noEmit
node --test scripts/terminalBackgroundLayout.test.mjs
```

人工验证：单/多 Workspan、Tab 溢出、滚轮、排序拖拽、关闭/重命名/菜单、底部无遮挡、单/多层分屏、PTY/scrollback/focus、亮暗主题、背景开关、panel 左右、fullscreen/History/compact。

## 回滚

- 将位置回退为 `top` 可恢复现有布局，不涉及数据库、Rust 或 PTY。
- 保留未知 settings 键；不要清理整个 Store。
