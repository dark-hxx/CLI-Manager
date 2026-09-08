# Viewer Foundation Design

## Module Responsibilities

- `diff/types.ts`：目标、数据源、能力和解析类型。
- `diff/useGitDiffController.ts`：加载、取消、解析、选择和重载。
- `diff/GitDiffViewer.tsx`：组合 Header、Content、SelectionBar。
- `diff/GitDiffContent.tsx`：loading/error/empty/parsed/fallback 状态。
- `diff/GitDiffSelectionBar.tsx`：选中数量与批量回滚命令。
- `DiffViewerModal.tsx`：Portal、Dialog 生命周期和兼容导出。

## Data Source

```ts
type GitDiffDataSource =
  | { kind: "snapshot"; content: string }
  | { kind: "live"; load: (target: GitDiffTarget) => Promise<GitFileDiffPayload> };
```

写操作作为 live source 的独立 capability 注入。Controller 只调用 capability，不知道 Transport。

## Compatibility Strategy

现有导出名称保持不变，先通过兼容适配器迁移全部调用方；所有调用方完成后再删除旧 optional props。历史和终端统计传入 snapshot，Git 面板与文件编辑器传入 live。

## Size Guard

React 组件、Hook、类型和适配器不得混为单文件。300 行为强制职责审查阈值，不以拆出无语义 `utils.ts` 的方式规避。
