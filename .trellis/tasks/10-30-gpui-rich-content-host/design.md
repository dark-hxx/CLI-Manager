# 设计：PreviewHost（预览按需系统 WebView）+ 原生 Markdown / 编辑器

> 上游：父 `design.md` §6；poc-gates 的 poc-preview / poc-webview-probe / poc-editor 结论（默认嵌入方案、截图占位可行性、编辑器能力缺口）。

## 1. crate 与模块

```
crates/preview/                 # 不依赖 GPUI；平台代码 cfg 隔离
  probe.rs          # WebViewAvailability 探测（Windows webview2-com 动态加载；macOS 常量；Linux Unsupported）
  host.rs           # WebViewHost：创建/复用/回收/超时/熔断状态机（平台无关部分）
  platform/{windows.rs, macos.rs}   # wry 子 WebView / 子窗口实现
  protocol.rs       # climgr-preview:// 处理器：路由、白名单、MIME、Range（PDF）
  bridge.rs         # 消息协议 v1（render/setTheme/openLink/copy/shortcut/ready/error）
  assets/markdown-preview/          # 构建期嵌入的静态页面（index.html + js + css + katex fonts）
apps/desktop-gpui/src/content/
  preview_slot.rs   # PreviewSlot Element：bounds 同步、Airspace、截图占位
  preview_panel.rs  # 预览面板视图（标题、刷新、外部打开、提示条）
  markdown/         # 原生 Markdown 渲染器（pulldown-cmark → GPUI）
  editor/           # 原生代码编辑器封装（基于 gpui-component Editor）
  conflict/         # 三栏冲突视图
  fallback/         # HTML 源码视图、PDF 信息卡
```

## 2. 可用性探测

```rust
pub enum WebViewAvailability { Available{engine, version}, Missing, Outdated{version, min}, Unsupported, DisabledByUser, Failed{reason} }
pub struct Probe { cache: OnceCell<WebViewAvailability>, breaker: AtomicBool }
```
- 顺序：用户设置“预览不使用 WebView” → `DisabledByUser`；熔断已触发 → `Failed`；平台 Linux → `Unsupported`；Windows：动态加载 `WebView2Loader.dll`（随包分发，受控绝对路径）→ `GetAvailableCoreWebView2BrowserVersionString(null)`；失败再读注册表 `pv`（HKLM/HKCU/WOW6432Node 的 `{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}`），有版本号但调用失败 → `Failed`，无版本号 → `Missing`；版本 < 最低要求（以 wry 依赖的 WebView2 SDK 要求为准）→ `Outdated`。
- 懒执行（第一次打开预览时），探测在 tokio blocking 线程执行，结果缓存；设置页“重新检测”清缓存与熔断。
- P8：`WebView2Loader.dll` 通过 `LoadLibraryExW(abs_path, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR)` 动态加载（或 MSVC `/DELAYLOAD`，按 M0 结论二选一），保证不打开预览时不加载。

## 3. 宿主状态机

```
Idle ──open(req)──► Probing ──Available──► Creating ──ready(≤3s)──► Showing ⇄ Hidden ──(60s)──► Disposed→Idle
                       │                       └─timeout/err──► Failed（熔断）→ Fallback
                       └─非 Available──► Fallback
```
- 每个窗口最多一个 `WebViewInstance`；不同预览内容复用同一实例（`navigate`/`postMessage render`）。
- 打开流程：立即显示原生降级内容（Markdown 原生渲染 / HTML 源码 / PDF 信息卡）→ 并行创建 WebView → `ready` 消息到达后切换为 WebView 并淡入；超时则保持降级并 toast 一次。
- 回收：预览面板关闭或所在 pane 隐藏（切 Tab、折叠）开始计时 60 s（设置可调 15–600 s），到期销毁实例；期间再次显示则取消计时。
- 窗口最小化/隐藏到托盘：立即 `set_visible(false)`；恢复时重设 bounds 与可见性。

## 4. 嵌入与 Airspace

- `PreviewSlot` 在 `paint` 阶段记录自身 bounds（逻辑像素）→ 乘以 scale factor → 相对窗口客户区的物理像素 → `webview.set_bounds()`（仅变化时调用）。
- DPI 变化（GPUI `on_scale_factor_change` 或窗口移动到不同 DPI 显示器）：重新计算 bounds；Windows 上同步 `RasterizationScale`（wry 若未暴露则通过 `ICoreWebView2Controller3` 设置）。
- Airspace：
  - `OverlayRegistry`（shell-foundation 的 ui_kit 浮层统一注册：Popover/Menu/Dialog/Toast/Drawer/拖拽预览）提供当前所有浮层矩形；
  - 每帧检测与 slot 相交 → 进入 `Occluded`：截图（`CapturePreview` 到 PNG → GPUI image）显示在 slot 中，隐藏 WebView；浮层消失后恢复；
  - 分屏拖拽、窗口缩放进行中 → 同样进入 `Occluded`；
  - 截图失败时显示纯色占位 + 标题。
- 焦点：WebView 内注入脚本捕获已注册的全局快捷键（由 Keymap 导出白名单）→ `shortcut` 消息 → GPUI dispatch action；Esc 把焦点还给 GPUI；窗口重新激活时若上次焦点在 GPUI，调用 `MoveFocus` 回主窗口（规避 tauri #15624 类问题）。
- 备选方案（M0 选择）：PDF / 全屏阅读用独立无边框 owned 子窗口，跟随主窗口移动与最小化，彻底无 Airspace；配置项 `preview.hostMode = embedded | window | auto`。

