# GPUI 原生桌面壳迁移（按需系统 WebView + 降级）

## 背景

CLI-Manager 桌面端当前是 Tauri 2 + React 19：约 15.9 万行 TS 跑在系统 WebView 中，终端由 xterm.js（WebGL）渲染，Rust 后端约 17 万行。WebView 带来的常驻内存、冷启动耗时、多终端分屏时的渲染/布局开销、输入延迟，以及 WebView2 缺失或损坏时整个应用不可用，是当前性能与可用性的主要瓶颈。

目标是把**桌面 UI 壳**迁到 GPUI（Zed 的 GPU 加速原生 Rust UI 框架）。系统 WebView 只作为**按需加载的预览器**：仅 Markdown 文件预览、HTML / Live Server 预览、PDF 预览会按需创建。WebView 不可用时回落到原生简版渲染，或给出“外部打开 / 安装运行时”提示。

## 已确认的技术约束（2026-10-30）

- GPUI 依赖：`gpui-pre 0.3`（Zed 2026-09 快照，crates.io）。
- GPU 原生渲染：终端、Markdown 阅读、代码编辑、Diff、图表等全部原生绘制；Monaco 移除。
- 单进程（按项目现状解释，见 design §0.1）：GPUI 版的 **UI 与业务核心在同一个 `cli-manager` 进程内**，没有 WebView 渲染进程、JS 运行时与 Tauri IPC。保留两个用途单一的辅助进程：`cli-manager-daemon`（PTY 会话 + Hook 接收端口 + 本地路由代理 + SSH Agent 桥，支撑“转入后台”与崩溃/更新不丢会话）与 `cli-manager-web-daemon`（远程设备连接的权限隔离）。由外部 CLI 拉起的辅助程序（Hook 上报端、codex-proxy）不受此约束。
- 仅预览使用 WebView：见上。

## 目标

1. 主窗口、侧栏、终端、分屏、Git、历史、设置、代码编辑等全部以 GPUI 原生渲染；**启动与常规使用时进程树中只有 `cli-manager`、`cli-manager-daemon`（及其 shell 子进程）与按设置启用的 `cli-manager-web-daemon`**，不出现任何 WebView 进程。
2. 预览通过 `PreviewHost` 按需调用系统 WebView（Windows WebView2 / macOS WKWebView），关闭或闲置后回收；Linux 第一版预览一律走降级路径。
3. WebView 缺失、版本过低、创建失败或被用户禁用时，预览**仍可用**：Markdown 降级为原生渲染，HTML 显示源码，PDF 提供“用默认应用打开”。**禁止静默安装运行时。**
4. 与现有 Tauri 版共享 SQLite、偏好 JSON 与 Rust 业务核心（`crates/core`）。迁移期两壳可切换使用，数据零迁移、可回退；两壳共用同一 daemon，后台会话可跨壳 attach。
5. 不引入与 AGPL-3.0-or-later + 商业双授权冲突的依赖（禁止 GPL-only 代码，如 Zed 的 `terminal`/`terminal_view`）。

## 非目标

- 不改 `apps/web`、`apps/web-tap`、`apps/server` 的 React Web 端（远程 Web 仍是 React）。
- 不重写 PTY daemon 与 web-daemon；协议只做 capability 协商式的向后兼容扩展（`ws_ack_bytes_v1`、原生客户端鉴权、`checkpoint_ansi_v1`），Tauri 版行为不变。
- 不改变“转入后台”与退出守卫的已发布行为（`background-task-continuation-contracts.md`）。
- 本任务本身**只产出规划与实施文档，不修改代码**；代码改动由各子任务在 `task.py start` 后进行。
- 第一阶段不追求 Linux 内嵌 WebView（Linux 走独立窗口或降级）。

## 性能目标（以 Tauri 版同机基线为准，Phase 0 先测基线）

