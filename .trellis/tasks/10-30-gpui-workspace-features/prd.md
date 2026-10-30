# 项目树 / 文件 / Git / 历史

> 父任务：`.trellis/tasks/10-30-gpui-native-migration`（先读其 `prd.md`、`design.md`、`implement.md`）。
> 已确认约束：`gpui-pre 0.3`（Zed 2026-09 快照）、GPU 原生渲染、界面单进程（保留 PTY daemon 与 web-daemon，见父 design §0.1）、仅预览（Markdown 文件 / HTML / PDF）按需嵌入系统 WebView。
> 详细设计见本目录 `design.md`，执行步骤见 `implement.md`。

## 目标
在 GPUI 中对齐四个主路径域：项目树（分组/拖拽/外观/Worktree/冲突解决）、文件树与编辑/预览入口、Git（状态/暂存/提交/引用/Hunk Diff/PowerTools）、历史（虚拟列表/搜索/收藏/转录/编辑审计）。

## 依赖
`gpui-terminal-native`（项目 → 打开终端）、`gpui-rich-content-host`（原生编辑器、原生 Markdown、预览）。

## 范围
对应 `src/features/{projects,files,git,history}`，数据访问全部走 core / core-db Repository。Diff 使用原生虚拟列表 + tree-sitter 高亮；冲突解决使用原生三栏视图；历史转录使用原生 Markdown；文件树中的 `.md`/`.html`/`.pdf` 通过 PreviewHost 预览。

## 验收标准
- [ ] 每个域对照父 design §9 逐项勾选对齐，每项附验证记录。
- [ ] Worktree 维度：主仓 / Worktree 子目录 / Worktree 已删除 / `.git` 是文件，四种情况均正确。
- [ ] Git 大仓库（≥ 5,000 个变更文件）列表与 Diff 滚动流畅，不阻塞主线程。
- [ ] 历史列表 ≥ 10,000 条时虚拟滚动流畅，搜索不阻塞 UI；浏览历史转录全程不创建 WebView。
- [ ] 在 GPUI 版与 Tauri 版之间切换后，项目、收藏、标题、星标数据一致。

## 性能优化（P1 Git/文件侧、P4、P5）
详见父任务 `research/perf-opportunities.md`。
- [ ] P1：Git 面板与文件树由 `features/git/watcher.rs`、`infrastructure/files/file_watcher.rs` 的事件驱动刷新；只有 watcher 失效（网络盘、部分 WSL 路径）时才退回定时刷新，并在日志中记录原因。
- [ ] P4：本地仓库在 watcher 给出变化路径时执行 `git status -- <paths>` 增量查询；分支、HEAD、ahead/behind 用 git2 读取，不启动子进程；WSL 路径继续使用 CLI。
- [ ] P4：Diff 只为可见文件按需计算；语法高亮结果按 blob id 缓存。
- [ ] P4：验收：5,000 个变更文件的仓库中修改单个文件后，面板刷新 ≤ 200 ms，且不触发全量 `git status`。
- [ ] P5：实时转录改为共享一个按目录聚合的 notify watcher + tokio 任务，取代每个文件一个线程的 sleep 循环（`history/live_transcript.rs:100-125`）。
- [ ] P5：按文件记录读取偏移，只解析新追加的 JSONL 内容；首次全量扫描使用有界并发（≤ CPU 核数的一半）。
- [ ] P5：验收：同时监听 20 个转录文件时，额外线程数不随文件数增长；追加一行后 UI 更新 ≤ 300 ms。
