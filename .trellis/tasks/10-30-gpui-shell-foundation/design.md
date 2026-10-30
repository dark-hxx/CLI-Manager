# 设计：GPUI 桌面壳骨架

> 上游：父 `design.md` §4、§7、§13（P1 低功耗、P6、P7）；core-extraction 提供的 `AppContext`、Repository、PrefsStore、EventSink。

## 1. crate 与二进制

```
apps/desktop-gpui/
  Cargo.toml          # package = "cli-manager-desktop-gpui"; [[bin]] name = "cli-manager-gpui"
  build.rs            # Windows 资源（图标、manifest：PerMonitorV2 DPI、长路径、common-controls v6）
  assets/             # icons/*.svg（lucide + lobehub 导出）、i18n/*.json（脚本生成）、fonts（如需内置）
  src/
    main.rs           # 全局分配器、日志、panic hook、单实例前置检查（desktop-integration 提供）、Application::run
    app/              # AppState、Services global、启动时序、关闭协调
    adapters/         # GpuiEventSink、NativePaths、GpuiUiServices
    models/           # 各 Entity（见 §4）
    ui_kit/           # gpui-component 薄封装 + 主题
    views/            # 根视图：TitleBar / Sidebar / Workspace / StatusBar / CommandPalette
    i18n/  keymap/  theme/  lowpower/
```
- 切换期二进制名为 `cli-manager-gpui`（避免与 Tauri 版 `cli-manager.exe` 冲突，便于双装）；release-cutover 默认切换时改名。
- 依赖：`gpui = { package = "gpui-pre", version = "=0.3.x" }`、`gpui-component`（patch/fork 按 M0 结论）、`cli-manager-core`、`core-db`、`core-prefs`、`tokio`、`async-channel`、`mimalloc`（P7，按 M0 结论）。

## 2. 进程与线程模型

| 线程 | 职责 | 规则 |
|---|---|---|
| GPUI 主线程 | 事件处理、Entity 状态变更、布局与绘制 | 禁止阻塞 IO、禁止同步等待 tokio；单次回调 > 4 ms 记 warn 日志（debug 构建） |
| GPUI background executor | 轻量计算（排序、过滤、Markdown 解析） | 结果通过 `cx.spawn` 回主线程 |
| tokio 多线程 runtime（`worker_threads = min(4, cores)`） | 所有 IO：SQLite、文件、网络、daemon 连接、watcher | 由 `AppContext.rt` 暴露；GPUI 侧通过 `rt.spawn` + `oneshot`/`async_channel` 交互 |

- 封装 `Services::run_io(cx, fut, |this, result, cx| ...)`：在 tokio 上执行 future，完成后在主线程更新指定 Entity；统一错误 toast 与日志。
- `GpuiEventSink`：`emit` 只做 `async_channel::Sender::try_send`（有界 4096，满时合并同类事件并记 warn）；主线程一个常驻 task 读取并分发到对应 Entity（按事件类型路由表）。

## 3. 启动时序（P6）

```
main()
 ├─ 设置 mimalloc、日志（CLI_MANAGER_DEBUG 语义不变，文件名 cli-manager.log，位于同一 LogDir）、panic hook（写 crash 日志）
 ├─ 单实例检查（desktop-integration 提供；已有实例 → 转发参数后退出）
 ├─ 构建 tokio runtime
 └─ Application::run
     ├─ [同步，首帧前] PrefsStore.load(settings) → 主题/语言/字体设置
     ├─ [同步，首帧前] db_repair_known_migration_drift + 迁移 + DbPools.main 打开
     ├─ [同步，首帧前] ProjectRepo 加载项目树
     ├─ 打开主窗口，渲染首帧（侧栏 + 空工作区）
     └─ [首帧后，后台并行]
          ├─ daemon connect_or_spawn → reconcile_persisted_service → 订阅 session_status
          ├─ session/sync 元数据加载；model pricing 预热；ccusage 缓存
          ├─ 历史索引启动；文件/Git watcher 按当前项目启动
          ├─ WebDAV 自动同步（按设置）；更新检查（按设置，desktop-integration）
          └─ web-daemon 启动（按 Web 服务设置，desktop-integration）
```
- 首帧前三步有超时预算：合计 > 300 ms 记 warn，并在 debug 构建输出各步耗时。
- “启动时不恢复终端”：遵循 `workspace-session-restore-contracts.md` 与 session-restore-mode；需要恢复时由 terminal-native 在 daemon 连接成功后执行。
- daemon 连接失败：状态栏显示“终端服务不可用”与重试按钮；不阻塞其他功能。

## 4. 状态模型

| Entity | 对应 Zustand store | 数据来源 | 主要事件 |
|---|---|---|---|
| `SettingsModel` | `shared/preferences/settingsStore.ts` | PrefsStore | 设置变更 → 写回 + 广播 |
| `ProjectModel` | `projectStore`、`worktreeStore` | ProjectRepo/WorktreeRepo | ProjectFilesChanged |
| `TerminalModel` / `PaneTree` | `terminalStore` + `terminalPaneTree` | terminal-native 提供 | DaemonSessionStatus、HookNotification |
| `GitModel` | `gitStore` | core::git | GitChanged |
| `HistoryModel` | `historyStore` | core::history + Repo | HistoryIndexStatus |
| `StatsModel` | `ccusageStore`、stats | core::stats | UsageUpdated、RequestLogAppended |
| `SyncModel` | `syncStore` | core::sync | — |
| `TemplateModel`、`CommandHistoryModel`、`SshHostModel`、`ModelPricingModel`、`UpdateModel` | 同名 store | Repo | — |
| `UiModel` | 侧栏宽度、折叠、专注模式、当前面板 | PrefsStore | — |

