# JetBrains 风格 Git Diff 审阅能力升级 - 统一验收

## 1. 结论

- 父任务 9/9 子任务完成，分支：`feat/git-power`，目标：`master`。
- P0/P1 六个实施任务已落地；P2 三个任务按约定只产出研究与 ADR。
- 图片、Office、PDF、压缩包、音频、视频、3D 和通用二进制 Diff 明确 No-Go，文件类型支持保持现状。
- 未新增 npm 依赖；仅 SSH Agent 版本/capability 随既有协议扩展更新。
- 父任务验收材料在人工验证完成后纳入最终提交，9 个子任务各自只有一个任务提交。

## 2. 子任务与提交

| 优先级 | 子任务 | 结果 | 提交 |
|---|---|---|---|
| P0 | Diff Viewer 职责拆分 | shared snapshot/live Viewer，移除视图层环境依赖 | `5b329313` |
| P0 | 导航与显示工具栏 | 文件/Hunk 导航、F7、Split/Unified、源码跳转 | `edc59af9` |
| P0 | 固定到编辑器 | 项目级标签、实时刷新、引用计数 Transport lease | `d80b58cf` |
| P1 | 生成选项 | exact/ignore-eol/ignore-all，3/10/20 行上下文 | `31a800c2` |
| P1 | 行操作与无障碍 | 范围选择、键盘、Radix Dialog、非颜色语义 | `7208fe18` |
| P1 | 大 Diff 性能 | Worker、Hunk 虚拟化、高亮阈值、统一硬限制 | `73c36837` |
| P2 | 搜索/复制/AI 上下文研究 | 纯前端边界、格式契约、隐私与三个后续切片 | `b4685519` |
| P2 | 图片/二进制研究 | Accepted No-Go，保持现有文件类型 | `4d4c8f7a` |
| P2 | 三方冲突编辑器研究 | 后端权威 session、显式写动作与三个后续切片 | `c3be49eb` |

## 3. 功能验收

### Viewer 与导航

- [x] 弹窗、固定页、历史和终端统计复用同一 Viewer；snapshot 类型无法获得 mutation。
- [x] Review Dialog 按当前渲染树导航文件，支持 Hunk/文件边界且不循环。
- [x] F7/Shift+F7 只在 Viewer 焦点域生效，不注册全局监听。
- [x] 删除文件禁用源码跳转；根仓库与嵌套仓库使用独立 target identity。
- [x] Split/Unified 偏好持久化并参与设置同步。

### 固定页与上下文

- [x] 同项目/仓库/文件只保留一个标签；嵌套仓库同路径互不覆盖。
- [x] Windows 盘符 identity 不区分大小写；Linux/macOS/WSL 保留 POSIX 大小写。
- [x] Git 面板关闭后固定页继续持有 lease；最后一个 consumer 释放 SSH transport。
- [x] 项目、Host、remote path、Agent installation 或 Workspan 变化不会串用旧上下文。
- [x] 固定页 mutation 绑定自身 lease，只做 context-guarded 面板刷新通知。

### Diff 生成与回滚安全

- [x] Desktop libgit2、WSL Git CLI、SSH Agent 使用同一 options 语义。
- [x] 默认 exact+3 保持旧 Agent wire shape；非默认选项由 `gitDiffOptions` capability 前置拒绝。
- [x] 非 exact、非 UTF-8、未跟踪、二进制和后端禁用场景不能执行 Hunk/行级回滚。
- [x] 行选择基于解析模型与稳定 key，不依赖 DOM；Split old/new 锚点独立。
- [x] 回滚后提升 revision 并重新加载；旧异步结果和旧选择不会进入新 target。

### 性能与边界

- [x] `<=64 KiB` 同步解析，`>64 KiB` 使用独立 Worker。
- [x] `>256 KiB` 或 `>5000` 行关闭语法高亮，只对挂载 Hunk tokenize。
- [x] `>768 KiB` 或 `>20000` 行由 Desktop、WSL、SSH 统一拒绝，不截断、不暴露部分回滚。
- [x] Worker 成功、失败和 cleanup 均终止；generation 防止旧结果覆盖。
- [x] Hunk 虚拟化动态测量，跨 Hunk 键盘定位绑定解析文件 identity。
- [x] 旧 SSH Agent 缺少 byte/line metadata 时由 Transport 补算并继续执行硬限制。

## 4. 架构验收

