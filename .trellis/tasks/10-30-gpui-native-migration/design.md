# 技术设计：GPUI 原生桌面壳（界面单进程）+ 预览按需系统 WebView

> 输入：`research/gpui-ecosystem.md`、`research/frontend-inventory.md`、`research/backend-coupling.md`、`research/perf-opportunities.md`。
> 标 **[PoC]** 的设计点依赖 M0（`gpui-poc-gates`）的验证结论，验证不通过时按 §11 调整。
> 各子任务的详细设计见各自目录下的 `design.md`；本文只定义跨子任务的架构与契约。

## 0. 已确认的约束与解释（2026-10-30）

| 约束 | 含义 |
|---|---|
| **gpui-pre 0.3** | GPUI 依赖固定为 crates.io 的 `gpui-pre = "0.3"`（Zed 2026-09 快照），不使用 git rev |
| **GPU 原生渲染** | 所有常规 UI（终端、Markdown 阅读、代码编辑、Diff、图表、设置）都由 GPUI 原生绘制；Monaco 移除 |
| **单进程** | 见 §0.1（按项目现状解释） |
| **仅“预览”按需嵌入系统 WebView** | 只有 Markdown 文件预览、HTML / Live Server 预览、PDF 预览会按需创建 WebView |

### 0.1 “单进程”的范围（根据项目现状决定）

**界面与业务逻辑是单进程**：UI、业务核心（`crates/core`）、文件/Git watcher、历史索引、WebDAV 同步、Provider/统计/设置逻辑、statusline、Web 设备 Operation 执行器都在 `cli-manager` 一个进程内运行。没有 WebView 渲染进程、没有 JS 运行时、没有 Tauri IPC 序列化——这是 Tauri 版内存与延迟开销的主要来源，也是本次迁移要消除的部分。

**保留两个用途单一的辅助进程**。理由来自项目已发布的契约，取消它们会让现有功能退化或削弱安全边界：

| 辅助进程 | 保留理由 | 依据 |
|---|---|---|
| `cli-manager-daemon`（后台服务宿主：PTY 会话 + Hook 上报接收端口 + 本地 Provider 路由 HTTP 代理 + SSH Agent 桥） | ① “转入后台”退出 UI 后任务继续运行（Issue #123，已发布功能）；② Hook 端口写进 PTY 子进程环境变量，必须比 UI 活得久，UI 重启后 CLI 的 Hook 上报仍然有效；③ 应用自更新、UI 崩溃时不丢会话、不断路由；④ GPUI 版与 Tauri 版可互相 attach 对方会话，双轨期无损切换；⑤ 现行契约已删除进程内 PTY 路径，明确禁止回落 | `.trellis/spec/frontend/background-task-continuation-contracts.md`、`.trellis/spec/backend/pty-daemon-contracts.md` |
| `cli-manager-web-daemon`（远程设备连接） | 刻意的权限隔离：面向公网的设备 WebSocket 放在一个没有 Tauri/文件系统权限的进程里，设备 Operation 由主进程执行 | `src-tauri/src/web_daemon.rs` 文件头、`.trellis/spec/backend/web-service-contracts.md` |

生命周期沿用现状：daemon 由 UI 在首帧之后的后台线程发现或拉起（不阻塞首帧），无会话且无客户端 10 分钟自灭，退出时按契约 `close_all → shutdown_if_idle`；web-daemon 只在用户启用 Web 服务时启动。

其他仍为独立进程、但不属于 UI 架构的：Claude/Codex 拉起的 Hook 上报端、`cli-manager-codex-proxy`、ConPTY 的 conhost、用户 shell 子进程，以及打开预览时系统 WebView 自带的浏览器进程（预览回收后退出）。

**被否决的方案**：PTY 进程内托管（丢失后台继续、更新/崩溃不丢会话、两壳会话互通，且违反契约）；web-daemon 并入主进程（削弱权限隔离）。`PtyHost` 仍是 trait，未来如需“无 daemon 便携模式”可追加实现，不在本计划内。

## 1. 决策摘要

