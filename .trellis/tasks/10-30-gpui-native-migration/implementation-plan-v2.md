# GPUI 迁移实施文档 v2（2026-10-31 盘点重排）

> 基线：分支 `feat/gpui-native-migration-wip`，提交 `5bbf3bcd`（WIP 快照）。
> 本文替代父任务 `implement.md` 的「执行顺序」部分，作为后续实施的唯一排期依据；验收标准仍以各子任务 `prd.md` 为准，进度流水继续写入 `implementation-progress.md`，功能矩阵继续维护 `functional-alignment.md`。
> macOS 按用户要求继续暂缓；本文所有平台验收默认 Windows 11。

---

## 1. 当前状态总览

### 1.1 构建与测试基线（2026-11-01 实测）

| 项 | 结果 |
|---|---|
| `cargo check -p cli-manager-desktop-gpui` | **通过**；当前仅保留既有 dead-code 警告 |
| core / core-db / core-prefs / history-core / preview / pty-client / term-engine | 全部通过，共 142 项（51 + 22 + 7 + 16 + 15 + 17 + 14） |
| GPUI 测试 | `cargo test -p cli-manager-desktop-gpui -j 1`：123 项通过；新增共享字体度量缓存命中、描述/字号隔离与容量回归 |
| 架构严格检查 | 1564 个源文件、0 超限、0 新增违规（`main.rs` 已拆分至约 1700 行） |
| GitNexus 变更审计 | `detect-changes --scope all`：14 个文件、31 个符号、0 个受影响流程、低风险；FTS 扩展仍未安装 |

### 1.2 统计口径

- **✅ 已完成**：代码已落地，有自动化测试或真实运行证据，满足该项验收原文。
- **🟡 部分完成**：代码路径已有，但缺子功能、缺真实窗口/人工验证，或只覆盖模型层。
- **⬜ 未开始**：没有产品代码（PoC 里的实验代码不算）。
- 统计范围是 10 个子任务 `prd.md` 中的全部验收项（共 99 项）。父任务 PRD 的 10 项是这些子项的汇总，不重复计入。

### 1.3 按子任务验收项统计

| 子任务 | 总数 | ✅ | 🟡 | ⬜ | 说明 |
|---|---:|---:|---:|---:|---|
| poc-gates（M0） | 8 | 2 | 5 | 1 | 兼容性、P5 已核实；Tauri 基线未测；IME、8 分屏、checkpoint 门禁未关闭 |
| core-extraction（M1） | 12 | 2 | 6 | 4 | `ws_ack_bytes_v1` 和契约文档完成；helpers 仍链接 Tauri，src-tauri 仍有 74 处临时连接，EventSink 未做 |
| shell-foundation | 12 | 2 | 8 | 2 | 主题/语言、分配器决策完成；透明标题栏与窗口控制已接入，daemon bootstrap 与路由对账已接入，真实矩阵待手测 |
| terminal-native | 13 | 0 | 9 | 4 | 主链路基本打通，后台列表与诊断对账已接入，但性能、跨壳 attach、共享字形缓存未做 |
| rich-content-host | 10 | 1 | 8 | 1 | 代码基本齐全（P8 动态加载完成），差平台手测和截图占位 |
| workspace-features | 13 | 8 | 5 | 0 | 最成熟的子任务；剩余 5 项都要真实窗口或双壳证据 |
| settings-panels | 10 | 1 | 4 | 5 | 只有基础设置页、统计页、只读扩展概览 |
| desktop-integration | 7 | 0 | 0 | 7 | 产品壳完全未开始（托盘/单实例只在 PoC 里验证过） |
| release-cutover | 6 | 0 | 1 | 5 | 只有模型层基准脚本 |
| provider-routing | 8 | 0 | 0 | 8 | 只有 core-db 迁移常量 |
| **合计** | **99** | **16** | **46** | **37** | 按 ✅=1、🟡=0.5 折算，完成度约 **39%** |

### 1.4 按功能域统计（父 design §9，19 个域）

| 状态 | 数量 | 功能域 |
|---|---:|---|
| 完成 | 0 | — |
| 核心路径已接入 | 4 | 文件树/编辑、Markdown/HTML/PDF 预览（代码层）、Git、历史 |
| 部分完成 | 9 | 根壳/关闭行为、设置、项目树/Worktree/冲突、终端/分屏/后台任务、统计、扩展、命令面板/快捷键、Web 服务设置、许可证与发布 |
| 未开始 | 6 | Provider/路由、WebDAV 同步、SSH/远程、提示词/模板、桌宠、托盘/单实例/更新/通知/Explorer 右键 |

### 1.5 各子任务逐项判定

<details><summary>poc-gates（8）</summary>

