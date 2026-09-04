# JetBrains 风格 Git 工作区实施计划

## 1. Gates And Baseline

- [x] 用户确认 JetBrains 风格独立 Git 工作区方案。
- [x] 当前分支 `feat/git-history` 工作区干净，领先上游 1 个已提交修复。
- [x] 阅读 feature scenario matrix、Git history contract、Git Diff Viewer contract。
- [x] 对所有拟修改符号执行 upstream impact，HIGH/CRITICAL 在编辑前报告。
- [x] 启动 Trellis task。

## 2. Entry And Lifecycle

- [x] 新增 Git workspace open/close store。
- [x] 在 SidebarFooter 增加左下角 Git 入口和选中状态。
- [x] TerminalTabs 挂载独立工作区并保持终端/分屏/Workspan 存活。
- [x] 与历史工作区、窄 Git panel 的互斥状态保持一致。

## 3. Workspace UI

- [x] 新增 GitWorkspace 顶层和日志/变更标签。
- [x] 接入现有 transport lease、仓库枚举和有效项目路径。
- [x] 新增引用树，支持 local/remote 分组、引用筛选和当前分支高亮。
- [x] 新增可调整三栏布局及小窗口水平滚动降级。

## 4. Commit Graph And Details

- [x] 新增纯函数 DAG lane 布局与覆盖线性/分叉/merge/边界的测试。
- [x] 提交表格绘制稳定彩色 SVG 拓扑，展示作者/标题/refs/24 小时时间。
- [x] 将 50 条 cursor 分页包装为连续加载，并保持跨批次 graph 连续。
- [x] 右侧接入提交详情和文件列表，文件点击复用只读 Diff Viewer。
- [x] 搜索和上下文切换使用 generation 隔离，隐藏提交不产生错误连线。

## 5. Records And Verification

- [x] 更新 `CHANGELOG.md` `[TEMP]`、`docs/功能清单.md` 和必要 Git contract。
- [x] 刷新代码索引并执行变更影响检查。
- [x] 运行前端逻辑测试、TypeScript、Rust/Agent 定向测试、Cargo check 和生产构建。
- [x] 记录手动中英文、侧栏折叠、多会话、本地/WSL/SSH 验证边界。
- [x] GitNexus `detect_changes` 不可用时记录降级，并使用 codebase-memory + Git diff 复核。