| # | 决策 | 理由 |
|---|---|---|
| D1 | **并行新壳（绞杀者模式）**：新增 `apps/desktop-gpui`，Tauri 版继续发布直到功能对齐 | 16 万行前端无法一次性重写；任何时刻都有可发布、可回退的版本 |
| D2 | **先抽核心 crate**（`crates/core`、`core-db`、`core-prefs`），两壳共用 | 后端约 85% 逻辑不依赖 Tauri；避免两份业务逻辑分叉 |
| D3 | **保留 PTY daemon 与协议**；GPUI 通过新 Rust 客户端 `crates/pty-client` 走 WebSocket 二进制帧接入 | 见 §0.1；协议只做向后兼容扩展 |
| D4 | VT 内核用 **`alacritty_terminal`（Apache-2.0）**，渲染层自研 GPUI Element | 禁止 Zed GPL crate，需与商业双授权兼容 |
| D5 | GPUI 用 **`gpui-pre 0.3`**；组件优先 gpui-component（Apache-2.0），通过 `[patch.crates-io]` 让其使用 gpui-pre，不行则维护适配 fork **[PoC]** | 用户指定版本；组件库与 GPUI 版本必须一致 |
| D6 | **WebView 只用于三类预览**，由 `PreviewHost` 按需创建、闲置回收；缺失时降级或提示 | 用户约束；常规路径零 WebView |
| D7 | 数据层零迁移：同一 SQLite、同一 `_sqlx_migrations`、同一偏好 JSON、同一 daemon | 双壳可来回切换 |
| D8 | 预览内容通过自定义协议 + 白名单提供，**不为预览启本地 HTTP 端口**（Live Server 除外，它本来就有本地服务） | 缩小攻击面 |
| D9 | **Monaco 全部移除**，代码编辑一律使用原生编辑器 | 只有预览允许 WebView |
| D10 | 建立仓库根 **Cargo 虚拟 workspace**，统一 `src-tauri`、`crates/*`、`apps/server`、`apps/desktop-gpui`；`.cargo/config.toml` 固定 `target-dir = "src-tauri/target"` 以保持现有脚本与 CI 的产物路径 | 新增多个 crate 后避免重复编译与依赖版本漂移，同时不破坏打包脚本 |

## 2. 目标结构

```
Cargo.toml              # 新：根虚拟 workspace；统一 [workspace.dependencies] 与 [profile.*]
.cargo/config.toml      # 新：target-dir = "src-tauri/target"
crates/
  core/                 # 去 Tauri 化的业务核心（features/* + infrastructure/*）
  core-db/              # 中立迁移定义 + 连接池 + Repository（原前端 SQL 收拢于此）
  core-prefs/           # 偏好 JSON 读写（兼容 tauri-plugin-store 文件）
  pty-client/           # daemon WebSocket 二进制协议的 Rust 客户端（Rust 版 PtyHostSocket）
  term-engine/          # alacritty_terminal 封装 + OSC/键盘/鼠标扩展 + ANSI 序列化
  preview/              # WebView 能力探测、按需宿主、预览桥接
  web-protocol/ history-core/ hook-schema/ agent-capabilities-core/ ...  # 已有
apps/
  desktop-gpui/         # GPUI 桌面壳（bin: cli-manager-gpui，切换期后改名 cli-manager）
  server/ web/ web-tap/ # 已有，不动
src-tauri/              # 迁移期保留：Tauri 命令适配层
                        # daemon / web-daemon / codex-proxy 二进制改为只依赖 core，不再链接 Tauri
```

依赖方向（禁止反向，由 `cargo deny` bans 或 CI 脚本检查）：
- `apps/desktop-gpui` → `core*`、`pty-client`、`term-engine`、`preview`
- `src-tauri` → `core*`
- `core` → `core-db`、`core-prefs`、已有共享 crate
- `pty-client`、`term-engine`、`preview` 不依赖 `core`（独立可测）

## 3. 核心抽取（crates/core）

### 3.1 去 Tauri 化接口

```rust
pub trait EventSink: Send + Sync + 'static {
    fn emit(&self, event: CoreEvent);
}
pub enum CoreEvent {               // 强类型，取代字符串事件名；完整列表见 core-extraction/design.md §3
    HookNotification(HookNotification),
    GitChanged { repo: PathBuf, paths: Vec<PathBuf> },
    ProjectFilesChanged { root: PathBuf, paths: Vec<PathBuf> },
    HistoryIndexStatus(IndexStatus),
    SubagentTranscriptAppend(..), SystemNotificationAction(..),
    OpenTerminalRequested(..), BackgroundTaskActivateRequested(..),
    TrayQuitRequested, WebDeviceStatusChanged(..), WebDeviceOperationReady(..),
    WebServerStatusChanged(..), SshAgentHookGap(..), SshAgentInstallProgress(..),
    RequestLogAppended(..), UsageUpdated { session_id: String },   // P1 新增
    DesktopPet(DesktopPetEvent),
}
pub trait AppPaths: Send + Sync { /* data_dir / resource_dir / log_dir / app_local_data_dir / config_dir */ }
pub trait UiServices: Send + Sync { /* pick_file / pick_folder / save_file / clipboard / open_external */ }
pub struct AppContext {
    pub paths: Arc<dyn AppPaths>, pub events: Arc<dyn EventSink>, pub ui: Arc<dyn UiServices>,
    pub daemon: Arc<DaemonBridge>, pub db: DbPools, pub prefs: PrefsStore,
    pub runtime: tokio::runtime::Handle,
}
```