| 验收项 | 状态 | 依据 |
|---|---|---|
| compat.md | ✅ | gpui-pre 0.3.10 + gpui-component 0.8.1 + wry + alacritty 已在 Windows 编译通过，无 patch |
| license-audit.md | 🟡 | `cargo deny check licenses` 通过；WGSL/资源来源人工审查未关闭 |
| baseline.md | ⬜ | 只做了采样器冒烟，正式 Tauri 基线未测 |
| poc-results.md | 🟡 | 编辑器、预览、探测、窗口/托盘已有结论；系统 IME、8 分屏、吞吐未关闭 |
| 失败项修订/No-Go 结论 | 🟡 | checkpoint 失败已定位，协议修订方案未定 |
| 不修改生产代码 | 🟡 | PoC 本身遵守；用户已授权跳过门禁，M1+ 已并行改动生产代码 |
| P7 mimalloc 测量 | 🟡 | 解析子场景无收益，冷启动/真实终端未测 |
| P5 现状核实 | ✅ | 已核实并在 history-core 落地 TailState/TranscriptWatcher |
</details>

<details><summary>core-extraction（12）</summary>

| 验收项 | 状态 | 依据 |
|---|---|---|
| `cargo test --workspace` 全绿 | 🟡 | 核心 crate 全绿，GPUI 当前编译失败，src-tauri 全量测试本轮未跑 |
| 打包产物路径不变 | 🟡 | `.cargo/config.toml` 已固定 target-dir，未实际执行 tauri build / portable 打包验证 |
| 新增测试（迁移/偏好/EventSink/DaemonClient/能力协商） | 🟡 | 迁移 SHA-384、偏好未知字段、能力协商已有；EventSink 快照、DaemonClient 转发缺失 |
| daemon/web-daemon/codex-proxy 不链接 Tauri | ⬜ | `src-tauri/helpers` 仍依赖 `cli-manager`（src-tauri 包） |
| `npm run tauri dev` 冒烟 | ⬜ | 未执行 |
| 契约文档 | ✅ | `pty-daemon-contracts.md` 已更新，`core-crate-contracts.md` 已新增 |
| detect_changes 无意外 | ⬜ | 索引过期，未执行 |
| P2 三个库各一个连接池 | 🟡 | 主库 WAL 读写池（16 读/2 写压测）已有；providers.db、history catalog 未接入 |
| P2 替换临时连接 | ⬜ | src-tauri 仍有 74 处 `open_database`/`SqliteConnection::connect` |
| P2 批量写事务 + 无 locked | 🟡 | 压测覆盖主库；导入/索引/定价同步未改 |
| P1 CoreEvent | 🟡 | `session_status_push_v1` 完成；请求日志、统计、子代理目录事件未做，`EventSink` 未定义 |
| P3 `ws_ack_bytes_v1` | ✅ | daemon 按能力协商切换计数，旧客户端兼容 |
</details>

<details><summary>shell-foundation（12）</summary>

| 验收项 | 状态 | 依据 |
|---|---|---|
| 启动/侧栏/标题栏/Snap/拖动/双击最大化 | 🟡 | 侧栏、工作区已有；产品壳没有自绘标题栏（只在 PoC `window.md` 验证过） |
| 主题/语言即时生效并持久化 | ✅ | 简/繁/英三态 + 明暗主题，写回共用 settings.json 并保留未知字段 |
| 命令面板与共用快捷键 | 🟡 | 命令面板、Keymap 读取共用偏好已有；动作覆盖不全，没有快捷键设置页 |
| 无预览时无 WebView 进程 | 🟡 | 懒创建已实现，未用进程树实测 |
| daemon 首帧后连接，失败不阻塞；Hook 经 DaemonClient | 🟡 | discovery 按 debug/安装版严格隔离；Windows 临时 portable 实测 sidecar bootstrap、原生鉴权和 PTY 输入输出/关闭通过；显式环境变量、自分发与完整 Hook 矩阵仍待验收 |
| watcher/索引/自动同步首帧后进程内启动 | 🟡 | 文件/Git/历史 watcher 已有；自动同步未做 |
| 冷启动与内存首测 | ⬜ | 未测 |
| P1 低功耗 | 🟡 | 按实际激活状态切换 100/500ms 刷新并在激活时重绘；10 分钟 CPU 唤醒采样、动画与托盘隐藏态仍待验收 |
| P6 首帧前只做三件事 | 🟡 | 已增加启动阶段计时，后台监视/预览回收与自动恢复等待首帧；Windows debug smoke 首帧回调约 415ms，完整生产路径审计和 release 冷启动仍待验收 |
| P6 字体懒加载缓存 | 🟡 | 应用级终端度量缓存已接入，空工作区 smoke 无终端字体初始化；字体目录与 statusline 扫描合并、全量枚举的运行时审计仍待完成 |
| P6 i18n 只加载当前语言 | 🟡 | 按语言加载字典，资源仍整体嵌入，未验证 |
| P7 分配器 | ✅ | 按测量结论保留系统分配器；release profile 已迁到根 workspace |
</details>

