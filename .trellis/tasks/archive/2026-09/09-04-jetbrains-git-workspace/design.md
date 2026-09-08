# JetBrains 风格 Git 工作区设计

## Architecture

### Workspace State

- 新增轻量 `gitWorkspaceStore`，仅保存 `isOpen`；仓库数据继续由现有 Git transport/store 和组件生命周期管理。
- `SidebarFooter` 负责入口；`TerminalTabs` 负责依据当前活动会话解析项目上下文并在 terminal well 上方挂载 `GitWorkspace`。
- 打开 Git 工作区时关闭互斥的历史全屏工作区和窄 Git 面板，但不关闭 PTY、SSH bridge、分屏或 Workspan。

### Workspace Composition

- `GitWorkspace`: 顶层生命周期、项目/transport lease、仓库选择和视图切换。
- `GitRefTree`: 本地/远程引用层级、搜索、当前项高亮。
- `GitLogTable`: 连续加载、列布局、选择和虚拟化边界。
- `gitGraphLayout`: 无 DOM 的纯函数，根据 ordered commits 生成 node、vertical segment 和 curve edge。
- `GitCommitDetails`: 提交元数据及文件列表；文件 Diff 通过 `DiffViewerModal`/共享 controller 加载。
- 现有 `GitChangesPanel` 在“变更”标签内复用，避免复制暂存、提交和网络操作。

## Data Flow

1. Footer 切换 `gitWorkspaceStore.isOpen`。
2. `TerminalTabs` 从活动 session/worktree 解析当前 project/path，挂载 `GitWorkspace`。
3. Workspace 通过 `useGitTransportLease` 获得 Local/WSL/SSH transport。
4. `listRepositories` 决定有效 repo；`listBranches` 填充引用树；`listCommits` 逐批追加历史。
5. layout 纯函数对已加载连续 commit 序列计算 lanes；下一批追加后从相同序列重算，保证边界连续且结果确定。
6. selection 只触发 `getCommitDetail`；文件点击按需触发 `getCommitFileDiff`。

## Graph Algorithm

- `activeLanes` 保存当前行之前仍待解析的 commit IDs。
- 当前 commit 命中 lane 后，以第一 parent 继承该 lane，额外 parents 插入相邻 lane；不存在时追加新 lane。
- 每行记录 before/after lane IDs，并由二者生成直线或二次曲线路径。
- 相同 commit ID 去重，已无后续目标的 lane 回收；颜色由 lane identity 的稳定哈希映射到固定高对比 palette。
- 缺失于当前连续结果的 parent 保留出界 continuation；搜索模式不跨不可见提交直接连接。

## UI Decisions

- 工作区使用应用现有 quiet operational theme，不照抄 JetBrains 像素和配色。
- 默认左栏约 240px、右栏约 320px，均提供稳定 min/max 和拖拽宽度；中栏不低于可读宽度。
- 提交行使用固定高度和列宽，不因 hover、refs 或 loading 改变布局。
- 小窗口下右侧详情可折叠到中栏下方；引用树可收起，避免内容重叠。

## Compatibility And Failure Handling

- 保留 `GitCommitPage` 的 50 条 cursor 契约，不一次读取完整仓库。
- generation/context key 隔离 transport、repo、search 的迟到结果。
- SSH capability 缺失沿用现有 `ssh_agent_capability_missing:gitHistory` 映射。
- branch tree 第一阶段消费现有 local/remote branches；tag 来源仅从可用 refs 暴露，不改变 checkout 写操作边界。
- 非 Git、路径删除、transport acquisition 失败分别渲染空态，不退回本地 Git 读取 SSH 路径。

## Test Strategy

- 纯函数测试：线性、分叉、merge、重复 parent 防御、跨页追加、缺失 parent、确定配色。
- 组件/静态测试：入口接入、共享 Diff 使用、无新增直接 IPC、i18n key 完整。
- 现有 Rust/Agent history tests 回归，确保 wire contract 与 50 条 cursor 未改变。
- `npx tsc --noEmit`、相关 Node test、`cargo check`、`cargo test` 定向集、`npm run build`。
