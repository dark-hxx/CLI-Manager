# 拆分 Git Diff 查看器职责

## Goal

在不改变用户行为的前提下，将现有 Diff 查看器的加载、解析、选择、渲染、操作条和弹窗生命周期拆成可独立演进的模块。

## Changelog Target

`[TEMP]`

## Requirements

- 定义 `GitDiffTarget`、`GitDiffDataSource`、`GitDiffMutationActions` 和解析结果类型。
- 数据源使用 `snapshot | live` 判别联合，避免 optional props 组合出非法状态。
- 视图层不得直接调用 Tauri 或判断 Local/WSL/SSH。
- 保留 Git 面板、文件编辑器、历史 Diff 和终端统计四类现有消费者。
- `DiffViewerModal.tsx` 降为兼容门面；新增模块按控制器、工具栏、内容区、选择操作条拆分。
- 不新增依赖，不在本任务增加导航、显示选项或 Transport 行为。

## Acceptance Criteria

- [x] 四类消费者行为与修改前一致。
- [x] `GitDiffViewer` 不包含 `invoke`、SSH 判断或全局 Git Store 写入。
- [x] snapshot 数据源无法在类型层暴露回滚动作。
- [x] 加载目标变化会取消旧请求并清空旧选择。
- [x] `DiffViewerModal.tsx` 不再混合数据、解析和大段 JSX。
- [x] `npx tsc --noEmit` 与定向回归检查通过。

## Out of Scope

- 不改变视觉样式、快捷键、Diff 生成参数或回滚协议。