- Tauri 适配：`TauriEventSink` 把 `CoreEvent` 映射回原事件名 + payload（**事件名与 JSON 形状不变**，React 端无感知），映射表用快照测试锁定。新增事件在 Tauri 侧不映射（Tauri 版维持轮询现状）。
- GPUI 适配：`GpuiEventSink` 把事件投递到 `async_channel`，主线程消费后更新对应 Entity。
- `DaemonBridge`/`DaemonClient`（现有 `src-tauri/src/infrastructure/daemon/client.rs`）迁入 core，`AppHandle` 依赖改为 `EventSink`：负责 daemon 发现/拉起、NDJSON 控制面请求（list/status/reconcile/shutdown/routing/ssh_agent）、Hook 与 SSH Agent 事件转发。两壳共用；只有 PTY 数据面客户端不同（Tauri 版 = WebView 中的 `PtyHostSocket`，GPUI 版 = `pty-client`）。
- daemon 服务端（`infrastructure/daemon/server*`、`routing`、`route_http`、`ssh_agent_bridge`）与 `infrastructure/pty/*` 一并迁入 core（或独立 `crates/daemon`），daemon 二进制不再链接 Tauri。

### 3.2 命令层

- core 对外是普通 async 函数：`core::git::status(&ctx, req) -> Result<Resp, CoreError>`；`CoreError` 序列化后与现有错误字符串一致。
- `src-tauri` 的 440 个 `#[tauri::command]` 变为一行转发（入参/出参 serde 形状不变），`invoke_handler![]` 不变。
- GPUI 直接调用 core 函数，没有序列化开销。

### 3.3 数据库（crates/core-db）

- 迁移定义改为中立结构 `{version, description, sql}`：Tauri 版转成 `tauri_plugin_sql::Migration`，GPUI 版用 `sqlx::migrate::Migrator`。
- **硬约束**：两条路径写入 `_sqlx_migrations` 的 `version/description/checksum` 逐字节一致（双路径迁移空库后比对的测试）。
- 连接池（P2）：每个库一个 `DbPool { writer: 1, readers: N }`，统一 PRAGMA，预编译语句缓存；替换 features 中约 135 处临时连接。
- 前端约 117 处 SQL（约 20 张表）收拢为 Repository。
- 启动前仍执行 `db_repair_known_migration_drift`。

### 3.4 偏好（crates/core-prefs）

- 读写 `settings.json`、`sessions*.json`、`sync-config.json`、`external-session-sync.json`、`extension-list-order.json`、`data-root.json`。
- 原子写（临时文件 + rename）+ 进程间文件锁；`#[serde(flatten)] extra` **原样保留未知字段**。
- 默认值与旧字段迁移从 `src/shared/preferences/settingsStore.ts` 移植，对照测试。

## 4. GPUI 壳（apps/desktop-gpui）

### 4.1 应用骨架

- `gpui = { package = "gpui-pre", version = "=0.3.x" }`；gpui-component 通过 `[patch.crates-io]` 使用 gpui-pre 或适配 fork **[PoC]**。
- 初始化：tokio runtime（独立线程池）、`AppContext`、主题、i18n、Keymap，然后打开主窗口（无边框、自绘标题栏，Snap Layouts **[PoC]**）。
- 状态模型：每个 Zustand store 对应一个 `Entity<T>`；跨模型通过 `WeakEntity` 或 `cx.global::<Services>()`。
- 所有 IO 走 `cx.background_executor()` 或 tokio，主线程只做状态变更与绘制。
- `ui_kit`：对 gpui-component 的薄封装，业务代码只依赖 `ui_kit`（隔离 gpui-pre 升级冲击）。
- i18n：`shared/i18n` 字典由脚本导出 JSON，React 与 GPUI 共用源字典；简繁转换 Rust 库 **[选型]**。
- 图标：lucide 与 @lobehub/icons 导出 SVG 资产。