<details><summary>terminal-native（13）</summary>

| 验收项 | 状态 | 依据 |
|---|---|---|
| 各 Shell × TUI 交互 | 🟡 | 键盘/Kitty/鼠标/备用屏/颜色代码已接；没有人工矩阵，且依赖已运行的 daemon |
| 中文 IME | 🟡 | `EntityInputHandler` 已接；系统 IME 未手测 |
| 性能（吞吐/60fps/p95） | ⬜ | PoC 100 MB 超时，根因未定位 |
| 分屏 5 区/深层/锁定/跨 Workspan | 🟡 | 5 区拖放、深层拆分/关闭、比例拖动完成；锁定布局、Workspan 未做 |
| Tab 双源状态三种情况 | 🟡 | 合并模型 + 测试完成；未手测 |
| 退出守卫四种分流 | 🟡 | 退出确认区、后台任务列表与事件驱动 monitor 已接；真实关窗重开找回仍待手测 |
| 三类故障矩阵 | 🟡 | 重连退避、create 丢失探测、WS 断线与诊断对账已有测试；daemon 被杀/重启仍待真实手测 |
| 跨壳 attach | ⬜ | checkpoint 序列化有已知丢失，协议未定 |
| P3 零拷贝 + 字节 ACK | 🟡 | 字节 ACK 完成；零拷贝链路未审计 |
| P3 后台解析，UI 冻结 ≤100ms | 🟡 | 后台解析 + revision 观察已有；未测 |
| P3 5ms 合并、同帧 damage 只绘一次 | 🟡 | damage 缓存已有；未验证 |
| P3 共享字形缓存、scrollback 可配 | ⬜ | 未做 |
| P1 后台任务列表推送驱动、子代理目录 watcher | 🟡 | GPUI 后台列表已由 `session_status` 推送驱动并支持 attach/结束；子代理目录 watcher 未做 |
</details>

<details><summary>rich-content-host（10）</summary>

| 验收项 | 状态 | 依据 |
|---|---|---|
| 6×3 可用性矩阵手测 | 🟡 | 自动化决策矩阵已有；人工截图未做 |
| 进程/600ms/100ms/60s 回收 | 🟡 | 60s 回收与 tick 已接；PoC 观察到退出后 253ms 内回收；产品壳未计时 |
| DPI 100/150/200/跨屏 | 🟡 | bounds/scale 同步已接；未手测 |
| 浮层不被遮挡、最小化/托盘恢复 | 🟡 | OverlayRegistry、浮层打开时隐藏已接；截图占位未做 |
| 预览焦点下快捷键、Alt+Tab | 🟡 | IPC 快捷键桥接、Esc 回焦点已接；未手测 |
| 外链/禁导航/白名单 | 🟡 | 协议白名单、外链 IPC、路径防逃逸已接；真实页面未测，符号链接/8.3 短名未覆盖 |
| 原生编辑器能力 | 🟡 | gpui-component EditorState 已接（编辑/保存/冲突三栏）；查找替换、JSON 校验、IME 未验证 |
| 原生 Markdown | 🟡 | GFM 表格、任务列表、代码块完成；链接点击、本地图片位图、代码高亮未做 |
| P8 延迟加载 | ✅ | 受控路径动态加载 `WebView2Loader.dll` |
| P8 ListDLLs 验证 | ⬜ | 未做 |
</details>

<details><summary>workspace-features（13）</summary>

已勾选 8 项（Worktree 选择、Worktree 四态、历史万条、P1 watcher、P4 增量、P4 Diff 缓存与高亮、P5 共享 watcher、P5 偏移与有界并发）均为 ✅。
未勾选 5 项都是 🟡：§9 对照记录；5,000 文件真实窗口流畅；双壳元数据一致；单文件修改到面板刷新 ≤200ms（模型层 46ms）；20 文件追加到 UI ≤300ms（模型层 4ms）。

PRD 没有覆盖、但属于 §9 功能对齐的缺口：项目/分组的增删改与拖拽排序、Git 远端操作（fetch/pull/push）、stash、提交历史视图、PowerTools、行级/hunk 暂存、文件内容搜索、文件拖入终端。
</details>

<details><summary>settings-panels / desktop-integration / release-cutover / provider-routing</summary>

- settings-panels：✅ 面板不创建 WebView；🟡 §9 对照、共用偏好写回（只覆盖少数字段）、统计 30 天流畅、rfd/opener（opener 已用，rfd 未接）；⬜ Hook/Provider/同步行为一致、四项 P1 轮询改造。
- desktop-integration：7 项全部 ⬜。
- release-cutover：🟡 基准脚本（`scripts/gpuiPerformanceBench.mjs`，只覆盖模型层）；其余 ⬜。
- provider-routing：8 项全部 ⬜。
</details>

---

## 2. 关键阻塞与风险（排期前必须清楚）

