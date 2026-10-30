# 设计：项目树 / 文件 / Git / 历史

> 上游：父 `design.md` §9；shell-foundation（模型、ui_kit、Keymap）；terminal-native（`open_terminal`、TerminalModel）；rich-content-host（原生 Markdown、CodeEditor、冲突三栏、PreviewHost）；core-extraction（Repository、CoreEvent）。
> 原则：业务逻辑全部在 core；GPUI 侧只有视图与视图状态。React 端行为是验收基准（逐组件对照）。

## 1. 项目树（`src/features/projects`，约 1.3 万行）

| React 组件/模块 | GPUI 实现要点 |
|---|---|
| `Sidebar`/`SidebarView`/`SidebarHeader`/`SidebarFooter` | 侧栏容器；展开/折叠/紧凑嵌入三种形态（UiModel）；同步状态指示 |
| `ProjectTree`/`TreeNodeItem`/`TreeContext` | `ui_kit::Tree` + 虚拟化；分组/项目两级（含嵌套分组规则以 TS 为准）；键盘导航；多选（如有） |
| 拖拽（dnd-kit） | GPUI `on_drag`/`on_drop`：项目↔分组移动、排序；落点高亮规则与 TS 一致；写 ProjectRepo/GroupRepo（排序字段） |
| `PinnedProjectSection` | 置顶区 |
| `NodeAppearancePanel` | emoji/颜色/图标选择；emoji 数据从前端依赖导出为 JSON 资产 |
| `ConfigModal`、`ShellSelect` | 项目配置表单（shell、startupCmd、env、hook 相关）→ ProjectRepo |
| `GroupEditDialog`、`NewGroupRow` | 分组增改 |
| `BatchShellDialog` | 批量对多个项目打开终端/执行命令 → terminal-native 的 `open_terminal` |
| `WorktreeRecoveryNotice`、`worktreeStore` | Worktree 列表、创建/删除、已删除恢复提示；core::git::worktree |
| `conflicts/*`（`WorktreeConflictWorkspace`、`ConflictFileList`、`ConflictPaneLayout`、`ConflictFileConfirmation`） | 文件列表 + rich-content-host 冲突三栏视图 + 确认流程 |
| `SyncedHistoryList` | 同步来的历史条目入口（对接 HistoryModel） |
| `useSidebarController` | 拆为 ProjectModel 方法 + 视图事件 |

- 项目点击/双击/右键菜单动作与 TS 一致（打开终端、在资源管理器中打开、复制路径、配置、删除、Worktree 操作…），菜单项清单在实施第一步从 TS 导出对照表。
- Worktree 四种状态：主仓 / Worktree 子目录 / Worktree 已删除 / `.git` 是文件 → 统一由 core 判定，视图只显示结果。

## 2. 文件（`src/features/files`）

| React | GPUI |
|---|---|
| `FileExplorerSidebar`、`fileExplorerStore` | 惰性加载目录树（展开时读取），虚拟化；忽略规则（.gitignore 选项）与 TS 一致；文件操作（新建/重命名/删除/复制路径/外部打开） |
| `useGitFileDecorations` | Git 状态着色：订阅 GitModel |
| `FileEditorPane*`、`FileEditorTabs`、`FileEditorHeader`、快捷键与搜索导航 | 多标签编辑：`ui_kit::CodeEditor`；脏标记、保存、关闭确认；外部修改检测（watcher 事件 → 提示重新加载） |
| `FileEditorContent` 的 Markdown/HTML 预览 | 编辑/预览切换：`.md` 预览走 PreviewHost（降级为原生 Markdown）；`.html` 预览走 PreviewHost/Live Server；新增 `.pdf` 预览；图片文件原生 `img` 显示 |
| `LiveServerMenuItems`、`liveServerClient` | Live Server 启停（core::files::live_server）+ 预览入口 |
| `ProjectFileRefreshController`（15 s 轮询） | P1：watcher 事件驱动（`ProjectFilesChanged`），watcher 失效时退回定时刷新并记录日志 |

## 3. Git（`src/features/git`，约 1.2 万行）

