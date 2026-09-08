# Self Review

## Scope

- 任务：`支持 Git Diff 固定到编辑器`
- 风险：CRITICAL。GitNexus staged 分析识别 35 个文件、87 个符号和 297 条潜在流程；主要来自 `terminalStore`、`fileExplorerStore` 与 Git 面板等共享路径。新增 lease 文件只有 2 个直接消费者，固定页 Host 只有 1 个直接消费者，但不能据此降低整体风险等级。
- 结论：固定页复用现有 Viewer 和 `file-editor` 伪会话；未修改 Rust/Tauri command、SSH Agent 协议或持久化 schema。

## Scenario Matrix

- [x] Windows：盘符路径大小写不敏感，`C:\\` 与 `c:/` identity 一致。
- [x] Linux/macOS：POSIX 路径保留大小写，不合并大小写不同的 Worktree。
- [x] WSL：与 local 环境 key 隔离，UNC/POSIX 路径段保留大小写。
- [x] SSH：project/host/remote path/installation 进入 lease identity，根仓库保留空 repository id。
- [x] Git 面板关闭：只释放面板 lease，固定页继续持有共享 consumer。
- [x] 嵌套仓库：repository id 进入标签 identity，同路径文件互不覆盖。
- [x] 项目/Workspan 切换：`file-editor` 复用时更新项目快照并清理旧 workspace。

## Findings And Fixes

1. 本地 lease 初版复用全路径小写归一化，可能合并 Linux/macOS 大小写不同路径。
   - 修复：独立纯函数只折叠 Windows 盘符路径，并显式区分 local/WSL；增加根路径和大小写回归测试。
2. 固定页后台刷新初版会连带刷新已打开 Git 面板，形成重复轮询。
   - 修复：只有 mutation 完成或结果不确定时才通过 `refreshIfContext` 通知面板。
3. 回滚确认打开后切换标签，初版文案会显示新标签名但操作旧标签。
   - 修复：确认文案与 mutation 均绑定最初请求的 tab id。
4. 纯身份测试初版从 Transport 工厂导入，Node 会连带解析 Tauri 运行时模块。
   - 修复：提取无运行时依赖的 `gitTransportIdentity.ts`，身份规则可独立单测。

## Verification

- [x] `npx tsc --noEmit`
- [x] 7 个 Git Diff/Git Store 测试文件，共 28 项通过。
- [x] `git diff --check`
- [x] 新增和拆分后的职责模块均不超过 300 行。
- [x] 新增用户文案同时存在 `zh-CN` 与 `en-US`，`zh-TW` 继续由简体字典生成。

未启动 Tauri 桌面应用；Windows/Linux/macOS、WSL、SSH、Workspan 和中英文切换保留在父任务最终人工验收矩阵中。