| # | 阻塞 | 影响 | 处置 |
|---|---|---|---|
| B1 | GPUI 当前编译失败 | 所有后续工作的前提 | 阶段 0 首项 |
| B2 | GPUI 不会自行拉起 daemon，只能连上 Tauri 版已经启动的 daemon | GPUI 无法独立使用，M2 门禁无法通过 | 阶段 1 首项 |
| B3 | ANSI checkpoint 跨壳往返存在已知状态丢失（备用屏、滚动区、待换行、OSC8） | 跨壳 attach、双轨发布 | 阶段 7 前完成协议设计；在此之前 UI 必须提示"有损恢复" |
| B4 | PoC 中 100 MB 吞吐超时，根因未定位 | 终端性能门禁 | 阶段 1 并行排查（与 UI 无关，先分离 ConPTY/daemon/ACK/消费者） |
| B5 | helpers 仍链接 Tauri；src-tauri 仍有 74 处临时连接 | M1 门禁、打包 | 阶段 2 |
| B6 | `main.rs` 1997 行，贴近 2000 行上限 | 任何新状态字段都会触发架构检查 | 阶段 0 先拆分 |
| B7 | 系统 IME、8 分屏 60fps 尚未手测 | M0 硬门禁，可能触发 No-Go | 阶段 1 尽早手测，失败立即上报 |

---

## 3. 实施阶段与任务细分

> 编号规则：`S{阶段}.{序号}`。每个任务独立可提交、可验证。**通用前置**（每个任务都要做）：GitNexus `impact` → 实施 → 定向测试 + `cargo check` + `npm run check:architecture -- --strict` → 双语资源 → `CHANGELOG.md` / `docs/功能清单.md` → `implementation-progress.md` 记一条 → 提交前跑 `detect_changes`。
> 工作量：S ≤ 0.5 天，M 1–2 天，L 3–5 天，XL > 1 周（需要再拆）。

### 阶段 0：恢复绿线（必须先做，约 1 天）

| ID | 任务 | 触点 | 验收 | 量 |
|---|---|---|---|---|
| S0.1 | 修复 MCP 名称编辑器编译错误：确定 `extension_rename_editor` 是否应为 `Option`（懒创建），统一 `stats::extension_view` 签名与调用方 | `render.rs:708`、`stats.rs:39-71`、`settings_host.rs` | `cargo check` 通过；扩展 SQLite 测试仍是 8 项通过 | S |
| S0.2 | 拆分 `main.rs`：把预览宿主状态、统计/扩展状态、项目选择状态迁到独立模块 | `main.rs`、`settings_host.rs`、新模块 | `main.rs` ≤ 1700 行；架构检查 0 超限 | M |
| S0.3 | 全量回归：`cargo test --workspace`、`cd src-tauri && cargo test`、`npx tsc --noEmit` | — | 结果写入 progress；失败项逐条立任务 | S |
| S0.4 | 重建 GitNexus 索引（`node .gitnexus/run.cjs analyze --index-only`） | — | `context` 资源显示最新提交 | S |
| S0.5 | 用本文同步 `functional-alignment.md` 状态列，父 `implement.md` 顶部指向本文 | 文档 | 两份文档口径一致 | S |

### 阶段 1：M2 内部 Alpha —— GPUI 可独立启动并正常使用终端（约 3–4 周）

**1A daemon 与会话生命周期**

| ID | 任务 | 验收 | 量 |
|---|---|---|---|
| S1.1 | daemon 生产 bootstrap：discovery 失败时按 Tauri 版规则（`daemon.json` / `daemon.dev.json`、熔断 circuit）拉起 `cli-manager-daemon`，首帧后后台执行，失败只让终端创建报错 | 没有 Tauri 版运行时，GPUI 冷启动也能创建会话；daemon 不可用时 UI 不卡并给出提示 | L |
| S1.2 | 连接成功后执行 `reconcile_persisted_service`，与 Tauri 版顺序一致 | 与 `lib.rs` 现状对照的测试 | M |
| S1.3 | 后台任务列表 UI：基于 `session_status` 推送列出 daemon 中的后台会话，支持 attach / 结束；不使用 3s 轮询 | 后台运行 → 关窗 → 重开 → 列表可见并可 attach | L |
| S1.4 | 孤儿会话对账：事件触发 + 低频兜底（仅诊断） | 单测覆盖对账判定 | M |
| S1.5 | 故障矩阵：daemon 被杀、daemon 重启、WS 断线、create 响应丢失四种情况与 `pty-daemon-contracts.md` 错误矩阵逐条对照 | 每条契约一个测试或一条手测记录 | M |

**1B 窗口与壳**

