# 阶段 B：终端辅助面板左右停靠

## Goal

实现合并/独立终端辅助面板的左/右停靠与方向感知拖拽，保持终端会话和面板交互不变。

版本：`V1.3.9`。

## Dependencies

- 父任务：`09-03-workspace-custom-layout`。
- 依赖阶段 A 提供的 workspace 背景表面契约，但可先在关闭背景铺满模式下独立开发和验证。
- 不修改 `terminalPaneTree`、`SplitTerminalView`、PTY 会话或历史数据；阶段 C 依赖本阶段确定的终端工作区布局槽位。

## Requirements

- B1：新增并持久化 `workspaceLayout.terminalSidePanelSide`，取值仅为 `left`/`right`，默认 `right`；非法值回退默认。
- B2：合并面板和非合并面板都按配置停靠；以当前右停靠时“终端中心→外侧”的面板顺序为基准，切换左侧时通过反向 DOM 顺序保持相同的中心→外侧视觉顺序。
- B3：`ResizableTerminalPanelFrame` 接收停靠方向，边框位置、resize sash 位置、拖拽宽度计算、光标和 `aria-orientation` 均与方向一致。
- B4：辅助面板移动不重建或卸载终端 Pane；保留当前活动会话、scrollback、面板 Tab、面板宽度和焦点。
- B5：终端操作工具栏继续位于终端工作区右侧，不随辅助卡片面板移动；其 popover 和 tooltip 锚点仍可用。
- B6：设置页通过与阶段 C 共用的 `WorkspaceLayoutSection` 提供左/右选项与恢复默认布局入口，文案覆盖中英文；布局位置按 preferences 进入 `syncSettings.ts`，既有面板宽度继续复用 `terminalPanelWidths`。
- B7：在 workspace 背景开启时，辅助面板使用半透明终端皮肤表面；关闭时保持现有不透明面板皮肤。

## 文件职责与阶段边界

- 本阶段只负责辅助面板的外层停靠和 resize 方向；不修改 `terminalPaneTree`、`SplitTerminalView`、PTY、历史数据或 Pane 内 Session Tab。
- `TerminalTabs` 只负责把面板、中心区域和 action rail 编排到布局槽位；面板内容继续由 `TerminalSidePanel` 负责，边框/sash/拖拽状态由职责单一的 `ResizableTerminalPanelFrame` 负责。
- 设置布局控件、`workspaceLayout` 迁移、面板布局样式和 resize 契约测试分别归属独立职责；不得把面板内容、设置迁移和拖拽算法堆入同一文件。
- 不按固定行数拆分已有文件。只有新增职责造成职责混杂时才抽取；与左右停靠无关的既有面板重构不在范围内。
- 目标模块为 `src/lib/workspaceLayout.ts`、`src/components/settings/pages/WorkspaceLayoutSection.tsx`、`src/components/terminal/TerminalWorkspaceFrame.tsx`、`ResizableTerminalPanelFrame.tsx`、`src/styles/workspace-layout.css` 和 `scripts/terminalSidePanelLayout.test.mjs`；`TerminalTabs.tsx` 只保留状态编排和节点接线。

## Acceptance Criteria

- [ ] 默认布局与当前版本一致：辅助面板在右侧，工具栏在最右侧。
- [ ] 切换到左侧后，合并面板和每个独立面板均显示在终端左侧；面板内容、Tab、关闭和切换功能正常。
- [ ] 多个独立面板在左右停靠时，按终端中心到外侧保持同一语义顺序；只改变布局呈现，不改变状态中的 panel 顺序和 width key。
- [ ] 左右两侧拖拽宽度方向正确，达到最小/最大边界后反向拖动立即生效，松手后只提交一次持久化设置。
- [ ] 重启后面板位置与宽度恢复；恢复默认后回到右侧，但保留用户已调整的面板宽度。
- [ ] 多会话、多 Workspan、单层/多层分屏、Pane 切换期间无 PTY 重建、输出丢失、滚屏重置或焦点丢失。
- [ ] 合并/非合并模式、无面板、多个独立面板、亮/暗主题、终端皮肤均通过人工验证。
- [ ] `npx tsc --noEmit` 通过。
- [ ] `CHANGELOG.md` 的 `V1.3.9` 段和 `docs/功能清单.md` 终端侧面板板块完成记录。

## Technical notes

- 右停靠时宽度公式是 `startWidth + startX - currentX`；左停靠时应改为 `startWidth + currentX - startX`，并在 clamp 边界重新基准化。
- 不要通过 CSS `direction` 或整体镜像实现左停靠，否则会影响文本、图标、Tab 顺序和辅助功能语义。