## 5. 协议、桥接与安全

| 路由 | 内容 | 规则 |
|---|---|---|
| `climgr-preview://app/markdown/` | 内置 Markdown 预览页 | 只读嵌入资源 |
| `climgr-preview://file/<token>/<rel-path>` | 本地 HTML 及其资源、Markdown 相对图片 | `token` 映射到一个“根目录”（文件所在项目根，或无项目时文件所在目录）；规范化路径后必须仍在根内；拒绝符号链接逃逸；拒绝隐藏敏感文件（`.env`、私钥等，与 everything 风格的 denylist 一致） |
| `climgr-preview://pdf/<token>` | PDF 字节流 | 支持 Range；`Content-Type: application/pdf` |
| Live Server | `http://127.0.0.1:<port>` | 沿用 `features/files/live_server`；只允许该端口导航 |

- 导航拦截：除上述来源外的导航一律取消并交给系统浏览器（`openLink` 同理）；新窗口请求同样外部打开。
- CSP（Markdown 页）：`default-src climgr-preview:; img-src climgr-preview: data: https:; style-src climgr-preview: 'unsafe-inline'; script-src climgr-preview:`；远程图片可在设置中关闭（去掉 `https:`）。
- 消息协议 v1：`{v:1, id, type, payload}`；未知 type 丢弃；payload 大小上限 8 MiB；`render` 由 GPUI 发出（Markdown 源文本 + 基础路径 token + 主题）。
- DevTools：仅 debug 构建开启。
- 用户数据目录：`appLocalData/webview2-preview/`，与 Tauri 版的 WebView2 数据分开；首次创建时清理过期缓存（> 30 天）。

## 6. 原生 Markdown 渲染器

- 解析：`pulldown-cmark`（GFM：表格、任务列表、删除线、脚注、自动链接）；数学 `$...$`/`$$...$$` 识别为 Math 节点 → 渲染为等宽源码块（灰底 + “公式”标签）。
- 渲染：解析结果转为自有 `MdBlock` 树（后台线程完成）→ GPUI 元素；长文档按块虚拟化（转录可能上万行）。
- 代码块：tree-sitter 高亮（与编辑器共用语言注册表与主题）；复制按钮。
- 图片：仅允许项目根白名单内的本地图片与 data URI；远程图片默认显示链接占位（设置可开启加载，异步下载、大小上限）。
- 链接：外部链接系统浏览器打开；`#anchor` 内部跳转；本地文件链接 → 文件预览。
- 选择与复制：块级与文本级选择；复制为 Markdown 源或纯文本。
- 使用方：历史转录（`HistoryMarkdownContent`、`SessionDetailPane`）、提示词预览、About、Markdown 预览降级路径。

## 7. 原生代码编辑器

- 基于 gpui-component Editor（按 M0 结论）；`ui_kit::CodeEditor` 封装统一 API：`open(path|text, lang)`、`dirty`、`save`、`on_change`、诊断标记（行列 + 消息）、只读模式、查找替换、跳转行、软换行、缩进设置、编码与换行符保留（读取时检测 BOM/CRLF，保存时保持）。
- 大文件：> 5 MB 默认只读并提示；> 50 MB 拒绝打开，提供外部打开。
- JSON 模式：保存前/输入防抖 300 ms 校验，错误定位到行列（MCP 配置、Provider 文档编辑器、Codex/Claude 配置）。
- 冲突三栏：`conflict/`：解析冲突标记 → ours/base/theirs 三栏 + 结果栏；同步滚动；逐块“采用左/右/两者”；结果可直接编辑；保存前校验无残留标记。替代 `ConflictMonacoEditor`、`ConflictBlockEditor`。
- Diff 不在此处（workspace-features 的 Hunk Diff 自绘）；`MonacoDiffFallback` 的场景由原生 Diff 覆盖。
- 能力缺口（M0 列出的）在 `ui_kit` 内补齐，不引入 WebView。

## 8. 降级 UX

- 提示条（预览区顶部，非阻塞）：根据状态显示文案：Missing / Outdated / Failed / DisabledByUser / Unsupported 各一套；按钮：[在浏览器/默认应用中打开] [安装 WebView2 运行时…]（仅 Missing/Outdated 且 Windows）[重试]（Failed）[不再提示]（写偏好）。
- “安装 WebView2 运行时…”：打开微软官方下载页；或在用户二次确认后运行随包附带的已签名 Evergreen Bootstrapper（是否随包附带由 desktop-integration 决定）；绝不静默下载。
- 设置 → 外观 → 预览渲染：状态、引擎、版本、最近一次失败原因、[重新检测]、开关“预览不使用 WebView”、“回收时间”、“加载远程图片”、宿主模式（若 M0 选择支持）。界面由 settings-panels 实现，数据接口由本任务提供。

## 9. 指标

| 指标 | 目标 | 测量 |
|---|---|---|
| 首次打开预览出现内容 | ≤ 600 ms（原生降级内容） | 日志时间戳 |
| WebView 冷创建就绪 | 记录（不设硬指标）；> 3 s 熔断 | 日志 |
| 复用切换 | ≤ 100 ms | 日志 |
| 回收后 WebView 进程退出 | ≤ 60 s + 5 s | 进程列表 |
| 未打开预览时 WebView2Loader.dll | 不在模块列表 | ListDLLs |