| ID | 任务 | 验收 | 量 |
|---|---|---|---|
| S1.6 | 自绘标题栏：无边框窗口、拖动区、最小化/最大化/关闭命中、双击最大化、Windows Snap Layouts（复用 PoC `window.md` 方案） | 手测 Snap 弹出、双击还原、跨屏拖动 | L |
| S1.7 | 低功耗补完：失焦/最小化时停止光标闪烁和动画，合并重绘，恢复后立即刷新一次 | 失焦 10 分钟 CPU 唤醒次数记录 | M |
| S1.8 | 启动时序计时：确认首帧前只做读偏好/开库/加载项目树，其余全部首帧后 | 启动日志里有各阶段耗时 | S |
| S1.9 | 字体全局懒加载缓存（复用 GPUI 文字系统），启动路径不枚举全部字体 | 冷启动不触发字体枚举（日志/计时） | M |

**1C 终端补完**

| ID | 任务 | 验收 | 量 |
|---|---|---|---|
| S1.10 | 文件拖放到终端（`ExternalPaths`）+ WSL 路径转换；剪贴板图片粘贴复用 core `clipboard_image` | PowerShell/WSL 各手测一次 | M |
| S1.11 | 终端设置接线：字体族/字号/行高、scrollback 上限、光标样式，读写共用偏好 | 改设置后终端即时生效，Tauri 版读到相同值 | M |
| S1.12 | 共享字形缓存与行 shaping 缓存（所有 Pane 共用） | 8 分屏下缓存命中率日志；帧时间记录 | L |
| S1.13 | 布局锁定 + Workspan（多工作区）数据结构与栏 UI，移植 `terminalWorkspan.ts`、`terminalLayoutLock.ts` | 移植测试 + 跨 Workspan 切换手测 | L |
| S1.14 | 吞吐根因排查（B4）：分别测 ConPTY→daemon、daemon→WS、ACK/流控、消费者解析 | 定位结论写入 `poc-gates/research/`；吞吐不低于 xterm WebGL 基线 | L |
| S1.15 | 零拷贝审计：pty-client → term-engine 全程 `bytes::Bytes`，无多余拷贝 | 代码审计记录 + 分配计数 | S |

S1.10 进度（2026-11-01）：ExternalPaths 已接入 Pane，绑定目标会话查询 shell、引用路径与取消操作；图片标准化/格式回退和 PNG 存储已抽取到可选 core clipboard_image，GPUI 图片快照粘贴已接线，Tauri 保留原生剪贴板适配。真实 PowerShell/WSL 窗口拖放、系统图片粘贴和语言切换仍待验收，保持部分完成。详见实施进度。

S1.11 进度（2026-11-01）：共用 TerminalPreferences 与 GPUI 设置页已接线，字体栈、字号、行高、滚动历史和光标样式保存成功后更新现有 Pane，不重建 PTY；Tauri 消费相同行高/光标偏好，默认值共 127 键。core-prefs 9 项、term-engine 16 项、GPUI 137 项、外观脚本 3 项、TypeScript、debug 构建和严格架构检查通过。隔离 portable 空窗口 smoke 首帧 433ms、正常退出，仅证明启动路径。真实终端设置即时效果、中英文切换和 Tauri 窗口读取同值尚未手测，保持部分完成；一次原生并发测试访问异常及后续复跑证据保留于实施进度。

S1.12 进度（2026-11-01）：原生基准之外已接入应用级共享行准备 LRU（512 项、8 MiB 估算载荷、精确键防碰撞），复用文字/runs，保留框架 shaping/字形失效。cached/uncached 各 13 组合成窗口对照均退出 0，148 项 GPUI 测试、debug 构建和严格架构通过；数据与范围见 `research/terminal-text-cache-audit-2026-11-01.md` 及 `terminal-row-cache-{cached,uncached}-2026-11-01.json`。真实 PTY/S1.17、glyph atlas 命中率、跨 DPI/窗口、隐藏恢复及完整 shaping 生命周期仍未验收，保持部分完成。

**1D M0/M2 手测门禁（尽早做，失败要上报）**

| ID | 任务 | 验收 | 量 |
|---|---|---|---|
| S1.16 | 系统 IME 手测：微软拼音、搜狗在终端、命令面板、编辑器中组合与上屏，候选窗跟随光标 | 截图 + 记录；失败按 §11 风险表上报 No-Go 评估 | M |
| S1.17 | 8 分屏 60fps 实测 | 帧时间数据 | M |
| S1.18 | Shell × TUI 矩阵：PowerShell/CMD/Pwsh/WSL/Git Bash/SSH × Claude Code/Codex/OpenCode/vim/htop/less | 矩阵表逐格记录 | L |
| S1.19 | Tab 双源状态三种 Hook 安装情况手测 | 记录 | S |
| S1.20 | 退出守卫四种分流真实窗口验证（依赖 S1.3） | 与 Tauri 版逐项对比 | M |

**M2 门禁**：S1.1、S1.3、S1.6、S1.16、S1.18（PowerShell/WSL/Git Bash 三行）、S1.20 全部通过。

