# 支持 Git Diff 固定到编辑器

## Goal

保留弹窗默认入口，同时允许用户把当前 Diff 固定到现有文件编辑器工作区，并在 Git 面板关闭后继续安全地实时审阅和回滚。

## Changelog Target

`[TEMP]`

## Requirements

- 固定页支持多文件标签、实时加载、导航、整文件/Hunk/行级回滚和现有确认流程。
- 复用 `file-editor` 伪会话，不新增 TerminalSessionKind。
- Diff 标签状态进入独立 `gitDiffWorkspaceStore`，按 project/repository/path 隔离。
- 引入引用计数的 Git Transport lease；Git 面板与固定页共享同一 SSH context。
- 固定页不得调用全局 gitStore 的当前 Transport 执行写操作。
- 项目、SSH Host、remote path 或 Agent installation 变化时旧 lease 失效并释放。
- FileEditorPane 只组合独立 Host，不承载 Transport、回滚或 Diff 数据逻辑。

## Acceptance Criteria

- [x] 默认单击仍打开弹窗，固定按钮打开/激活项目编辑器中的对应 Diff 标签。
- [x] 同一 project/repo/path 不重复创建标签，不同嵌套仓库同路径互不冲突。
- [x] Git 面板关闭后固定页仍可加载和安全回滚。
- [x] 本地、WSL、SSH 使用同一 Viewer；SSH 不回退本地命令。
- [x] 多个消费者共享一个 SSH context，最后一个释放时才关闭 consumer。
- [x] 回滚后固定页与当前 Git 面板刷新；目标不再变更时标签关闭或进入空态。
- [x] 切换项目/Workspan 不把 Diff 或操作串到其他项目。

## Out of Scope

- 不支持应用重启后恢复固定 Diff 标签。
- 不创建新的通用编辑器框架或新终端会话类型。
