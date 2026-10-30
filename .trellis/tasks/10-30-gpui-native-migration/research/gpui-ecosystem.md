# GPUI 生态与按需 WebView 调研（2026-10-30）

> 来源以搜索摘要为主，crates.io / GitHub 页面未能逐页抓取。标 **[待核实]** 的结论必须在 Phase 0 PoC 中用源码/实机确认，禁止直接作为设计前提。

## 0. 用户决策（2026-10-30，覆盖下文中的相关推荐）

- GPUI 依赖固定为 crates.io `gpui-pre 0.3`（Zed 2026-09 快照），不使用 git rev。下文“推荐依赖方式”一行作废。
- 单进程：按项目现状解释为“界面单进程”，GPUI 版保留 PTY daemon 与 web-daemon（见父 design §0.1）。
- 仅预览（Markdown 文件 / HTML / PDF）按需嵌入系统 WebView；Markdown 阅读与代码编辑全部原生，Monaco 移除。下文 §6 中“代码编辑按需 WebView 加载 Monaco”作废。
- 仍需在 M0 核实：gpui-pre 0.3 的传递依赖许可证；gpui-component 能否编译在 gpui-pre 0.3 上。

## 1. GPUI 本体

| 项 | 结论 | 置信度 |
|---|---|---|
| 分发 | crates.io `gpui` 最新约 0.2.x，明显落后于 Zed 主干（zed issue #66275 指出缺新输入事件）；社区有 `gpui-pre` 等快照 | 中 |
| 推荐依赖方式 | `git = "https://github.com/zed-industries/zed", rev = "<固定 rev>"` 引用 `crates/gpui`，或与 gpui-component 要求的版本对齐 | 高 |
| 许可证 | `gpui` crate 声明 Apache-2.0；但 zed issue #55470 称默认依赖链（`sum_tree -> ztracing` 等）可能拉入 GPL-3.0-or-later | **[待核实]** |
| Windows | DirectX 11 渲染 + DirectWrite 文字，Zed Windows 版已正式发布；早期第三方 FAQ 称有视觉问题，新旧信息矛盾 | 中 **[待核实]** |
| macOS | 最成熟（Metal） | 高 |
| Linux | Wayland/X11 可用，成熟度低于 macOS | 中 |
| API 稳定性 | pre-1.0，破坏性变更频繁 → 必须锁 rev、集中封装 | 高 |
| 中文 IME（Windows） | zed issue #56327 报告 Windows 中文 IME 组合态问题，修复状态未知 | **[待核实]，硬门槛** |
| 无障碍（a11y） | 未找到可靠资料，按“不可用”假设 | 低 |

## 2. gpui-component（longbridge，Apache-2.0）

- 宣称 60+ 组件：Input、Table、List、Dock/Tabs、Tiles、Sidebar、Modal、Drawer、Popover、Menu、Tree、Resizable、Chart、Markdown/TextView、代码编辑器（tree-sitter）等。
- 版本 0.x，依赖特定 GPUI rev；需与本项目 GPUI rev 锁定一致。
- `webview` feature：基于 wry（文档要求特定分支），官方标注“early and experimental”。
- **[待核实]**：VirtualList、Tree、Markdown、Editor、Chart 的实际成熟度、IME 与大数据性能，需逐项 PoC。

## 3. 在 GPUI 中嵌入系统 WebView

- 方案：`wry::WebViewBuilder::build_as_child(&gpui_window)`（GPUI Window 实现 raw-window-handle 0.6）。社区 `gpui-wry` 封装仅支持 macOS/Windows。
- **Airspace 约束**：WebView 是原生子窗口，永远盖在 GPUI 绘制内容之上 → GPUI 的 Popover/Menu/Modal/Toast 不能覆盖 WebView 区域。设计上必须：打开浮层时隐藏/截图冻结 WebView，或把 WebView 放在独立窗口/独占面板。
- Windows 已知问题：
  - `set_bounds` 坐标相对父窗口客户区（wry #1875）；
  - Alt+Tab 后键盘焦点落在 WebView2 子 HWND（tauri #15624）；
  - PerMonitorV2 DPI 变化需手动重算 bounds / RasterizationScale；
  - 最小化/还原时子窗口状态同步。
