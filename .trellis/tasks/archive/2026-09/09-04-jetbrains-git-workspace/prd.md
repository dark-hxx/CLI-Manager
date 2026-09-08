# JetBrains 风格 Git 工作区

## Goal

把当前仅能在终端右侧窄面板中浏览的 Git 历史升级为独立工作区：用户从项目侧栏左下角的 Git 图标进入，按 JetBrains Git Log 的信息结构查看仓库引用、彩色提交拓扑、提交详情和文件 Diff，同时保留终端进程及现有 Git 变更能力。

## Requirements

### Entry And Lifecycle

- 项目侧栏底部提供 Git 图标，并显示明确的选中状态和中英文 tooltip/aria-label。
- 点击后在主内容区打开 Git 工作区；再次点击或点击关闭按钮返回终端，终端、分屏、Workspan 和进程状态不得被销毁。
- 没有可用项目、非 Git 项目、SSH Agent 不支持 Git 时必须显示可操作的空态或升级提示。
- 现有终端工具栏 Git 入口继续可用，不产生第二套独立 Git 数据状态。

### Workspace Layout

- 顶部提供“日志 / 变更”视图切换及刷新、仓库选择、搜索等操作。
- 日志视图采用可调整的三栏结构：左侧引用树，中间提交表格，右侧提交详情与变更文件。
- 左侧至少展示当前分支、本地分支和按 remote 分组的远程分支；标签在数据源支持时展示。
- 中间提交行展示作者、彩色拓扑、提交标题、引用标签和 24 小时制时间。
- 右侧在未选择提交时显示空态；选中提交后显示元数据和文件列表，文件点击复用现有只读 Diff Viewer。

### Graph And Loading

- 依据完整提交 ID 与 parent IDs 计算稳定的 DAG lane；普通提交、分叉、双亲 merge、根提交均须正确绘制。
- 同一 lane 在相邻行保持稳定颜色；选中行不能造成 graph 或列宽跳动。
- 保留每批 50 条的后端游标协议，在前端以连续加载呈现；跨批次 lane 状态不得断裂。
- 搜索结果缺失中间提交时不得伪造父子连接；未解析边必须使用明确的中断表现。

### Compatibility

- 本地 Windows/macOS/Linux、WSL、Worktree、嵌套仓库和 SSH 项目共享同一前端工作区与布局算法。
- SSH 根仓库空 repository id 继续合法；旧 SSH Agent 缺少历史能力时在写请求前拒绝并显示升级提示。
- 变更和历史 Diff 继续遵守共享 Viewer 的只读/可写边界，不新增第二套 Diff 实现。
- 用户可见文案同步支持 `zh-CN` 与 `en-US`，英文界面时间仍为 24 小时制。

## Scenario Matrix

- 窗口：前台、后台后返回、最小化恢复。
- 侧栏：展开、折叠、紧凑模式；Git 图标始终可访问且不挤压底部按钮。
- 会话：无会话、单会话、多会话、不同 Workspan、深层分屏中的活动会话。
- 项目：普通目录、根仓库、嵌套仓库、主 Worktree、linked Worktree（`.git` 为文件）、目录已删除。
- 环境：本地 native、WSL Linux 文件系统、WSL `/mnt` 回退 native、SSH 新旧 Agent。
- 历史：空仓库、detached HEAD、浅克隆、线性历史、多分支、多 merge、大量 refs、多页历史、搜索无结果。
- 状态：快速切项目/仓库/分支、请求迟到、Diff 加载中关闭工作区、Git 写操作后刷新。

## Acceptance Criteria

- [ ] 左下角 Git 图标可打开/关闭独立工作区，返回终端后原会话状态保持不变。
- [ ] 日志工作区具备引用树、提交拓扑表格和提交详情三栏，并可调整侧栏宽度。
- [ ] 拓扑夹具覆盖线性、分叉、merge、根提交和跨 50 条边界。
- [ ] 分支/仓库/搜索/transport 变化会重置正确上下文，旧请求不会覆盖新页面。
- [ ] 选中文件通过现有共享 Diff Viewer 打开，历史 Diff 保持只读。
- [ ] 本地和 WSL Rust 测试、SSH Agent 测试、前端逻辑测试、TypeScript、Cargo check 与生产构建通过。
- [ ] 新增 UI 文案在中英文下均完整，时间均为 24 小时制。

## Out Of Scope

- 不复制或依赖 Rebased/IntelliJ 的实现代码。
- 不在本任务增加 rebase/cherry-pick/reset 等新的 Git 写操作。
- 不改变现有 Diff 大小上限、Patch 回滚规则或 Git 凭证策略。
