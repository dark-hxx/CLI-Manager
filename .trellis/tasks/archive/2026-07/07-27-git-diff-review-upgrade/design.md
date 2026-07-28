# Git Diff 审阅能力统一设计

## 1. Architecture

```text
GitChangesPanel
  -> GitDiffReviewDialog
      -> GitDiffViewer
          -> useGitDiffController
          -> GitDiffToolbar
          -> GitDiffHunkList
          -> GitDiffSelectionBar
  -> pin to editor
      -> gitDiffWorkspaceStore
      -> FileEditorPane -> GitDiffEditorHost

GitDiff live source
  -> GitTransportLeaseRegistry
      -> Local/WSL GitTransport -> Tauri git_diff
      -> SSH GitTransport -> daemon Git lane -> SSH Agent git_diff
```

视图层只消费快照或注入的实时数据源，不判断本地/WSL/SSH，不直接 `invoke`。固定页不依赖全局 `gitStore` 的当前项目，避免切换面板后把旧操作发往新上下文。

## 2. Shared Contracts

```ts
type GitDiffViewMode = "split" | "unified";
type GitDiffWhitespaceMode = "exact" | "ignore-eol" | "ignore-all";

interface GitDiffOptions {
  whitespace: GitDiffWhitespaceMode;
  contextLines: 3 | 10 | 20;
}

interface GitDiffTarget {
  id: string; // projectId + repositoryId + filePath
  projectId: string;
  repositoryId: string;
  filePath: string;
  fileName: string;
  status: GitFileChange["status"];
}

interface GitFileDiffPayload {
  content: string;
  canRevertHunks: boolean;
  byteLength: number;
  lineCount: number;
}
```

`GitDiffDataSource` 使用判别联合：`snapshot` 只接收文本且无写操作；`live` 必须提供 load，写操作按后端 capability 注入。禁止继续使用一组可任意缺失的 optional props 表达状态。

## 3. State Ownership

- `GitChangesPanel`：当前筛选、文件列表和打开意图；不拥有 Diff 内部状态。
- `GitDiffReviewDialog`：当前文件、跨文件导航和弹窗生命周期。
- `useGitDiffController`：单文件加载、取消、解析、Hunk 导航、选择和重载。
- `gitDiffWorkspaceStore`：按项目保存固定 Diff 标签，不保存 Transport 或回调。
- `GitTransportLeaseRegistry`：按完整项目上下文复用 Transport；SSH lease 引用归零才释放 consumer。
- `settingsStore`：Split/Unified、空白模式和上下文行数的全局持久偏好。

## 4. File Boundaries

- `DiffViewerModal.tsx` 降为兼容导出与 Dialog 壳。
- `GitChangesPanel.tsx` 不新增 Diff 工具栏、解析或固定页实现。
- `FileEditorPane.tsx` 只组合 `GitDiffEditorHost`，不增加 Transport 和回滚实现。
- `gitStore.ts` 不保存视图状态，只绑定当前面板 Transport 并编排 Git 刷新。
- Desktop 与 SSH Agent 的 Diff 构造进入各自 `git_diff` 模块，现有巨型 `git.rs` 不继续增长。

## 5. Safety Invariants

- 所有异步结果写入前比较 `contextKey + repositoryId + targetId`，旧请求直接丢弃。
- 非 `exact` 空白模式禁用 Hunk/行级回滚；整文件回滚仍走确认。
- Diff 内容变化后清空行选择；回滚成功后重新获取 changes 和 active diff。
- 固定页关闭、项目删除、SSH Host/remote path/Agent installation 变化时释放旧 lease。
- 后端继续验证仓库相对路径、Patch 目标路径和写前状态，不信任前端 target。

## 6. Scenario Matrix

覆盖本地/WSL/SSH、根/嵌套仓库、M/A/D/R/U/??/冲突、staged/unstaged、UTF-8/非 UTF-8/二进制/超限、弹窗/固定页、分屏/Workspan、项目/分支/仓库切换、亮暗主题、中英文和窄窗口。

## 7. Compatibility

历史会话与终端统计继续使用 `snapshot` 数据源。旧 SSH Agent 继续处理默认 `gitDiff`；非默认选项通过新的 capability 和请求种类提供，不向旧 Agent 发送未知字段。
