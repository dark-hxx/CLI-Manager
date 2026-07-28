# 实现 Git Diff 导航与显示工具栏

## Goal

在默认 Diff 弹窗中提供 JetBrains 风格的高频审阅导航和显示控制，减少关闭弹窗、重新定位文件和手工滚动。

## Changelog Target

`[TEMP]`

## Requirements

- 顶部工具栏展示仓库相对路径、状态、当前文件序号和 `+/-` 统计。
- F7 跳到下一 Hunk；文件末尾进入当前筛选结果的下一文件；Shift+F7 反向。
- 首尾不循环，按钮禁用并给出状态提示。
- 提供 Split/Unified 分段控制，默认 Split，选择持久化到 settings 并参与偏好同步。
- 提供“打开源文件”和“固定到编辑器”按钮；删除文件禁用源码跳转。
- 当前导航列表采用 Git 面板当前筛选后的文件顺序，状态刷新时按 target id 对齐。
- 快捷键仅在 Diff Dialog 获得焦点时生效，不污染终端或其他窗口。

## Acceptance Criteria

- [x] F7/Shift+F7 可连续跨 Hunk 和文件导航，首尾行为明确。
- [x] Split/Unified 切换不重载 Diff，重开应用后保持用户选择。
- [x] 源码跳转定位到当前 Hunk 的新文件起始行。
- [x] 文件被刷新移除时选择相邻目标，不对已不存在目标执行操作。
- [x] 弹窗窄于 768px 时工具栏不溢出或遮挡标题。
- [x] 新文案在中文、英文下均正确。

## Out of Scope

- 不增加空白忽略、上下文行数、搜索或可编辑 Diff。