| 区域 | React | GPUI |
|---|---|---|
| 变更列表 | `GitChangesPanel`、`GitChangesTree`、`GitTreeNode`、`StageCheckbox` | 树/列表两种视图；暂存/取消暂存/丢弃；虚拟化（≥ 5,000 文件）；P1 watcher 驱动 |
| Diff | `diff/*`（`GitDiffViewer`、`HunkList/HunkBlock`、`Gutter`、`SelectionBar`、`Toolbar`、`ReviewDialog`、`gitDiffParser(.worker)`、`gitDiffVirtualization`、`reviewNavigation`、`useGitDiffHorizontalScroll`） | 原生 Diff 视图：后台线程解析 → 行模型 → 虚拟列表；统一/并排两种模式；行级/Hunk 级选择暂存；横向滚动；评审导航（上/下一处变更、文件间跳转）；tree-sitter 高亮按 blob id 缓存（P4） |
| 提交 | 提交框、AI 生成选项（`GitDiffGenerationOptions`） | 提交信息编辑（`ui_kit::TextArea`）；生成提交信息走 core 现有命令 |
| 历史 | `GitHistoryView`、`workspace/GitLogTable`、`gitGraphLayout`、`GitCommitDetails`、`GitChangedFilesTree` | 提交图：移植 `gitGraphLayout.ts` 为纯函数（附测试），自绘 lane；日志表虚拟化；提交详情 + 文件树 + Diff |
| 引用 | `GitRefTree`、`GitCompareDialog` | 分支/标签/远程树；比较两个引用 |
| PowerTools | `GitPowerToolsDialog` | 逐项移植（stash、reset、cherry-pick 等以 TS 为准） |
| 传输 | `lib/gitTransport.ts`（48 个 invoke） | 直接调用 core::git 函数；WSL 路径分支与 TS 一致 |

### P4 增量刷新设计
- watcher（`features/git/watcher.rs`）事件携带变化路径（core-extraction 已在 `GitChanged` 中加入 `paths`）。
- core 新增 `git::status_incremental(repo, paths)`：本地仓库执行 `git status --porcelain=v1 -z -- <paths>`（路径数 > 200 或含 `.git/` 内部变化 → 全量），结果与缓存合并；HEAD/分支/ahead-behind 用 git2 读取；WSL 路径保持全量 CLI。
- 启用 `core.untrackedCache`：仅在仓库已显式启用或用户在设置中允许时设置（不擅自修改用户仓库配置；默认只读检测，给出建议）。
- 缓存位置：GitModel 内存，按仓库路径分片；Diff 高亮缓存 LRU（按 blob id）。

## 4. 历史（`src/features/history`，约 1.5 万行）

| React | GPUI |
|---|---|
| `HistoryListPane`、`historyStore`（直连 SQL） | 虚拟列表（≥ 10,000 条）；筛选（来源/项目/时间/收藏）；排序；HistoryMetaRepo、MessageStarRepo、GeneratedTitleRepo |
| `SearchHitsPanel` | 全文搜索（core::history::search，后台执行，可取消；结果高亮） |
| `SessionDetailPane` + 视图：`SessionTimelineView`、`SessionCanvasView`(+`sessionCanvasModel`)、`SessionContextView`、`SessionFileChangesView`、`SessionStatsPanel`、`SessionSubtaskTreeView`、`SessionToolDiagnosticsView` | 详情页多视图 Tab；转录用原生 Markdown（`HistoryMarkdownContent`、`sessionTranscriptHighlighter` 规则移植）；Canvas 视图用 GPUI canvas 自绘（`sessionCanvasModel.ts` 移植为纯函数）；文件变更视图复用 Diff 组件 |
| `MetaEditor`、`EditAuditModal` | 标题/标签编辑、编辑审计（HistoryEditAuditRepo） |
| `HistoryResumeProjectDialog` | 选择项目后恢复会话 → terminal-native |
| 实时转录（`live_transcript.rs`）、子代理转录（`subagent_transcript.rs`） | 订阅 `SubagentTranscriptAppend` 等事件增量追加 |

### P5 共享 watcher + 增量尾读
- core 新增 `TranscriptWatcher`：一个 `notify` watcher 按目录注册（同目录多个文件共享），事件经 tokio 任务分发；取代每文件一个线程 + 100 ms sleep 的循环（`history/live_transcript.rs:100-125`）。
- 每个文件维护 `TailState { offset, len, mtime, inode/file_id }`：追加 → 从 offset 读取到最后一个完整换行；截断/替换（长度变小或 file_id 变化）→ 从头重读并发出 reset。
- 首次全量扫描有界并发（≤ 核数一半，低于终端解析线程优先级）。
- 在 poc-gates 对 `scan_state.rs` 的核实结论基础上扩展，不另起一套。
- Tauri 版同样受益（core 共享），需要回归 Tauri 版的实时转录。

## 5. 公共组件
- 虚拟列表、树、Diff 视图、提交图在本任务内实现为 `ui_kit` 级可复用组件（Diff 也被历史文件变更视图使用）。
- 右键菜单、拖放、键盘导航遵循 shell-foundation 约定。

## 6. 场景清单（实施时逐项验证）
- Worktree 四态；WSL 仓库（路径 `\\wsl$\...`）；网络盘（watcher 失效回退）；超大仓库（≥ 5,000 变更）；二进制文件 Diff；LFS 指针；子模块；空仓库（无 HEAD）。
- 历史：Claude/Codex/OpenCode 多来源；外部会话同步开/关；同步来的历史；10,000+ 条；转录 > 5 MB。
- 文件：只读文件、无权限目录、超大文件、非 UTF-8 编码、CRLF、符号链接。
- 双壳：项目排序、分组、收藏、星标、标题、编辑审计在 Tauri ↔ GPUI 切换后一致。
