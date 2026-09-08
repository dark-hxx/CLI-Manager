# Self Review

## Scope

- 任务：`拆分 Git Diff 查看器职责`
- 风险：CRITICAL。GitNexus 识别 3 个直接调用方、7 个受影响符号和 5 条消费流程。
- 结论：改动仅重组前端 Viewer 边界；Git Transport、本地/WSL/SSH 后端协议和用户可见行为未改变。

## Discovery List

- [x] `GitChangesPanel`：继续通过 `DiffViewerModal` 注入 live load/revert actions。
- [x] `FileEditorPane`：显式注入本地/WSL live load/revert actions，移除 Viewer 隐式 Tauri fallback。
- [x] `history/DiffModal`：继续使用 snapshot content，不获得写能力。
- [x] `TerminalStatsPanel`：继续使用 snapshot modal，不获得写能力。
- [x] `SessionReplayPanel` / `HistoryWorkspace`：属于历史 Diff 间接流程，兼容导出保持不变。
- [x] `gitStore` / `GitTransport`：确认不修改。
- [x] Desktop/SSH Agent Git backend：确认不修改。

## Findings And Fixes

1. 现代调用方若传入内联 `target` 对象，加载 effect 可能被无意义重复触发。
   - 修复：Controller 按 target 字段建立稳定引用，旧请求仍通过 cleanup 丢弃。
2. 文件编辑器初版回调依赖整个 project 对象，Store 非路径更新也可能触发 Diff 重载。
   - 修复：回调只依赖稳定 `projectPath`。
3. 显式 mutation 适配后两个路径参数未使用，类型检查失败。
   - 修复：标记为有意忽略的 `_filePath`，保持兼容签名。

## Verification

- [x] `npx tsc --noEmit`
- [x] `node --test scripts/gitDiffViewerArchitecture.test.mjs scripts/gitStoreRemote.test.mjs`
- [x] `git diff --check`
- [x] 视图模块无 `@tauri-apps/api/core`、SSH 或环境判断。
- [x] 所有新增 Diff 模块均少于 300 行且按职责命名。

未启动 Tauri 桌面应用；最终父任务验收文件将保留 Windows/Linux/macOS 与 SSH 的人工验证矩阵。
