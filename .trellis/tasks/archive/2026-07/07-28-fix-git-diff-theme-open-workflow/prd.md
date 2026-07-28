# 修复 Git Diff 主题与打开流程

## Goal

修复 Git Diff 弹框与固定编辑器视图的主题、工具栏和打开流程缺陷，使两种视图都与终端主题一致，并让用户持久选择默认打开方式与代码换行方式。

## Background

- `GitDiffEditorHost` 已请求终端主题，但 `diffViewer.css` 在 `.diff-viewer-container` 和全局应用明暗主题选择器中重新声明固定颜色，覆盖了父级终端变量。
- `GitDiffToolbar` 的图标按钮主要依赖继承色，缺少明确的默认、hover 和 selected 对比；原生下拉框未声明终端主题色调。
- `GitChangesPanel` 的查看源文件回调只打开文件，不关闭 Review Dialog；固定操作只打开当前标签，不记录后续文件的打开策略。
- Hunk 容器使用 `rounded-lg border shadow-sm`，在浅色内容区形成明显黑框。
- `react-diff-view` 默认强制 `pre-wrap + break-all`，当前没有用户可控的“不换行 + 横向滚动”模式。

## Requirements

1. Review Dialog 与固定编辑器 Diff 必须使用当前终端主题的背景、前景、弱文本、边框、强调色和增删语义色；应用主题与终端主题明暗不同时也不能串色。
2. 工具栏图标、Split/Unified、空白模式、上下文行数、Pin、回滚和关闭按钮必须具备清晰的默认、hover、pressed、disabled 与 focus-visible 状态。
3. 移除 Diff 内容区的圆角黑色外框和装饰阴影；Hunk 内部分隔线继续使用主题边框色。
4. 新增持久化 `gitDiffWrapLines` 偏好，默认 `true` 以保持现有行为。工具栏提供可访问的换行切换按钮：
   - 开启：代码允许自动换行。
   - 关闭：代码保持单行、禁止强制断词，内容溢出时显示可用的横向滚动条。
   - Split 关闭换行时左右代码列保持等宽、中线固定，单一横向滚动条同步移动两侧内容。
   - Split/Unified、弹框/固定页和大 Diff 虚拟列表均使用同一偏好；切换后重新测量虚拟 Hunk 高度。
5. 查看源文件成功后关闭 Review Dialog；打开失败时保留 Dialog 并显示现有错误 toast。
6. 新增持久化 `gitDiffOpenMode: "dialog" | "editor"`，默认 `dialog`：
   - 在弹框点击“固定到编辑器”成功后设为 `editor`。
   - 后续点击任意 Git 变更文件时直接打开或激活对应 Diff 编辑器标签。
   - 固定页 Pin 按钮显示选中状态；再次点击只把后续默认方式恢复为 `dialog`，不强制关闭当前标签。
7. 新偏好进入 `preferences` 同步域，非法或缺失旧值回退默认值。
8. 新增和修改的用户文案同步 `zh-CN` 与 `en-US`；`zh-TW` 继续使用现有派生机制。
9. 本地 Windows/Linux/macOS、WSL 与 SSH 共用前端行为，不修改 Transport、Tauri command、SSH Agent 协议或文件类型支持。

## Scenario Matrix

- 应用亮/暗主题 x 终端亮/暗主题。
- 弹框 / 固定页；Split / Unified；换行 / 不换行。
- 短行 / 超长行 / 大 Diff Worker 与虚拟 Hunk。
- 默认弹框 / Pin 后默认编辑器 / 固定页恢复默认弹框。
- 查看源文件成功 / 文件在异步期间消失或打开失败。
- 本地 / WSL / SSH；根仓库 / 嵌套仓库；Workspan 与项目切换。

## Acceptance Criteria

- [ ] 用户截图中的白色 Diff、深色工具栏混搭消失，弹框与固定页均匹配终端主题。
- [ ] 工具栏和下拉控件在终端亮暗主题中可辨识，焦点和选中状态不只依赖颜色。
- [ ] 内容区不存在圆角黑色外框或装饰阴影。
- [ ] 换行开关默认开启并持久化；关闭时长行不换行、Split 中线固定，且单一横向滚动条同步移动左右内容。
- [ ] 换行切换不会破坏虚拟 Hunk 测量、键盘定位、行选择或回滚。
- [ ] 查看源文件成功关闭弹框，失败保留弹框。
- [ ] Pin 成功后后续文件直接走编辑器；固定页可恢复默认弹框方式。
- [ ] 设置迁移、同步、中英文、架构边界和 300 行职责审查通过。
- [ ] TypeScript、生产构建和全部 Git Diff 定向测试通过。

## Out of Scope

- 不修改 Git Diff 文件类型、二进制策略、Transport 或后端协议。
- 不新增设置页面；打开方式和换行方式由 Diff 工具栏直接控制。
- 不重构整个 `GitChangesPanel` 或文件编辑器体系。

## Risk

- `Settings` 的 GitNexus upstream 影响为 CRITICAL：69 个直接依赖、181 个传递依赖。必须补齐默认值迁移、同步穷尽映射和回归测试。
- 当前 GitNexus 分支索引无法解析新 Diff 组件符号，相关 UI 触点使用 Git Diff Viewer 契约、fast-context 与精确搜索降级发现。