### 4.2 启动时序（P6）

1. 读偏好；2. 打开主库连接池；3. 加载项目树 → **首帧**。
4. 首帧后（后台）：sync/session 元数据、model pricing 预热、历史索引、ccusage 缓存、自动同步、更新检查、按设置启动 web-daemon。
5. 首帧后在后台连接或拉起 daemon（与 Tauri 版 `lib.rs` 现状一致，Hook 与路由依赖它）；连接成功后执行 `reconcile_persisted_service`。不在启动时恢复终端（遵循 `workspace-session-restore-contracts.md` 与 session-restore-mode），后台会话只在用户选择时 attach。
- 字体：全局懒加载缓存（合并 `statusline/mod.rs:385` 与 `system/fonts.rs:21`）。

### 4.3 进程内长期服务

文件/Git watcher、历史索引与实时转录 watcher、WebDAV 自动同步、statusline、Live Server、DaemonClient（接收 daemon 转发的 Hook 通知与 SSH Agent 事件）、Web 设备 Operation 执行器（原 `useWebDeviceBridge.ts` 的职责，通过 loopback NDJSON 与 web-daemon 通信，协议与 Tauri 版相同）。

### 4.4 低功耗模式（P1）

窗口失焦/最小化/隐藏到托盘：停止光标闪烁与动画、暂停资源采样与 statusline 刷新、合并重绘；恢复时立即刷新一次。

## 5. 终端

### 5.1 数据通路

```
cli-manager-daemon ──WS 二进制帧──► pty-client (tokio) ──Bytes──► term-engine（每会话后台解析）──damage──► TerminalElement（主线程每帧）
GPUI 输入 ──► term-engine 键盘编码 ──► pty-client.write（ws_binary_input_v1）──► daemon
```

- `pty-client` 完整移植 `src/features/terminal/transport/PtyHostSocket.ts`（1,258 行）：bootstrap、首帧 token 鉴权、心跳 5 s / 15 s、重连后 attach 并按已提交 sequence 过滤 replay、create 响应丢失的 attach 探测、本地 tombstone、退出守卫的 close_all → shutdown_if_idle 顺序。`pty-daemon-contracts.md` 每条契约对应一个测试。
- 协议向后兼容扩展（daemon 侧，同步更新契约文档）：
  - `ws_ack_bytes_v1`：客户端声明后 ACK 按字节计数；Tauri 版不声明则行为不变。
  - 原生客户端鉴权：当前 Origin 只允许 Tauri localhost 与本地 dev origin；扩展为允许“无 Origin 头 + 首帧有效 token”的连接（仍只绑定 127.0.0.1），带 Origin 的浏览器连接校验规则不变。
  - `checkpoint_ansi_v1`：checkpoint 声明为标准 ANSI 重放流（§5.4）。
  - `session_status_push_v1`：daemon 在会话创建/退出/关闭/状态变化时主动推送 `session_status` 帧（P1，取代后台任务列表轮询）。
  - 客户端能力在 `Auth` 帧新增的 `client_features`（`#[serde(default)]`）中声明；daemon 在 `AuthOk.features` 中声明，双方取交集。具体帧格式见 `10-30-gpui-core-extraction/design.md` §6。

### 5.2 VT 引擎（crates/term-engine）

- 封装 `alacritty_terminal::Term`，补齐 Unicode 宽度/字素簇、OSC 133/633、OSC 8、OSC 52、OSC 颜色查询（`terminal_colors_v1`）、Kitty 键盘协议、鼠标上报（含 `470344d7`、`3ba3d707` 的修复语义）；Sixel/iTerm2 第一版占位。
- 移植 `src/features/terminal/browser/*` 与相关 lib 的兼容规则，每条附单元测试。

### 5.3 渲染（P3）

解析与绘制解耦（后台解析、主线程按帧读取 damage 快照）；同帧合并 damage；共享字形缓存与行 shaping 缓存；隐藏终端只解析不绘制（契约要求，不建 inactive raw buffer）；8 分屏 60 fps 硬指标 **[PoC]**。

### 5.4 Checkpoint 与跨壳 attach