- [x] Viewer 层没有直接 Tauri、SSH 或环境判断。
- [x] Desktop Diff 从巨型 `git.rs` 拆到 `git_diff.rs`、`git_diff_display.rs`、`git_diff_tests.rs`。
- [x] SSH Agent Diff 从巨型 `git.rs` 拆到独立实现与测试文件。
- [x] 固定页的 workspace、lease registry、Host、tabs 和 identity 按职责拆分。
- [x] Diff 责任文件均小于 300 行；当前最大 `GitDiffEditorHost.tsx` 266 行，`FileEditorPane.tsx` 299 行。
- [x] `DiffViewerModal.tsx` 从旧巨型实现缩到 98 行兼容壳。

`GitChangesPanel.tsx` 仍为 1419 行的既有大型宿主。本轮新增的解析、Viewer、导航、固定页、lease 和选项逻辑均已移出，该文件只保留面板编排接线；继续拆分整个 Git 面板属于独立重构，不混入本任务。

## 5. 平台矩阵

| 场景 | 契约/自动化结论 |
|---|---|
| Windows native | Desktop libgit2、盘符 identity、Rust 定向 fixture 已覆盖 |
| Linux/macOS native | 共享 Desktop command 与 POSIX identity，无平台 UI 分支 |
| WSL | UNC Git CLI 与 `/mnt/<drive>` native fallback 均进入统一 payload builder |
| SSH | legacy/default 与 capability/new options 均进入 Agent 统一 builder |
| 旧 SSH Agent | 默认 options 不发未知字段；缺失 metadata 前端兼容补算 |
| 根/嵌套仓库 | repository id 进入导航、标签和 mutation identity |
| live/snapshot/pinned | 同一 Viewer，mutation capability 由 data source 类型约束 |

## 6. 自动化证据

最终重跑：

- [x] `npx tsc --noEmit`
- [x] `npm run build`，产出独立 `gitDiffParser.worker` chunk。
- [x] 10 个 Git Diff/Store/Transport 测试文件，48/48 通过。
- [x] Desktop `commands::git_diff::tests`，5/5 通过。
- [x] SSH Agent 全量：库测试 70/70、binary 测试 3/3 通过。
- [x] Desktop 与 SSH Agent `cargo check` 通过。
- [x] Desktop 与 SSH Agent `cargo fmt --all -- --check` 通过。
- [x] 父任务与 9 个子任务的 Trellis context 校验全部通过。
- [x] GitNexus `detect-changes --scope compare --base-ref master`：143 文件、138 符号、0 affected processes、low risk。
- [x] 子任务提交前均执行 `git diff --check` 与精确 staged 范围审计。

Desktop 全量库测试此前结果为 751 通过、3 失败、1 忽略。3 个稳定失败位于未修改的 `hook_settings::install_then_uninstall_pi_extension` 和 `history::request_logs` 夹具；后两例受到机器全局日志影响，已在大 Diff 子任务自审记录，不属于本任务修复范围。

## 7. P2 决策

- 搜索/复制/AI 上下文：建议后续按 Search、Patch Copy、AI Context 三个纯前端切片实施；禁止直接发送 Agent。
- 图片/二进制：No-Go，不预埋判别联合、内容句柄、RPC、capability 或依赖。
- 三方冲突：建议另开父任务，先只读 stage 1/2/3，再安全 Result save，最后显式 mark-resolved/rebase continue/merge commit 交接。

## 8. 人工桌面验收清单

按项目规范，AI 未启动 Tauri 桌面应用。以下发布验收已由用户人工确认通过：

- [x] Windows local、WSL UNC、WSL `/mnt`、SSH 根仓库与嵌套仓库实际加载/回滚。
- [x] Linux/macOS 实机确认路径大小写、快捷键修饰键和窗口焦点。
- [x] 弹窗与固定页切换、关闭 Git 面板、Workspan/项目切换和 SSH 断线。
- [x] F7/Shift+F7、源码跳转、Split/Unified、3/10/20 context 和三种空白模式。
- [x] 鼠标/键盘范围选择、IME Esc、嵌套确认框焦点恢复和屏幕阅读器播报。
- [x] 亮暗主题、zh-CN/en-US、窄窗口及 125%/150%/200% 缩放。
- [x] 64/256/768 KiB 大 Diff 滚动、关闭、快速切文件和跨虚拟 Hunk 聚焦。

## 9. 最终状态

工程实现、自动化质量门禁、规格、CHANGELOG、功能清单、P2 ADR 和人工桌面矩阵均已完成。父任务标记 `completed`，不再扩大本任务代码范围。