| 指标 | 目标 |
|---|---|
| 冷启动到首帧可交互 | ≤ Tauri 版的 50% |
| 空闲常驻内存（含 1 个终端，无富内容） | ≤ Tauri 版（含 WebView2 子进程）的 40% |
| 终端吞吐（`cat` 100 MB 文本） | 不低于 xterm WebGL；UI 不冻结超过 100 ms |
| 键入回显延迟 p95 | ≤ 10 ms（本地 shell） |
| 8 个分屏同时滚动输出 | 60 fps 不掉帧（Windows dGPU / iGPU 各测一台） |
| 常驻进程数（无预览打开时） | `cli-manager` + `cli-manager-daemon`（+ 启用 Web 服务时的 web-daemon）+ shell 子进程；无 WebView 进程 |
| 首次打开预览（WebView 冷创建） | ≤ 600 ms 内先显示原生降级内容；WebView 就绪后替换；复用切换 ≤ 100 ms |
| 预览关闭后 | 60 s 内 WebView 进程全部退出 |

## 场景矩阵（来自 `fix-triage-guide.md` §5，再加上本需求特有的维度）

| 维度 | 必须覆盖 |
|---|---|
| 窗口焦点 | 本窗口 / 其他窗口 / 应用未聚焦（通知、托盘、IME） |
| 分屏 | 当前 pane / 同窗口其他 pane / 分屏树深层节点；拖拽 reorder/split |
| 最小化 / 托盘 | 正常 / 最小化 / 最小化到托盘（WebView 子窗口的隐藏与恢复） |
| UI 形态 | 展开侧栏 / 折叠侧栏 / 紧凑嵌入侧栏 |
| 多会话 / Workspan | 单会话 / 多会话 / 跨 Workspan 切换 |
| 专注模式 | 开 / 关 |
| 运行环境 | PowerShell / CMD / Pwsh / WSL / Git Bash / SSH 远程 |
| Worktree | 主仓 / Worktree 子目录 / Worktree 已删除 / `.git` 是文件 |
| CLI Hook | Claude/Codex 均装 / 均未装 / 仅装其一 |
| **WebView 可用性** | 可用 / 未安装 / 版本过低 / 创建失败 / 用户禁用 / Linux 无 WebKitGTK |
| **DPI / 多显示器** | 100% / 150% / 200%；跨不同 DPI 显示器拖动窗口（WebView 边界与缩放同步） |
| **输入法** | 微软拼音 / 搜狗 / 日文 IME；组合态中按 Enter/Esc/方向键 |
| **双壳共存** | 只装 Tauri / 只装 GPUI / 两者都装但切换使用；GPUI 启动时存在 Tauri 版转入后台的会话（应能 attach） |
| **进程生命周期** | 隐藏到托盘 / 后台任务模式 / 有运行中会话时退出 / 有运行中会话时自更新 / 单会话解析异常 |
| **预览类型** | Markdown（含公式、相对图片）/ 静态 HTML / Live Server / PDF |
| **GPU** | 独显 / 核显 / 远程桌面（RDP，无硬件加速）/ 虚拟机 |

## 验收标准（父任务层，所有子任务完成后整体验收）

- [ ] GPUI 版完成功能对齐清单（`design.md` §9），每项都有对应子任务的验收记录。
- [ ] 性能目标表全部达标，且有可复现的基准脚本与结果记录。
- [ ] WebView 可用性维度的 6 种状态都有手动验证记录，每种状态下 Markdown / HTML / PDF 三类预览的行为符合 `design.md` §6.1 的降级矩阵。
- [ ] 常规使用（不打开预览）全程进程树中无 WebView 进程；关闭预览后 60 s 内 WebView 进程退出。
- [ ] 有运行中会话时退出或自更新，行为与 `background-task-continuation-contracts.md` 一致（ask / background / minimize / discard）；“转入后台”后 UI 真退出、会话在 daemon 中继续，重新打开后可找回。
- [ ] 同一台机器先用 Tauri 版、再切到 GPUI 版、再切回：项目、历史、设置、Provider、同步配置均无丢失或损坏；Tauri 版转入后台的会话可在 GPUI 版中 attach，反之亦然。
- [ ] 性能优化 P1–P8（design §13）全部落地，各子任务的对应验收项均有记录。
- [ ] 依赖许可证审查通过（`cargo deny check licenses` 或等价清单），无 GPL-only 依赖。
- [ ] 中文 IME 在终端、输入框、命令面板中可正常组合与上屏。
- [ ] Tauri 版下线前至少经历一个正式版本的双轨发布期。

## 子任务

见 `design.md` §10 与 `implement.md`。