- Linux：WebKitGTK 子嵌入需要 X11 Xlib handle，GPUI 不提供 → **Linux 视为“无内嵌 WebView”，走独立窗口或降级**。

## 4. 终端渲染与许可证

- Zed 的 `terminal` / `terminal_view` crate 属 Zed GPL 代码 **[待核实具体 Cargo.toml license 字段]**；本项目为 AGPL-3.0-or-later + 商业双授权，**禁止复制或依赖 Zed 的 GPL crate**（会破坏商业授权）。
- 可用：`alacritty_terminal`（Apache-2.0，crates.io）作为 VT 状态机 + Grid；渲染层自写 GPUI Element（参考思路，不抄代码）。
- 备选：`vte`（仅解析器，需自建 grid）、`wezterm-term`（MIT，**[待核实]**）。
- 需要自研：选区、搜索、超链接检测、Sixel/iTerm 图片（xterm addon-image 等价物）、Kitty 键盘协议、OSC 133/633 shell 集成解析（后端已有 `boundary.rs` 可复用部分）。

## 5. WebView2 运行时检测与降级

- 检测：`webview2-com` 调 `GetAvailableCoreWebView2BrowserVersionString`；失败或版本低于最低要求视为缺失。备用：注册表 `EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}` 的 `pv`（HKLM / HKCU / WOW6432Node）。
- 策略：**禁止静默下载安装**。缺失时 →（a）原生简版渲染；（b）“在系统浏览器中打开”；（c）用户确认后打开微软 Evergreen Bootstrapper 下载页。
- macOS WKWebView 系统自带；Linux 依赖 WebKitGTK 动态库是否存在（运行时 `dlopen` 探测）。

## 6. 富内容原生替代

| 内容 | 原生方案 | 备注 |
|---|---|---|
| Markdown | `pulldown-cmark`/`comrak` → GPUI 富文本；gpui-component TextView **[待核实]** | KaTeX/Mermaid 原生难，交给 WebView 或以源码块降级 |
| 语法高亮 | tree-sitter（增量、质量高）或 `syntect`（简单） | 文件预览/Diff 共用 |
| Diff | `similar` crate + 原生虚拟列表 | 后端已有 git2 产出 hunk |
| 图表 | gpui-component Chart **[待核实]** 或自绘（GPUI `canvas` + path） | 统计页数据量小，可自绘 |
| 代码编辑 | gpui-component Editor **[待核实]**；不足时按需 WebView 加载 Monaco | Monaco 体积大，仅按需 |

## 7. 他人迁移经验（多为 Electron→GPUI）

- 保留旧壳作为回滚版本，直到新壳 beta 通过；同机性能对比作为发布门禁。
- 新旧壳共享数据目录/端口时不可同时运行 → 需要单实例互斥与数据格式兼容。
- 长耗时任务阻塞 GPUI 主线程会卡 UI → 一律走 `cx.background_executor()`。

## 来源（摘要级，需复核）

- https://crates.io/crates/gpui
- https://github.com/zed-industries/zed/issues/66275
- https://github.com/zed-industries/zed/issues/55470
- https://github.com/zed-industries/zed/issues/56327
- https://github.com/longbridge/gpui-component
- https://crates.io/crates/gpui-component
- https://docs.rs/crate/gpui-wry/latest
- https://github.com/huacnlee/gpui-wry-example
- https://github.com/zed-industries/zed/pull/13730
- https://github.com/tauri-apps/wry/issues/1875
- https://github.com/tauri-apps/tauri/issues/15624
- https://github.com/MicrosoftEdge/WebView2Feedback/blob/main/specs/RasterizationScale.md
- https://learn.microsoft.com/en-us/dotnet/api/microsoft.web.webview2.core.corewebview2environment.getavailablebrowserversionstring
- https://crates.io/crates/alacritty_terminal
- https://github.com/zed-industries/alacritty
- https://github.com/apotenza92/butter-paper/issues/41
- https://github.com/biw/electron-gpui
