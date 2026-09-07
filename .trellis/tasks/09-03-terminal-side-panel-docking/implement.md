# 执行计划：终端辅助面板左右停靠

## 前置与依赖

- 父任务：`09-03-workspace-custom-layout`。
- 依赖阶段 A 的背景 surface 契约；代码上可先在背景铺满关闭时开发。
- 阶段 C 依赖本阶段确立的 `workspaceLayout` 对象，不得另建 Tab 位置字段。
- 开始前建立文件职责清单；新增布局编排、面板内容、resize frame、设置控件和契约测试不得集中到单一文件。按职责拆分，不按固定行数机械拆分。

## 步骤

1. 对 `settingsStore.ts`、`TerminalTabs.tsx`、`TerminalSidePanel.tsx`、`SidebarSettingsPage.tsx` 执行 GitNexus impact；CRITICAL/HIGH 结果在编辑前记录。
2. 增加 `WorkspaceLayoutSettings` 类型、默认值、迁移和 `syncSettings.ts` preferences 分类。
3. 设置页增加辅助面板左/右选项及仅重置布局的按钮，补齐中英文文案。
4. 在 `TerminalTabs` 中按 `terminalSidePanelSide` 排列中心、panel 和固定 action rail；合并/非合并两条路径共用方向状态，左侧按中心→外侧语义反向呈现 panel 序列，编排代码不承载面板内容。
5. 在职责单一的 `ResizableTerminalPanelFrame` 模块中扩展 dockSide、镜像边框/sash、拖拽公式和样式；保留 RAF 预览与一次提交。
6. 适配 workspace 背景下的 panel surface，复核 panel 内部 Tab、滚动条、文件浏览器和统计卡片；不把背景根层逻辑复制到面板。
7. 增加必要的静态布局/resize 契约测试，更新 `CHANGELOG.md` `V1.3.9` 和 `docs/功能清单.md`。

## 验证

```powershell
npx tsc --noEmit
```

人工验证：默认右侧/左侧、合并/独立多个 panel、无 panel、左右拖拽边界和反向恢复、重启恢复、布局重置仅改变停靠位置且保留面板宽度、PTY 输出/scrollback/focus、Workspan/分屏、action rail、主题/皮肤、背景开关、fullscreen/compact/History/失焦/托盘。

完成阶段后运行 GitNexus `detect_changes()`，确认没有误触 `terminalPaneTree`、PTY 或历史执行流。

## 回滚

- 位置字段回退为默认 `right` 即可恢复当前布局。
- 保留 Store 中未知的 `workspaceLayout` 不影响旧代码；不要通过删除用户设置文件回滚。