- checkpoint 目前是 xterm SerializeAddon 产出的 ANSI 文本，由客户端上传、attach 时作为 replay 起点。
- `term-engine::serialize_to_ansi` 产出 xterm 与 alacritty 都能重放的 ANSI 流 → checkpoint 依旧与客户端无关，**两壳可以互相 attach 对方的会话**。
- 往返测试：xterm 序列化 fixture → alacritty 重放 → 再序列化 → xterm 重放，网格一致。不一致的特性（如图片）在 checkpoint 中丢弃并记录。

### 5.5 输入、IME 与剪贴板

`EntityInputHandler` 实现 IME 组合（Windows 中文 IME 硬门槛 **[PoC]**）；`ExternalPaths` 文件拖放 + `wsl_path` 转换；剪贴板图片粘贴复用 core 的 `clipboard_image`。

### 5.6 分屏树、Tab、后台任务

- `terminalPaneTree.ts`、`terminalWorkspan.ts`、`terminalStoreLayout.ts`、`terminalTabsModel.ts`、`terminalLayoutLock.ts` 的纯数据结构移植为 Rust，附测试。
- Tab 状态双数据源（hook + shell）与 `TAB_STATUS_PRIORITY` 合并移植为纯函数。
- 退出守卫完整遵循 `background-task-continuation-contracts.md`：ask / background（daemon 保留会话，UI 真退出）/ minimize / discard 四种分流，行为与 Tauri 版一致。
- 后台任务列表由 daemon 会话状态推送驱动（P1，取代 3 s 轮询）；孤儿会话对账保留，但由事件触发 + 低频兜底（不再固定周期）。

## 6. 预览：PreviewHost（按需系统 WebView + 降级）

> 详细设计见 `10-30-gpui-rich-content-host/design.md`。

| 预览类型 | WebView 增强 | WebView 不可用时 |
|---|---|---|
| Markdown 文件预览 | 完整 GFM + KaTeX + 代码高亮 + 相对图片与锚点 | 原生 Markdown 渲染器；公式以源码块显示 + 提示条 |
| HTML / Live Server | 嵌入面板，刷新、地址显示 | 高亮源码 + [在系统浏览器中打开] |
| PDF（新增） | 系统 WebView 内置 PDF 查看器 | [用默认应用打开] + 文件信息；Linux 固定走此路径 |

- 其余场景**禁止**创建 WebView（转录、提示词、About、Diff、编辑器、图表）。
- `WebViewAvailability`：Available / Missing / Outdated / Unsupported / DisabledByUser / Failed；懒探测、进程内缓存、失败熔断、设置页可重新检测。
- 生命周期：懒创建、每窗口 1 个共享实例、关闭或隐藏 60 s 后回收、3 s 创建超时回落；等待期间先显示原生降级内容。
- 嵌入：`wry` `build_as_child`；Airspace 规则（浮层相交、拖拽/缩放、最小化时隐藏并显示截图占位）；独立子窗口作为备选 **[PoC]**。
- 安全：`climgr-preview://` 自定义协议 + 项目根白名单 + CSP + 消息白名单；外链交给系统浏览器；独立的 `webview2-preview` 用户数据目录。
- 缺失提示：非阻塞提示条 + 设置页“预览渲染”状态区；**绝不静默安装 WebView2**。
- P8：WebView2Loader 延迟加载，不打开预览时不加载。

## 7. 双壳共存与数据兼容

- 同一 `identifier`（`com.cli-manager.app`）、同一数据目录、同一 daemon、同一 web-daemon。
- **同一时刻只运行一个 UI 壳**：GPUI 版实现与 `tauri-plugin-single-instance` 相同的互斥/通道名（M0 核实实现细节），后启动的一方把参数转发给已运行的一方后退出。
- 会话：两壳都是 daemon 的客户端，可以互相 attach（§5.4）；“转入后台”的会话在任一壳中都能找回。
- 偏好：未知字段保留；数据库：共用同一迁移列表，任何新增迁移必须进入 `core-db`。

## 8. 打包、更新、系统集成

> 详细设计见 `10-30-gpui-desktop-integration/design.md`。