- 本子任务实现 Settings/Project/Ui 三个模型与 Services global；其他模型的骨架（空实现 + 事件路由占位）在本子任务建好，具体逻辑由对应子任务填充。
- 跨模型调用：通过 `cx.global::<Services>()` 取 `WeakEntity`，禁止循环强引用。

## 5. ui_kit 与主题

- `ui_kit` 只暴露项目需要的组件：Button、IconButton、Input、TextArea、Select、Checkbox、Switch、Slider、Tabs、Tooltip、Popover、Menu/ContextMenu、Dialog、Drawer、Toast、Table、VirtualList、Tree、Resizable、ScrollArea、Badge、Kbd、Spinner、ColorPicker、SegmentedControl。
- 每个组件是对 gpui-component 的薄包装，统一尺寸、间距、焦点环、禁用态；业务代码禁止直接 `use gpui_component::*`（可用 `clippy::disallowed_types`/`disallowed_methods` 配置或 CI grep 检查）。
- 主题：读取现有主题 token（`src/` 中 CSS 变量与 `ThemeSettingsPage` 的预设），生成 `theme/tokens.rs`（脚本 `scripts/export-theme-tokens.mjs`），映射到 gpui-component Theme；明暗主题、跟随系统、强调色。
- 字体：UI 字体与终端字体分离；字体列表懒加载（P6），由全局 `FontCatalog`（`OnceCell`）提供，优先复用 GPUI `TextSystem::all_font_names()`，与 `statusline`/`system::fonts` 共用。

## 6. i18n

- 脚本 `scripts/export-i18n.mjs`：读取 `src/shared/i18n` 中英字典，输出 `apps/desktop-gpui/assets/i18n/{zh-CN,en-US}.json`（扁平 key）。构建前执行，产物入库（避免构建依赖 Node）并在 CI 检查与源字典同步。
- 繁体：运行时用 Rust 简繁转换（`zhconv` 或 opencc 绑定，M0/本任务内选型：优先纯 Rust、词典体积小）由 zh-CN 生成，与前端 opencc-js 结果做抽样对照测试。
- `t!("key", args)` 宏；只加载当前语言（P6），切换语言时重新加载并 `cx.refresh()`。

## 7. Keymap 与命令面板

- 从 `features/workspace/useKeyboardShortcuts` 与 `ShortcutSettingsPage` 导出动作清单，定义为 GPUI `actions!`；快捷键配置读写同一偏好字段，格式转换双向（Tauri 格式 ↔ GPUI keystroke），未知动作保留。
- 命令面板：模糊搜索动作 + 项目 + 最近会话；动作提供方按模块注册（各子任务追加）。
- 键位冲突处理：终端获得焦点时，除全局保留键外按键优先交给终端（规则由 terminal-native 定义，ui 层提供“全局保留键表”）。

## 8. 窗口与标题栏

- 主窗口：`WindowOptions { titlebar: None, window_decorations: Client, min_size: 800x500 }`，记忆位置/大小/最大化（偏好字段与 Tauri 版 window-state 一致性在实施时核对，不一致则用新字段）。
- 自绘标题栏：拖动区域、双击最大化、最小化/最大化/关闭按钮；Windows Snap Layouts 依赖 M0 结论（WM_NCHITTEST 返回 HTMAXBUTTON）。
- 关闭按钮：交给 `CloseCoordinator`（本任务实现 UI 部分：读取 `closeBehavior`，最小化到托盘/询问对话框），真正的退出流程调用 terminal-native 的 `ExitCoordinator`。

## 9. 低功耗模式（P1）

- `LowPowerController` 监听窗口激活/最小化/隐藏（托盘），广播 `PowerState::{Active, Background, Hidden}`。
- 订阅方：光标闪烁与动画（停止）、statusline 刷新与系统资源采样（暂停）、终端绘制（Hidden 时只解析不绘制；Background 时降帧到 ≤ 10 fps）、各面板兜底定时器（暂停）。
- 恢复为 Active 时广播一次“立即刷新”。

## 10. 日志、崩溃与诊断

- 日志沿用 core 的 `log` 配置；GPUI 相关日志 target 前缀 `gpui_shell`。
- panic hook：写 `crash-<ts>.log`（版本、线程、backtrace、最近 200 行日志）；`panic = "abort"` 下进程立即退出，daemon 中的会话不受影响，下次启动在状态栏提示“上次异常退出，后台会话可恢复”。

## 11. 不在本任务范围

终端视图（terminal-native）、预览/编辑器（rich-content-host）、各功能面板内容（workspace-features、settings-panels）、托盘/单实例/更新实现（desktop-integration）。本任务为它们提供挂载点与占位视图。
