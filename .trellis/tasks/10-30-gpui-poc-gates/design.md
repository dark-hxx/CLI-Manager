# 设计：M0 PoC 门禁

> 上游：父 `design.md` §0–§6、§11；本任务只产出验证结论与报告，不改生产代码。

## 1. 目的与原则

- 用最小代码验证父 design 中所有 **[PoC]** 点与硬门槛，避免在 M1 之后才发现不可行。
- PoC 代码放在 `spikes/gpui-poc/`，是**独立 Cargo workspace**（自带 `Cargo.toml [workspace]` 与 `Cargo.lock`），不加入 M1 的根 workspace（根 `Cargo.toml` 中显式 `exclude = ["spikes/*"]`），也不被打包脚本与 CI 引用。
- 结论阶段完成后，`spikes/gpui-poc` 保留在仓库中作为参考（不参与构建），或打包为 `research/gpui-poc.zip` 后删除，由父任务评审决定。
- 每项 PoC 输出三态结论：**通过 / 有条件通过（附条件与额外工作量）/ 失败（附对父 design 的修订建议）**。

## 2. PoC 工程结构

```
spikes/gpui-poc/
  Cargo.toml                 # [workspace] members = ["poc-*"]；[patch.crates-io] 指向 gpui-pre 适配
  deny.toml                  # cargo-deny 许可证与 bans 配置（后续并入根 workspace）
  poc-compat/                # 仅编译验证：gpui-pre + gpui-component + wry + alacritty_terminal + tokio-tungstenite
  poc-ime/                   # 输入框 + 自绘终端元素的 IME
  poc-term/                  # daemon 客户端 + alacritty + TerminalElement + 8 分屏
  poc-checkpoint/            # ANSI checkpoint 往返（含 Node 脚本生成 xterm fixture）
  poc-editor/                # gpui-component Editor + 三栏冲突草图
  poc-preview/               # wry 子 WebView：Markdown/HTML/PDF、Airspace、DPI、回收
  poc-webview-probe/         # WebView2 探测（可单独编译为小 exe 放到虚拟机运行）
  poc-window/                # 自绘标题栏、托盘、透明置顶第二窗口、单实例互认
  bench/                     # 基准脚本（后续迁到 scripts/bench/）
```

## 3. 各 PoC 的验证设计

### 3.1 poc-compat（编译兼容）
- 依赖：`gpui = { package = "gpui-pre", version = "=0.3.x" }`；gpui-component 最新版，通过 `[patch.crates-io] gpui = { package = "gpui-pre", ... }` 或 git fork 让其改用 gpui-pre；`wry`（与 gpui-pre 的 raw-window-handle 版本一致）；`alacritty_terminal`；`tokio-tungstenite`。
- 记录：所需 patch、fork 改动行数、重复依赖（`cargo tree -d`）、编译时间、Windows/macOS 是否都能编译。
- 失败判定：无法在 3 人日内通过 patch/fork 编译通过。

### 3.2 许可证审查
- `cargo deny check licenses`：允许清单 = Apache-2.0、MIT、BSD-2/3、ISC、Zlib、Unicode-3.0、MPL-2.0（文件级）、CC0、Unlicense；`GPL-*`、`AGPL-*`（第三方）、`LGPL-*` 列为 deny，逐条人工复核。
- 重点核查：`sum_tree`、`ztracing`、`collections`、`util`、`refineable`、`media`、`http_client` 等 Zed 内部 crate 的 `license` 字段与仓库 LICENSE 文件；字体/着色器等资源文件的许可证。
- 产出 `research/license-audit.md`：依赖树全量许可证表（脚本生成）+ 结论 + 需要 `[patch]` 替换的 crate 清单。

### 3.3 poc-ime
- 场景：GPUI 文本输入框、自绘终端元素（实现 `EntityInputHandler`，组合文本内联显示，候选窗位置 = 光标单元格屏幕坐标）。
- 输入法：微软拼音、搜狗、微软日文 IME；macOS 系统拼音。
- 用例：连续组合、组合中 Enter/Esc/方向键/Backspace、候选窗跟随、DPI 150% 下候选窗位置、切换窗口后组合状态清理。
- 失败判定：Windows 中文 IME 无法组合上屏，或候选窗位置无法控制且无上游修复路径。

### 3.4 poc-term（终端渲染与吞吐）
- 数据通路：直接复用本机已安装/已构建的 `cli-manager-daemon`（只读使用，不改源码），Rust 客户端最小实现：bootstrap（读 `daemon.json`）、auth、create、attach、binary output 解码、write、ACK（UTF-16 计数临时实现）。
- 原生客户端的 Origin 问题：daemon 现仅允许 Tauri Origin。PoC 中客户端发送 `Origin: http://tauri.localhost` 绕过（仅 PoC），正式方案由 core-extraction 的 `ws_native_client_v1` 解决。
- 渲染：alacritty `Term` + 简易 TerminalElement（按行 shaping 缓存、damage 行重绘、光标/选区图层）。
- 测量：`cat` 100 MB 文本耗时与 UI 最长卡顿；8 分屏同时 `yes | head -c 200M` 时的帧率（GPUI 帧时间统计）；键入回显延迟 p95（高精度时间戳：按键事件 → 对应字形首次绘制）。
- 失败判定：8 分屏 < 60 fps 且分析后无明确优化路径。

