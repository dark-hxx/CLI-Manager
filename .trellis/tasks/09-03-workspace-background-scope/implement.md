# 执行计划：工作区背景作用域

## 前置

- 父任务：`09-03-workspace-custom-layout`。
- 这是第一阶段，不依赖阶段 B/C；完成后才能进入后续布局视觉验收。
- 修改 `settingsStore`、`App`、`XTermTerminal` 等符号前，先执行 GitNexus upstream impact，并记录共享设置中心的 CRITICAL 风险。
- 先建立文件职责清单：设置模型/迁移、根背景、终端适配、设置控件、样式和测试分别归属独立职责；不得把新逻辑整体堆入现有大文件。
- 不设置机械行数阈值；如果新增职责与现有职责无法独立阅读、测试或回滚，应按职责抽取最小模块。与阶段 A 无关的全面重构禁止带入。
- 目标模块：`src/components/workspace/WorkspaceLayoutShell.tsx`、`WorkspaceBackground.tsx`、`src/styles/workspace-layout.css`、`scripts/workspaceBackgroundLayout.test.mjs`；其他既有文件只做最小接线。

## 步骤

1. 阅读并确认现有终端背景契约、`terminalBackgroundLayout.test.mjs` 和背景安全路径。
2. 在 `TerminalBackgroundSettings`、默认值和 `migrateTerminalBackground` 中加入 `fillWorkspace`。
3. 在 `TerminalBackgroundSection` 增加“背景铺满工作区”开关、禁用状态、说明和中英文 i18n。
4. 新增职责单一的 `WorkspaceLayoutShell`/`WorkspaceBackground`，在 `App` 主工作区内容边界挂载一次，复用 `backgroundAssetUrl` 和现有图像参数；`App` 不承载背景实现细节。
5. 调整 `XTermTerminal`：workspace 模式保留透明渲染，关闭局部图片伪元素和不透明 wrapper；terminal-only 模式保持原路径。终端组件不接管根背景。
6. 调整 Sidebar、Tab chrome、终端辅助面板和必要的 terminal well surface，使 workspace 模式显示连续背景；新增 CSS 按背景 surface 职责组织，菜单、卡片和弹层保持高不透明度。
7. 在独立的 `workspaceBackgroundLayout.test.mjs` 增加静态契约测试，验证根背景层唯一、local background 与 workspace 模式互斥、内容 z-index 和 pointer-events。
8. 更新 `CHANGELOG.md` 的 `V1.3.9` 段及 `docs/功能清单.md` 背景图板块。

## 验证

```powershell
npx tsc --noEmit
node --test scripts/workspaceBackgroundLayout.test.mjs
```

人工验证必须覆盖：无图、图片缺失、开关热切换、全部 fit/position/opacity/blur/darken、亮暗主题、standard/compact、fullscreen、History、失焦/恢复、最小化/托盘、多 Pane 与会话级隐藏背景。

## 回滚

- 默认 false 保证旧设置和回滚代码保持 terminal-only 行为。
- 不修改图片文件和数据库；只需回退设置字段消费、根背景组件和 CSS。