- NSIS 继续使用（复用 `installer/hooks.nsh` 的 Explorer 右键与 `cleanup.ps1`）。GPUI 安装包含：GPUI 主程序、`cli-manager-daemon`、`cli-manager-web-daemon`、`cli-manager-codex-proxy`、Hook 上报端、conpty sideload 资源。
- 更新：自研更新器，复用 minisign 公钥与 GitHub `latest.json`（新增 `gpui` 平台键）；更新前沿用 Tauri 版的会话处理规则（有运行中会话时询问：转入后台后更新 / 结束会话后更新 / 取消），daemon 二进制只在空闲时替换。
- 托盘、通知、桌宠（同进程第二窗口 **[PoC]**）、日志（`CLI_MANAGER_DEBUG` 语义不变）。
- 构建参数：沿用现有 release profile（`lto = "fat"`、`codegen-units = 1`、`strip = "symbols"`、`panic = "abort"`）并迁到根 workspace；P7 只新增全局分配器 `mimalloc`（M0 测量后决定）。

## 9. 功能对齐清单（Parity Checklist）

| 域 | 原文件/目录 | GPUI 版实现 | 子任务 |
|---|---|---|---|
| 根壳/标题栏/关闭行为/退出遮罩 | `src/app` | 原生 | shell-foundation（UI）+ terminal-native（退出守卫） |
| 设置 | `features/settings` | 原生表单 | settings-panels |
| 项目树/分组/拖拽/Worktree/冲突解决 | `features/projects` | 原生树 + DnD + 原生三栏冲突视图 | workspace-features |
| 终端/分屏/Workspan/回放/后台任务 | `features/terminal` | 原生 + `pty-client` | terminal-native |
| 文件树/编辑 | `features/files` | 原生树 + 原生编辑器 | workspace-features |
| 文件预览（Markdown/HTML/PDF） | `features/files`、终端 Markdown 预览 | PreviewHost | rich-content-host + workspace-features |
| Git 面板/Diff/提交/引用/PowerTools | `features/git` | 原生 Diff | workspace-features |
| 历史浏览/转录/搜索/收藏 | `features/history` | 原生虚拟列表 + 原生 Markdown | workspace-features |
| 统计/图表/请求日志 | `features/stats` | 原生自绘 | settings-panels |
| 扩展（MCP/Skills） | `features/extensions` | 原生；JSON 用原生编辑器 | settings-panels |
| Provider/路由/快速切换 | `features/providers` 等 | 原生 | settings-panels |
| 同步（WebDAV） | `features/sync` | 原生 | settings-panels |
| SSH/远程 | `features/remote` | 原生 | settings-panels |
| 提示词/模板 | `features/prompts` | 原生 | settings-panels |
| 命令面板/快捷键/Workspan 栏 | `features/workspace` | GPUI Action/Keymap | shell-foundation |
| 桌宠 | `features/desktop-pet` | 同进程第二窗口 | desktop-integration |
| Web 服务设置/设备 Operation | `useWebDeviceBridge.ts`、settings | Operation 在主进程执行；web-daemon 保留 | desktop-integration |
| 托盘/单实例/更新/通知/Explorer 右键 | `lib.rs`、installer | 原生 | desktop-integration |

## 10. 子任务划分与依赖

| 顺序 | 子任务 slug | 交付 | 依赖 |
|---|---|---|---|
| 0 | `gpui-poc-gates` | 兼容性/许可证审查 + 7 个 PoC + Tauri 基线 + Go/No-Go | — |
| 1 | `gpui-core-extraction` | 根 workspace、`core`、`core-db`（连接池）、`core-prefs`、daemon 协议扩展；Tauri 版行为不变 | 0 通过 |
| 2 | `gpui-shell-foundation` | GPUI 骨架、窗口、主题、i18n、Keymap/命令面板、状态模型、启动时序、低功耗、分配器 | 1 |
| 3 | `gpui-terminal-native` | `pty-client`、`term-engine`、TerminalElement、IME、分屏树、Tab 状态、退出守卫 | 1、2 |
| 4 | `gpui-rich-content-host` | `preview` crate、原生 Markdown、原生编辑器、降级 UX | 2 |
| 5 | `gpui-workspace-features` | 项目树、文件、Git、历史 | 3、4 |
| 6 | `gpui-settings-panels` | 设置、扩展、Provider、同步、SSH、提示词、统计 | 2、4 |
| 7 | `gpui-desktop-integration` | 托盘、单实例、更新、通知、桌宠、Web 设备 Operation、安装包 | 2、3 |
| 8 | `gpui-release-cutover` | 性能验收、场景回归、双轨发布、Tauri 下线计划 | 5、6、7 |

3 与 4 可并行；5 与 6 可并行。

## 11. 风险与回退