### 阶段 2：M1 补完 —— Core 抽取（与阶段 1 并行，约 3 周）

| ID | 任务 | 验收 | 量 |
|---|---|---|---|
| S2.1 | 定义 `EventSink` / `AppPaths` / `UiServices` / `AppContext`（按 `core-crate-contracts.md`），Tauri 侧实现适配器，事件名与载荷不变 | 事件名映射快照测试 | L |
| S2.2 | DaemonClient 在 `EventSink` 下转发 Hook/SSH Agent 事件 | 转发测试 | M |
| S2.3 | helpers（daemon/web-daemon/codex-proxy）改为依赖 core，不再依赖 `cli-manager` 包 | `cargo tree -p cli-manager-daemon` 等三个包不含 tauri | XL（按二进制拆 3 个子任务） |
| S2.4 | providers.db、history catalog 接入 core-db 连接池 | 读写池 + PRAGMA 统一 | M |
| S2.5 | 替换 src-tauri 剩余 74 处临时连接，按 feature 分批（extensions / history / providers / stats / sync / 其它），例外逐条记录理由 | 每批一个提交；grep 计数降为例外清单 | XL（按 feature 拆 6 批） |
| S2.6 | 导入、索引、定价同步批量写入放进事务；并发读写无 `database is locked` 测试 | 压测 | M |
| S2.7 | 补 CoreEvent：请求日志写入、统计更新（Hook 触发）、子代理目录变化 | 事件单测；Tauri 映射不变 | M |
| S2.8 | `npm run tauri dev` 全量冒烟（PRD 列出的 11 项）+ `tauri build` / portable 产物路径核对 | 冒烟记录 | M |

**M1 门禁**：S0.3、S2.3、S2.5、S2.8 通过，`detect_changes` 无意外流程。

### 阶段 3：M3 —— 工作区功能补齐（约 3 周）

**3A 项目树**

| ID | 任务 | 验收 | 量 |
|---|---|---|---|
| S3.1 | 项目/分组增删改：名称、路径、Shell、startupCmd、icon、颜色编辑表单，写共用 SQLite | Tauri 版读到相同记录 | L |
| S3.2 | 项目树拖拽排序与跨分组移动 | 排序持久化测试 | M |
| S3.3 | 项目右键菜单：打开终端、在资源管理器打开、复制路径、外部终端 | 手测 | M |

**3B Git**

| ID | 任务 | 验收 | 量 |
|---|---|---|---|
| S3.4 | 远端操作：fetch / pull / push，带进度与错误反馈；凭据走系统 Git | 临时远端仓库测试 | L |
| S3.5 | stash：保存/应用/弹出/删除列表 | 临时仓库测试 | M |
| S3.6 | 提交历史视图（GitHistoryView 对齐）：分页、单提交 Diff | 万条提交窗口化滚动 | L |
| S3.7 | hunk/行级暂存（对齐 Tauri 现有能力，先确认 Tauri 是否支持） | 测试 | M |
| S3.8 | PowerTools 清单盘点后逐项迁移（先出清单，再拆子任务） | 清单 + 子任务 | M |
| S3.9 | 5,000 文件真实窗口：列表/Diff 滚动、单文件修改刷新 ≤200ms 计时 | 真实窗口数据 | M |

**3C 文件与编辑器**

| ID | 任务 | 验收 | 量 |
|---|---|---|---|
| S3.10 | 文件内容搜索（项目内 grep，结果跳转编辑器） | 万文件仓库不阻塞 UI | L |
| S3.11 | 编辑器查找替换、撤销重做验证、JSON 校验提示 | 1 MB 文件流畅；JSON 错误定位 | M |
| S3.12 | 编辑器 tree-sitter 语法高亮（复用 Diff 高亮 grammar） | Rust/TS/TSX 高亮 | M |

**3D 历史与跨壳**

| ID | 任务 | 验收 | 量 |
|---|---|---|---|
| S3.13 | 原生 Markdown 补齐：链接点击、项目内本地图片位图、代码块高亮 | 历史转录渲染对照 | M |
| S3.14 | 20 个转录文件追加 → UI 更新 ≤300ms 真实窗口计时 | 数据 | S |
| S3.15 | 双壳元数据往返：项目、收藏、标题、星标在 Tauri ↔ GPUI 切换后一致 | 往返记录 | M |
| S3.16 | 冲突解决器完整手动矩阵 | 记录 | S |

### 阶段 4：M3 —— 预览闭环（约 1.5 周，可与阶段 3 并行）