### 3.5 poc-checkpoint（跨壳 attach 前提）
- Node 脚本用 `@xterm/headless` + SerializeAddon 对一组场景（彩色输出、备用屏 vim、滚动区、宽字符/emoji、超链接、光标隐藏）生成 checkpoint fixture。
- Rust 侧：alacritty 重放 fixture → 断言网格；`serialize_to_ansi` 草稿 → 再用 xterm headless 重放 → 比较网格文本与 SGR。
- 结论用于决定 `checkpoint_ansi_v1` 是否可行，以及哪些特性需要在跨壳 attach 时丢弃。

### 3.6 poc-editor
- gpui-component Editor 打开 1 MB TS 文件与 10 MB 日志文件：打开耗时、滚动帧率、tree-sitter 高亮、撤销/重做、查找替换、中文 IME、行号、软换行。
- 草图：三栏冲突视图（ours/base/theirs）同步滚动 + 块选择按钮。
- JSON：serde_json 解析错误定位到行列并在编辑器中标记。
- 失败判定：基础编辑或 IME 不可用 → 写明需在 `ui_kit` 自研的范围与人日估计（不回退 Monaco）。

### 3.7 poc-preview
- `wry::WebViewBuilder::build_as_child(&window)`，自定义协议 `climgr-preview://` 返回内置 Markdown 页面、本地 HTML（项目根白名单）、PDF 字节流。
- 用例：bounds 同步（窗口缩放、分屏拖动）、DPI 切换（100→150→200%，跨显示器拖动）、浮层相交时隐藏 + 截图占位（`ICoreWebView2::CapturePreview`）、焦点往返（全局快捷键回传、Alt+Tab）、最小化/托盘恢复、关闭后 WebView 进程退出时间、首次创建耗时、复用切换耗时。
- 对比方案：独立无边框子窗口（owner = 主窗口）承载 PDF/全屏阅读。
- 产出：默认方案选择（嵌入 / 子窗口 / 混合）。

### 3.8 poc-webview-probe
- `GetAvailableCoreWebView2BrowserVersionString` + 注册表三处 `pv` 读取；输出 `WebViewAvailability`。
- 环境：卸载 WebView2 的 Windows 10 虚拟机、低版本 WebView2、企业策略禁用、正常机器。
- 验证 P8：未调用探测前，进程模块中没有 `WebView2Loader.dll`（delay-load 或动态加载方案二选一）。

### 3.9 poc-window
- 自绘标题栏：拖动、双击最大化、Snap Layouts（Win11 悬停最大化按钮）、DPI。
- 托盘：`tray-icon` 或 GPUI 平台能力；菜单“显示/退出”。
- 第二窗口：透明、置顶、无边框、不进任务栏、可拖动、点击穿透（可选）。
- 单实例互认：核实 `tauri-plugin-single-instance` 2.4.x 在 Windows 上使用的互斥/命名管道名与参数转发格式；GPUI 侧实现同名互斥并验证 Tauri 已运行时 GPUI 能转发参数、反之亦然。

### 3.10 基线测量（Tauri 版）
- 机器：至少两台 Windows（独显 + 核显），记录 CPU/GPU/内存/系统版本/DPI。
- 指标：冷启动到首帧可交互（进程启动 → 首个可点击帧，用屏幕录制 + 日志时间戳双校验）、空闲内存（主进程 + WebView2 全部子进程 + daemon 的 Private Working Set 合计）、常驻进程数、`cat` 100 MB、键入延迟 p95、8 分屏帧率、空闲 10 分钟 CPU 唤醒次数（`powercfg /energy` 或 ETW）。
- 脚本：`bench/` 下 Node/PowerShell 脚本，后续迁移为 `scripts/bench/run-baseline.mjs`，GPUI 版复用同一脚本。

### 3.11 P5 现状核实
- 阅读 `src-tauri/src/features/history/scan_state.rs`、`live_transcript.rs`、`catalog.rs`：是否按文件记录偏移/mtime/size、是否支持截断重写检测、实时转录的线程模型。产出“增量尾读需补齐能力清单”。

## 4. 结论模板（research/poc-results.md）

| PoC | 结论 | 关键数据 | 条件/额外工作 | 对父 design 的修订 |
|---|---|---|---|---|

外加 Go/No-Go 总结、风险更新（父 design §11）、M1 开工前需要调整的事项。

## 5. 不做的事

- 不改 `src/`、`src-tauri/`、daemon 源码；不提交 daemon 协议改动。
- 不追求 PoC 代码质量；PoC 代码不得被正式 crate 依赖（正式实现重新编写）。
