# Self Review

## Scope

- 任务：`实现 Git Diff 导航与显示工具栏`
- 风险：CRITICAL。共享 Viewer、Git 面板入口和设置持久化属于高影响前端路径。
- 结论：导航只扩展 live Git Review；历史、终端统计和文件编辑器兼容入口保持原数据源边界。

## Scenario Matrix

- [x] Windows / Linux / macOS：路径归一化只用于 target identity 与项目相对源码路径，不调用平台 API。
- [x] WSL：反斜杠和正斜杠统一参与 target identity，源码跳转继续走文件 Store 能力。
- [x] SSH：Diff 加载仍由 `GitTransport` 注入；Review 层没有 Tauri 或 SSH 判断。
- [x] 根仓库 / 嵌套仓库：Git 请求保留仓库相对路径，源码跳转增加仓库相对前缀。
- [x] 筛选 / 刷新：按当前渲染树顺序构建 target；目标移除时按原索引选相邻项，无目标时关闭。
- [x] 删除 / 未跟踪：删除文件禁用源码跳转；M/D 筛选排除未跟踪组。
- [x] 焦点 / 窄窗口：F7 仅绑定可聚焦 Viewer；工具栏允许换行，路径区域可收缩并截断。

## Discovery List

- [x] `GitChangesPanel`：提供筛选树、仓库上下文、Transport、源码跳转和固定页动作。
- [x] `GitDiffReviewDialog`：拥有 target 列表、刷新对齐、跨文件导航和设置接线。
- [x] `useGitDiffController`：拥有 Hunk 索引、anchor、源码行号和回滚后重载。
- [x] `GitDiffViewer` / `GitDiffContent`：处理焦点域快捷键、Hunk 步进和 Split/Unified 渲染。
- [x] `settingsStore` / `syncSettings`：默认值、非法值迁移、持久化和偏好同步。
- [x] `DiffViewerModal`：复用共享 Dialog 壳，快照与兼容调用方不获得 review 写能力。
- [x] Git Transport / Rust / SSH Agent：确认接口不修改。

## Findings And Fixes

1. 初版由 Dialog 外壳获得焦点，首次按 F7 前需要点击 Viewer。
   - 修复：Review Viewer 自动获焦；F7 仍不注册全局监听。
2. 当前文件是最后一个 target 且刷新后消失时会留下空 Dialog。
   - 修复：有过 active target 且目标列表清空时关闭 Dialog；有相邻 target 时按原索引对齐。
3. Hunk/行回滚后同一 target 仍存在时，稳定 identity 不会触发重新加载。
   - 修复：Controller 在 mutation 成功后提升加载 revision，复用既有取消旧请求逻辑重载。
4. POSIX `/` 和 Windows `C:/` 仓库根若直接去尾斜杠会丢失根身份。
   - 修复：repository identity 归一化显式保留两类根路径，并增加回归测试。

## Verification

- [x] `npx tsc --noEmit`
- [x] `node --test scripts/gitDiffReviewNavigation.test.mjs scripts/gitDiffSettings.test.mjs scripts/gitDiffViewerArchitecture.test.mjs scripts/gitStoreRemote.test.mjs`
- [x] `git diff --check`
- [x] 17 项定向测试通过。
- [x] Diff 职责模块均少于 300 行。
- [x] 新文案同时存在 `zh-CN` 与 `en-US`，`zh-TW` 继续从简体字典生成。

未启动 Tauri 桌面应用。Windows/Linux/macOS、WSL、SSH、窄窗口和中英文切换保留在父任务最终人工验收矩阵中。