| ID | 任务 | 验收 | 量 |
|---|---|---|---|
| S4.1 | Airspace 截图占位：浮层/拖拽/缩放时用 WebView 截图替代，浮层用 prepaint 实际 bounds 替换窗口级保守矩形 | 菜单、弹窗、Toast 不被遮挡 | L |
| S4.2 | Live Server：HTML 预览的刷新与地址显示 | 手测 | M |
| S4.3 | 预览设置区：可用性状态、重新检测、用户禁用（不提供静默安装） | 设置页可切换 | M |
| S4.4 | 路径安全补测：符号链接、硬链接、UNC、8.3 短名 | 单测 | M |
| S4.5 | release 构建无 DevTools；不存在 WebView2 静默安装代码路径（安全清单逐项确认） | 清单勾选 | S |
| S4.6 | 6×3 可用性矩阵手测 + 截图 | 18 格记录 | M |
| S4.7 | DPI 100/150/200/跨屏、焦点/Alt+Tab、最小化恢复手测 | 记录 | M |
| S4.8 | 性能：首次 600ms 先显示原生内容、复用切换 ≤100ms、关闭 60s 内进程退出；ListDLLs 验证无预览时不加载 Loader | 计时 + 模块列表 | M |

**M3 门禁**：§9 中项目/终端/Git/历史/设置五个域对齐（设置见阶段 5 的 5A）；S4.6 通过。

### 阶段 5：设置与管理面板（约 5–6 周，5A 先行，其余可并行）

**5A 设置页（对齐 `src/features/settings/components/pages`）**

| ID | 页面 | 量 |
|---|---|---|
| S5.1 | 设置框架：左侧导航、搜索、通用表单控件（ui_kit 封装），所有字段写共用偏好并保留未知字段 | L |
| S5.2 | 通用（GeneralSettingsPage）+ 关闭行为 + 外部终端程序 + 数据存储 | M |
| S5.3 | 主题（ThemeSettingsPage、终端主题预设、终端背景图，背景图复制到 `appLocalData/backgrounds`） | L |
| S5.4 | 快捷键设置页（与 Tauri 共用 `keyboardShortcuts`，冲突检测） | M |
| S5.5 | 侧栏、命令建议、历史来源 | M |
| S5.6 | Hook 设置：Claude/Codex Hook 安装/卸载/状态，行为与 `hook_settings.rs` 一致 | L |
| S5.7 | Statusline 设置与预览、Codex statusline 编辑器 | L |
| S5.8 | 模型定价、开发者、关于/赞助、第三方通知 | M |
| S5.9 | 设置字段全量对照：125 个默认值逐项确认 GPUI 读写一致 | M |

**5B 扩展（MCP/Skills）**

| ID | 任务 | 量 |
|---|---|---|
| S5.10 | MCP 完整编辑：transport（stdio/http/sse）、命令参数、环境变量、秘密引用（遮罩/保留），JSON 原生编辑器 | L |
| S5.11 | MCP 导入（从 Claude/Codex/Grok 配置） | M |
| S5.12 | Skill 导入/部署/卸载、部署实例管理 | L |
| S5.13 | 项目级策略操作 | M |

**5C Provider/路由**：按 `10-31-gpui-provider-routing/implement.md` 五阶段执行（S5.14 只读目录 → S5.15 service 去 Tauri 化 → S5.16 CRUD 与配置编辑 → S5.17 密钥与全局 Apply（改 `provider_global_apply` 前必须重跑 impact，HIGH/CRITICAL 专项 review）→ S5.18 路由/导入/快速切换）。合计 XL，约 3 周。

**5D 其它面板**

| ID | 任务 | 量 |
|---|---|---|
| S5.19 | WebDAV 同步：配置、手动同步、状态、冲突提示（不静默覆盖）；启动/关闭自动同步接入首帧后任务 | L |
| S5.20 | SSH 主机：列表、编辑器、ssh config 导入、CLI 集成对话框；远程连接设置 | L |
| S5.21 | 提示词/模板：三级作用域（全局/分组/项目）列表、编辑、插入终端 | L |
| S5.22 | 统计补完：真实窗口筛选交互、30 天数据量流畅性验证 | M |
| S5.23 | P1 轮询改造：统计由 Hook 事件触发；请求日志由路由层写入事件驱动；资源采样只在面板可见时运行；Hook/故障转移/Web 服务状态改事件或手动刷新（依赖 S2.7） | L |
| S5.24 | rfd 文件对话框接入（项目路径、背景图、导入文件） | S |

### 阶段 6：M4 —— 桌面集成（约 3–4 周，阶段 1 完成即可开始）

