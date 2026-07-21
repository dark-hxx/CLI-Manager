# Web 项目树与右侧抽屉改版

## Goal

重构 Web 工作台桌面布局：左侧以桌面端侧栏为交互参考展示项目树，右侧辅助区改为默认折叠的抽屉，释放主对话区宽度。

## Requirements

- Changelog Target: 不记录（用户明确要求）。
- 左侧固定展示项目上下文树，替换当前以历史会话为主的侧栏。
- 项目树使用现有 `projectContexts` 数据，按项目组织上下文，并保留当前项目选中状态。
- 项目节点视觉和展开/选中交互参照桌面端 `src/components/sidebar/ProjectTree.tsx`，不直接复用 Tauri 组件。
- 历史会话作为选中项目的下级内容展示，选择会话继续沿用现有行为。
- 右侧设备详情/能力区域改为可开合抽屉，桌面端默认折叠。
- 抽屉必须有明确的图标按钮、可访问名称和展开状态；展开时不覆盖核心输入操作。
- 移动端继续使用现有覆盖层，不引入常驻左右栏或整页横向滚动。
- 保持现有双主题、`zh-CN` / `en-US`、设备/会话/项目选择和管理操作行为。
- 不新增依赖，不修改后端协议和数据结构。

## Acceptance Criteria

- [ ] 桌面宽度下左侧显示项目树，点击项目可切换当前 `ProjectContext`。
- [ ] 项目树可展开查看该项目的历史会话，点击会话可恢复会话。
- [ ] 右侧抽屉首次进入默认折叠，可通过图标按钮展开和关闭。
- [ ] 抽屉按钮通过 `aria-expanded` / `aria-controls` 表达状态，键盘可操作。
- [ ] 抽屉折叠后主区占用剩余宽度，展开时布局稳定且输入区不被遮挡。
- [ ] 移动端历史、设备配对和管理覆盖层行为不回归。
- [ ] 浅色和深色主题下层级、边框与焦点状态清晰。
- [ ] Web TypeScript 类型检查通过。

## Notes

- 现有 Web 入口：`apps/web/src/views.tsx`。
- 现有 Web 布局样式：`apps/web/src/styles.css`。
- 桌面端参考：`src/components/sidebar/ProjectTree.tsx`、`src/components/sidebar/index.tsx`。
- Web 的 `ProjectContext` 已包含 `projectKey`、`cwd`、`branch`、`source` 和 freshness，可直接组织项目树，无需修改协议。
- 场景边界：桌面/移动视口、抽屉开/关、设备在线/离线、项目有/无历史、项目上下文切换、浅色/深色、键盘操作。
