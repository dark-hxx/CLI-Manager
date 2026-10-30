# 实施步骤：项目树 / 文件 / Git / 历史

> 先读：本目录 `prd.md`、`design.md`；`src/features/{projects,files,git,history}` 对应源码；core-extraction 的 Repository 对照表；rich-content-host 与 terminal-native 的公开接口。
> 前置：只读 Git 同步检查；修改 core（`git::status_incremental`、`TranscriptWatcher`）前 `impact`，Tauri 版受影响路径要回归。
> 每个域开始前：从 TS 导出“交互对照表”（菜单项、快捷键、对话框、空态/错误态文案 key），作为验收清单。

## 步骤

### 域 1：项目树（约 3 周）
1. 交互对照表；ProjectModel 写操作（增删改、排序、置顶、外观）。
2. Tree 视图 + 虚拟化 + 键盘导航；三种侧栏形态。
3. 拖拽排序/移动；右键菜单；ConfigModal/GroupEditDialog/NodeAppearancePanel/BatchShellDialog。
4. Worktree 列表与操作、恢复提示；冲突工作区（对接冲突三栏）。
5. 验证：Worktree 四态；双壳排序/分组一致；拖拽各落点。

### 域 2：文件（约 2 周）
1. 文件树（惰性加载、忽略规则、文件操作、Git 装饰）。
2. 编辑器标签页、保存/脏标记/外部修改提示、快捷键。
3. 预览入口（Markdown/HTML/PDF/图片）、Live Server。
4. P1：watcher 驱动刷新 + 失效回退；删除 15 s 轮询等价逻辑。
5. 验证：大文件、编码、只读、网络盘回退日志。

### 域 3：Git（约 4 周）
1. core：`status_incremental` + git2 轻量信息（先 `impact` `features/git/status.rs` 相关函数）；单测 + Tauri 版回归。
2. 变更列表（树/列表）、暂存/丢弃、P1 watcher 驱动。
3. Diff：后台解析、行模型、虚拟列表、统一/并排、Hunk/行选择暂存、横向滚动、评审导航、高亮缓存。
4. 提交框与生成提交信息。
5. 历史：`gitGraphLayout` 移植 + 测试、日志表、提交详情、比较、引用树、PowerTools。
6. 验证：P4 指标（5,000 变更仓库改单文件 ≤ 200 ms 且无全量 status，日志计数）；WSL 仓库；二进制/LFS/子模块/空仓库。

### 域 4：历史（约 4 周）
1. core：`TranscriptWatcher` + `TailState`（基于 M0 对 `scan_state.rs` 的结论）；替换 `live_transcript.rs` 线程模型；Tauri 版回归。
2. 列表 + 筛选 + 排序 + 收藏/星标/标题。
3. 搜索面板（可取消、后台）。
4. 详情：转录（原生 Markdown + 高亮规则移植）、时间线、上下文、文件变更（复用 Diff）、统计、子任务树、工具诊断、Canvas（`sessionCanvasModel` 移植 + 测试）。
5. MetaEditor、EditAudit、Resume 对话框。
6. 验证：P5 指标（20 个转录文件同时监听线程数不增长；追加一行 ≤ 300 ms）；10,000+ 条滚动；> 5 MB 转录；全程无 WebView 进程。

### 收尾（约 0.5 周）
- 父 design §9 对应行逐项勾选并附记录；spec 新增 `.trellis/spec/frontend/gpui-workspace-contracts.md`（Diff 行模型、增量 status 规则、TailState 规则、虚拟列表约定）；CHANGELOG、`docs/功能清单.md`。

总估时约 13–14 人周（四个域可两人并行：项目+文件 / Git+历史）。

## 验证命令

```bash
cargo test --workspace
cd src-tauri && cargo test           # core 改动对 Tauri 版的回归
npx tsc --noEmit
cargo run -p cli-manager-desktop-gpui
```

## 回退
各域独立提交、独立验收；core 侧的 P4/P5 改动单独提交，出现 Tauri 版回归可单独 revert（GPUI 侧暂时回到全量 status/旧线程模型）。