| ID | 任务 | 验收 | 量 |
|---|---|---|---|
| S6.1 | 单实例：与 `tauri-plugin-single-instance` 相同的互斥/通道名，后启动方转发参数后退出；与 Tauri 版互认 | 两壳同装不会同时运行 | L |
| S6.2 | 托盘：显示/退出菜单，最小化到托盘，再次启动 exe 恢复窗口；托盘退出走退出守卫 | 手测 | M |
| S6.3 | 关闭行为三种模式（托盘/退出/询问）接入 `closeBehavior` | 手测 | S |
| S6.4 | 系统通知：Hook 事件 Toast，点击跳转到对应会话（未聚焦/最小化/托盘三种状态） | 手测 | M |
| S6.5 | Explorer 右键"在 CLI-Manager 中打开"：未运行/已运行/托盘三种状态 | 手测 | M |
| S6.6 | 更新器：minisign 校验、`latest.json` 的 `-gpui` 平台键、有运行会话时询问（转入后台后更新/结束后更新/取消）、daemon 只在空闲时替换 | 签名错误拒绝；后台会话更新后可 attach | XL |
| S6.7 | Web 服务设置与 web-daemon 生命周期（关闭时不运行） | 手测 | M |
| S6.8 | Web 设备 Operation 执行器（loopback NDJSON，协议与 Tauri 一致），web-daemon 权限边界不变 | 与 Tauri 结果逐项对比 | L |
| S6.9 | 桌宠：同进程第二窗口，透明、置顶、可拖动；不支持的平台写降级说明 | 手测 | L |
| S6.10 | NSIS 安装包：GPUI 主程序 + daemon + web-daemon + codex-proxy + hook 上报端 + conpty 资源；复用 `installer/hooks.nsh` 与 `cleanup.ps1` | implement.md 手动清单 7 项 | L |
| S6.11 | 日志：`CLI_MANAGER_DEBUG` 语义不变，日志写入 Tauri 同一 LogDir | 手测 | S |

### 阶段 7：M4/M5 —— 验收、双轨与下线（约 3 周 + 一个正式版本周期）

| ID | 任务 | 验收 | 量 |
|---|---|---|---|
| S7.1 | Tauri 正式基线（受控环境）：冷启动、空闲内存（含 WebView2 与 daemon）、进程数、100 MB 吞吐、键入 p95、8 分屏帧率 | `poc-gates/research/baseline.md` | M |
| S7.2 | checkpoint 状态契约设计（B3）：备用屏、滚动区、待换行、OSC8 的编码与能力协商；无法无损时显式降级提示 | 协议文档 + 8 组 fixture 往返通过或降级声明 | XL |
| S7.3 | 跨壳 attach 实测：Tauri ⇄ GPUI 双向 | 记录 | M |
| S7.4 | 全数据往返：Tauri → GPUI → Tauri，项目/历史/设置/Provider/同步配置无损 | 记录 | M |
| S7.5 | GPUI 性能报告：对照基线，P1–P8 逐项引用子任务验收记录；空闲 10 分钟（前台/托盘）CPU 唤醒 | 报告 | M |
| S7.6 | 场景矩阵全量回归（`fix-triage-guide.md` §5 全部维度，含 WebView 可用性/DPI/输入法/双壳/GPU） | 每维度一条通过记录 | L |
| S7.7 | 许可证人工复核：WGSL 来源、资源授权 | `license-audit.md` 关闭 | M |
| S7.8 | 双轨发布：GPUI 预览版与 Tauri 并行至少一个正式版本，收集崩溃率与反馈 | 不高于 Tauri 版 | 一个版本周期 |
| S7.9 | Tauri 下线清单与 PR（`detect_changes --scope compare` 审查）；helpers 迁到 `apps/helpers`；更新 CLAUDE.md/AGENTS.md 架构描述 | 审查通过 | L |

---

## 4. 排期建议与依赖

```
阶段0 ─┬─► 阶段1（M2）───────┬─► 阶段3 ─┐
       │                     ├─► 阶段4 ─┼─► M3 门禁 ─► 阶段7
       ├─► 阶段2（M1，并行）─┤          │
       │                     └─► 阶段5 ─┘
       └────────────────────► 阶段6（阶段1完成后启动）
```

| 顺序 | 内容 | 预估（单人） |
|---|---|---|
| 1 | 阶段 0 | 1 天 |
| 2 | 阶段 1 + 阶段 2 并行 | 4 周 |
| 3 | 阶段 3 + 阶段 4 + 阶段 5A | 4 周 |
| 4 | 阶段 5B–5D + 阶段 6 | 6 周 |
| 5 | 阶段 7（不含双轨期） | 3 周 |
| | **合计** | 约 **17–18 周**，外加一个正式版本的双轨期 |

**优先级原则**（来自父 design §11）：双轨期允许 GPUI 暂缺低频功能（桌宠、赞助页、部分 PowerTools），但终端、项目、Git 主路径不能砍。人力紧张时，阶段 5D 中的 SSH、模板和阶段 6 中的桌宠可以挪到双轨期再做。

## 5. 维护规则

- 完成一个任务：在本文对应行前加 `✅`，在 `implementation-progress.md` 记一条带验证命令的流水，并同步 `functional-alignment.md`。
- 一项只有在满足其所属子任务 `prd.md` 原文、并有直接证据时才能标 ✅；只覆盖模型层的计时不算真实窗口验收。
- 新发现的缺口追加为 `S{阶段}.{新序号}`，不要改动已有编号。
