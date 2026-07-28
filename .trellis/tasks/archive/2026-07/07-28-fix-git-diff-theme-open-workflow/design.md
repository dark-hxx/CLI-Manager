# Git Diff 主题与打开流程设计

## 1. Responsibility Boundaries

- `theme.ts`：Diff 终端主题 CSS 变量映射。
- `diffViewer.css`：react-diff-view 结构样式、应用/终端主题作用域和换行规则。
- `GitDiffViewer`：选择主题模式和组合 Viewer，不拥有文件打开策略。
- `GitDiffToolbar`：展示视图偏好和命令状态。
- `GitDiffReviewDialog`：Review 生命周期与当前目标。
- `GitChangesPanel`：决定弹框或编辑器打开意图，并编排现有 stores。
- `settingsStore`：持久化 `gitDiffOpenMode` 与 `gitDiffWrapLines`，不保存当前标签或 Transport。

## 2. Theme Contract

`GitDiffViewer` 在根节点标记 `data-git-diff-theme="terminal|application"` 和换行状态。终端模式由 `TERMINAL_DIFF_ROOT_STYLE` 覆盖完整的 surface/text/semantic tokens，并根据真实终端主题设置 `color-scheme`。

`diffViewer.css` 不再让全局 `[data-theme="light"]` 无条件覆盖终端模式。应用主题的固定 Diff token 只作用于 `data-git-diff-theme="application"`；终端模式从根节点继承动态变量。

## 3. Line Layout

```text
gitDiffWrapLines=true
  -> table-layout: fixed
  -> white-space: pre-wrap
  -> overflow-wrap/word-break enabled

gitDiffWrapLines=false
  -> Split uses fixed gutter + equal minmax(0, 1fr) code tracks
  -> white-space: pre
  -> overflow-wrap/word-break disabled
  -> GitDiffContent owns one horizontal scrollbar
  -> the scrollbar writes one scrollLeft to all mounted code cells
```

代码单元格裁剪自身溢出，但通过统一的内容轨道保持相同可滚动宽度；Split 中线不参与横向滚动。虚拟 Hunk 新挂载和容器缩放时重新应用当前偏移，换行状态变化后调用 virtualizer measurement。

## 4. Open Workflow

```text
file click
  -> gitDiffOpenMode=dialog -> open Review Dialog
  -> gitDiffOpenMode=editor -> reuse existing pinned-tab workflow

Dialog Pin
  -> open/activate current Diff tab succeeds
  -> persist gitDiffOpenMode=editor
  -> close Dialog

Pinned Pin toggle
  -> persist gitDiffOpenMode=dialog
  -> keep current tab open

Open source
  -> existing file reveal succeeds -> close Dialog
  -> fails -> keep Dialog + existing toast
```

所有编辑器写操作继续通过目标自身的 Transport lease；打开模式只决定 UI 宿主，不改变 Git 数据路径。

## 5. Compatibility

- 缺失/非法设置迁移为 `dialog` 和 `true`。
- Snapshot consumers 保持 application theme 和只读能力，除非调用方显式选择 terminal theme。
- 本地、WSL、SSH、根仓库和嵌套仓库复用既有 target identity 与 pinned workspace。
- 不新增依赖、RPC、capability 或文件类型。

## 6. Test Strategy

- 静态架构测试锁定主题选择器作用域、职责文件行数和无环境判断。
- 设置测试覆盖默认值、非法迁移和同步分类。
- 打开流程测试覆盖 source 成功关闭、失败保留、Pin 后路由和恢复 dialog。
- 换行测试覆盖 CSS 契约、横向 overflow ownership 和 virtualizer remeasure。
- 最终执行 TypeScript、生产构建和全部 Git Diff 定向测试。