| 风险 | 触发信号 | 应对 |
|---|---|---|
| gpui-pre 0.3 依赖链带入 GPL | M0 `cargo deny` 报 GPL | `[patch]` 替换或裁剪；无法替换则 No-Go |
| gpui-component 无法编译在 gpui-pre 0.3 上 | M0 编译失败 | 适配 fork；工作量过大时只 vendor 所需组件进 `ui_kit` |
| gpui-pre 后续快照破坏性变更 | 升级时大面积编译失败 | 固定 `=0.3.x`；`ui_kit` 隔离；按季度集中升级 |
| Windows 中文 IME 不可用 | M0 IME PoC 失败 | 上游修复 + `[patch]` 先行合入；不达标 No-Go |
| 终端渲染性能不达标 | 8 分屏 < 60 fps 或吞吐低于 xterm | 字形/行缓存优化；仍不达标则暂停终端迁移 |
| 原生编辑器能力不足 | M0 编辑器 PoC 不满足 | `ui_kit` 自研补齐；分期交付 |
| ANSI checkpoint 互操作不一致 | 往返测试失败 | 跨壳 attach 时退化为“原始 replay 窗口”重放；同壳 attach 不受影响 |
| 根 workspace 改变构建行为 | 打包脚本/CI 找不到产物、依赖解析冲突 | `.cargo/config.toml` 固定 target-dir；core-extraction 中同步核对脚本与 CI |
| daemon 协议扩展影响 Tauri 版 | Tauri 回归失败 | 扩展全部是 capability 协商，旧客户端不声明即旧行为；契约测试覆盖 |
| 预览 WebView Airspace/焦点问题 | PoC 中无法规避 | 改为独立子窗口承载预览 |
| 双壳数据互相破坏 | 偏好字段丢失或 checksum 不一致 | §3.3、§3.4 强制测试；发布前往返测试 |
| 工作量失控 | 子任务 5/6 大幅落后 | 双轨期允许 GPUI 版暂缺低频功能；严禁砍掉终端、项目、Git 主路径 |

**总回退**：任何阶段失败，Tauri 版仍是发布主线；core 抽取对 Tauri 版也有独立收益。

## 12. 备选方案（已否决）

- **PTY 进程内托管**：违反后台继续契约与“禁止进程内回落”条款；更新/崩溃丢会话；两壳会话不互通。
- **web-daemon 并入主进程**：削弱权限隔离。
- **Markdown 阅读/代码编辑也走 WebView**：违反“仅预览使用 WebView”约束。
- **只把终端换成原生、其余保留 WebView**：Airspace 落在最高频区域，WebView 常驻开销未消除。
- **egui / iced / Slint**：富文本与 IME 较弱或案例少；Slint 授权需评估。
- **直接使用 Zed 的 terminal_view**：GPL，与商业授权冲突。

## 13. 随迁移一并完成的性能优化

> 2026-10-30 用户确认：**P1–P8 纳入本计划**；P9–P12 暂缓（P9 中基础的虚拟滚动仍由 workspace-features 的既有验收覆盖）。详见 `research/perf-opportunities.md`。

| # | 优化 | 归属子任务 |
|---|---|---|
| P1 | 前端 27 处轮询改为 EventSink / daemon 推送驱动；窗口不可见时低功耗模式 | core-extraction（事件源）、shell-foundation（低功耗）、terminal-native、workspace-features、settings-panels |
| P2 | 统一 SQLite 连接池（1 写 + N 读，统一 PRAGMA，预编译缓存），替换约 135 处临时连接 | core-extraction |
| P3 | 终端管线：WS 帧到 term-engine 零拷贝、`ws_ack_bytes_v1`、解析与绘制解耦、共享字形缓存 | core-extraction（daemon 扩展）、terminal-native |
| P4 | Git 状态增量查询，轻量信息走 git2，减少子进程 | workspace-features |
| P5 | 历史/实时转录共享 watcher + 增量尾读 | poc-gates（核实现状）、workspace-features |
| P6 | 字体/索引/定价懒加载，首帧前只做最少工作 | shell-foundation |
| P7 | 全局分配器 `mimalloc`（现有 release profile 已是 fat LTO + cgu=1 + strip + abort，沿用） | poc-gates（测量）、shell-foundation |
| P8 | WebView2Loader 延迟加载 | rich-content-host |
| P9–P12（暂缓） | 游标分页 / EcoQoS / 回放追加写 / tracing 与基准 | — |
