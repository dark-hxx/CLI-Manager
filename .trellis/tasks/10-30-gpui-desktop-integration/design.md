# 设计：桌面集成（托盘 / 单实例 / 通知 / 桌宠 / Web 服务 / 更新 / 安装包）

> 上游：父 `design.md` §0.1、§4、§8；shell-foundation（主窗口、LowPowerController、run_io）；terminal-native（ExitCoordinator、后台会话恢复）；core-extraction（AppContext、CoreEvent、Web Operation dispatch、helpers crate）。
> 必读契约：`.trellis/spec/backend/tauri-updater-contracts.md`（更新 UX、R2 endpoint 派生、AUR/portable 规则）、`linux-graphics-contracts.md`、`web-service-contracts.md`、`desktop-pet-file-safety-contracts.md`、`crash-reporting-contracts.md`、`local-path-opening-contracts.md`、`app-startup-contracts.md`。GPUI 实现必须逐条满足其中与壳无关的条款；与 Tauri 机制绑定的条款（capability、`TAURI_CONFIG`）在 GPUI 版给出等价物并在新 spec 中改写。
> 原则：GPUI 版与 Tauri 版**可互相替换安装**：同一数据目录、同一 discovery 文件、同一 daemon/web-daemon、同一单实例协议；用户从 Tauri 升到 GPUI 或回退都不丢数据、不残留进程。

## 0. 现状事实（实施前逐条复核）

| 项 | 现状 | 位置 |
|---|---|---|
| 单实例 | `tauri-plugin-single-instance 2.4.2`（feature `semver`）；二次启动把 args 转给首实例：解析 `--restore-background-session <id>`、`--open-terminal[=]<path>`，入队后 emit `open-terminal-requested` 并显示主窗口 | `src-tauri/src/lib.rs:395`、`features/open_terminal.rs` |
| 资源管理器菜单 | HKCU `Software\Classes\Directory\shell\CLIManager` 与 `Directory\Background\shell\CLIManager`，命令 `"<exe>" --open-terminal "%1"/"%V"`；安装器与设置页都会写 | `installer/hooks.nsh`、`open_terminal.rs:100+` |
| 托盘 | `TrayIconBuilder::with_id("main-tray")`，菜单“显示 / 退出”；退出 emit `tray-quit-requested` 交给前端走退出守卫；左键单击显示主窗口 | `lib.rs:546-590` |
| 关闭行为 | `closeBehavior`（最小化到托盘 / 退出 / 询问）+ `exitWithRunningTasksBehavior` | `App.tsx` onCloseRequested |
| 桌宠 | 第二窗口 `desktop-pet`：190×210、透明、无边框、置顶、不进任务栏、不可聚焦、初始隐藏；资源 `$HOME/.codex/pets/**` | `tauri.conf.json`、`features/desktop-pet/commands.rs`、`scripts/desktopPet*.test.mjs` |
| 系统通知 | `features/notifications/{system.rs,service/}`；带动作按钮，点击 emit `system-notification-action` | |
| Web 服务 | `cli-manager-web-daemon` 独立进程（权限隔离），discovery `~/.cli-manager/web-daemon.json`；设备 Operation 由前端 `useWebDeviceBridge.ts` 执行 | `web_daemon.rs`、`commands/web_device.rs` |
| 更新器 | `tauri-plugin-updater`：minisign 公钥；endpoints = 镜像 `github.bwm.de5.net/.../latest.json` + GitHub `latest/download/latest.json`；Windows `installMode: passive`；前端 `updateStore.ts`：启动后静默检查 → 用户点击才下载 → 下载完成 `readyToInstall` → 确认框（有活动终端时显示数量并警告）→ `install()` → `relaunch()`；`distribution` 为 `aur`（`CLI_MANAGER_DISTRIBUTION=aur`）/`portable` 时不安装；**Windows 更新资产为默认的 MSI**（`bundle.targets: all` 同时产出 MSI 与 NSIS，契约要求不设 `updaterJsonPreferNsis`），NSIS 包供手动下载 | `tauri.conf.json`、`src/features/settings/api/updateStore.ts` |
| 安装包 | NSIS；`installerHooks: installer/hooks.nsh`（嵌入 `cleanup.ps1`；覆盖 Tauri 的按进程名 kill；PRE(UN)INSTALL 停进程、POST 注册/注销资源管理器菜单）；资源：conpty x64/x86/arm64、ssh-agent、`apps/web/dist`；helper exe 由 `beforeBundleCommand` 准备 | `tauri.conf.json`、`installer/*` |
| 停进程 | `cleanup.ps1`：按**完整路径**校验 → 先 CloseMainWindow 主程序（1.5 s 后强杀）→ 读 discovery 向 web-daemon 发 `shutdown`、向 PTY daemon 发 `close_all`+`routing_stop`+`shutdown` → 2 s 后对残留路径强杀；路径清单：`cli-manager.exe`、`cli-manager-web-daemon.exe`、`cli-manager-daemon.exe`、`cli-manager-codex-proxy.exe`、conpty OpenConsole | `installer/cleanup.ps1` |
| 便携版 | `scripts/package-portable.ps1`；更新器对 portable 禁用 | |
| 发布矩阵 | `release.yml`：windows-latest（NSIS）、macos-14 `aarch64-apple-darwin`（app/dmg + updater tar.gz）、ubuntu-22.04 与 ubuntu-22.04-arm（**仅 deb**，updater 键 `linux-<arch>-deb`；AppImage/rpm 已停发） | `.github/workflows/release.yml` |
| 发布期 endpoint 注入 | `.github/scripts/r2-release-config.mjs export-actions-env` 从 `R2_PUBLIC_BASE_URL` 派生 `TAURI_CONFIG`（覆盖 updater endpoints 为 `<R2>/CLI-Manager/releases/latest/latest.json` + GitHub 兜底）、`VITE_R2_PUBLIC_BASE_URL`、`CLI_MANAGER_R2_AGENT_MANIFEST_URL`；`prepare-r2-release.mjs` 把 latest.json 中的下载 URL 改写到 R2 后上传 | `.github/scripts/*` |
| 签名 | 更新产物与 ssh-agent manifest 都用 `TAURI_SIGNING_PRIVATE_KEY`（`npx tauri signer sign`，minisign 格式） | `release.yml` |

## 1. 进程与窗口模型

```
cli-manager-gpui.exe (双轨期) / cli-manager.exe (切换后)
 ├─ 主窗口（GPUI，无系统标题栏）
 ├─ 桌宠窗口（GPUI 第二窗口，透明/置顶/不聚焦）
 ├─ 托盘图标（tray-icon crate，消息循环挂在 GPUI 主线程）
 ├─ 单实例监听（隐藏消息窗口，主线程）
 └─ 后台：DaemonClient、WebDaemonManager、Updater 任务（tokio，run_io）
cli-manager-daemon.exe        （保留，PTY/Hook/路由/SSH Agent）
cli-manager-web-daemon.exe    （保留，权限隔离）
cli-manager-codex-proxy.exe   （保留）
```

- 所有系统集成对象（托盘、通知、单实例窗口）只在主线程创建与回调；回调内只做 `cx.spawn`/发送到 Entity，不阻塞。
- 托盘与单实例需要 Win32 消息：GPUI Windows 平台已有消息循环，`tray-icon`/自建隐藏窗口挂在同一线程；PoC 阶段（poc-window）已验证可行性，未通过则改为独立线程 + channel 回投主线程。

## 2. 单实例（与 Tauri 版互通）

### 2.1 协议兼容
- 必须与 `tauri-plugin-single-instance` Windows 实现**二进制兼容**：Tauri 版与 GPUI 版共享 identifier `com.cli-manager.app`，用户可能先装 Tauri 版残留进程、再启动 GPUI 版（反之亦然），二次启动的参数必须能投递给已运行的任意一方。
- 实施第 1 步：阅读 `tauri-plugin-single-instance` 2.4.x `platform_impl/windows.rs`，记录：互斥体名（`{identifier}-sim` 形式）、隐藏窗口类名/标题（`{identifier}-sic` 形式）、`WM_COPYDATA` 的 `dwData` 与 payload 编码（cwd 与 args 的分隔符、UTF-8/UTF-16）、semver feature 对名称的影响。写入 `research/single-instance-protocol.md` 并在 GPUI 实现中逐字复刻。
- 新 crate 模块 `apps/desktop-gpui/src/platform/single_instance.rs`：
  - `acquire() -> Primary | Secondary`：创建互斥体；`ERROR_ALREADY_EXISTS` → Secondary：查找窗口并 `SendMessageW(WM_COPYDATA)`，然后进程退出码 0。
  - Primary：注册隐藏窗口，收到 COPYDATA → 解码 args → 主线程 `SecondInstance { args, cwd }`。
- 回退：若 PoC 证明无法与 Tauri 版窗口互通（例如 semver 名称冲突），则在双轨期由安装器保证两版本不同时运行（cleanup 互杀），并在 release-cutover 中记录限制。

### 2.2 参数处理（与 Tauri 版一致）
| 参数 | 行为 |
|---|---|
| `--restore-background-session <id>` | 设置待恢复会话（terminal-native 的后台恢复入口），首实例激活对应终端 |
| `--open-terminal <path>` / `--open-terminal=<path>` | 解析与入队规则复用 core `open_terminal::parse_open_terminal_args` / `enqueue`（队列上限、丢弃计数日志不变）；UNC 路径、空值忽略的单元测试从现有测试迁移 |
| 其他/无参数 | 显示并聚焦主窗口（最小化则还原，托盘态则显示） |

- 启动时（Primary）对自身 `std::env::args()` 走同一流程；`OpenTerminalRequested` 在 UI 就绪后消费（队列在 core，事件只做通知）。

## 3. 托盘

- crate：`tray-icon`（tauri 生态同源，MIT/Apache），菜单用其 `muda`。
- 菜单项与 Tauri 一致：显示 / 退出（i18n 同 key）；左键单击 = 显示主窗口；双轨期 tooltip 带“(GPUI)”以便测试区分（切换后移除）。
- 退出：调用 terminal-native 的 `ExitCoordinator::request_exit(ExitSource::Tray)`，与关闭按钮共用退出守卫（运行中任务提示、后台保留、`exitWithRunningTasksBehavior`）。
- 关闭按钮：`closeBehavior` = tray → 隐藏窗口并进入 LowPowerController 的“隐藏”态（停止渲染、终端只累积不绘制）；exit → ExitCoordinator；ask → 原生对话框（ui_kit Dialog，带“记住选择”）。
- 托盘图标状态（可选增强，P1 相关）：有 attention/failed Tab 时切换角标图标；数据来自 Tab 状态合并结果，不新增轮询。

## 4. 系统通知

- 现状（`features/notifications/system.rs`）：交互式通知用 `notify_rust`（Windows 下 WinRT Toast，`app_id` = identifier，dev 模式用 `notify_rust::set_application` 兜底），动作回调 emit `system-notification-action`；WSL 下经宿主 PowerShell 发 Toast；另有自定义提示音（`PlaySoundW` 异步、校验路径）与任务栏闪烁 `set_taskbar_attention`（`FlashWindowEx`，需要 HWND）。`tauri-plugin-notification` 仅作为插件注册（`lib.rs:591`），实施时确认前端是否仍调用，若无则 GPUI 版不需要等价物。
- GPUI 版：上述函数迁入 core 时把 `AppHandle` 依赖替换为 `EventSink`（动作回调 → `CoreEvent::SystemNotificationAction`）与 `identifier` 常量；任务栏闪烁改为接收 raw HWND（GPUI 窗口句柄经 `raw-window-handle` 获取），由 GPUI 侧调用。AUMID 与 Tauri 版一致，保证 Toast 点击激活本应用。
- 动作按钮：激活参数编码 `action=<id>&session=<sid>`；点击 → 系统以参数启动应用 → 单实例转发 → `CoreEvent::SystemNotificationAction` → 激活对应终端/弹出权限请求。与 Tauri 版的 payload 结构保持一致（共享解析函数）。
- 窗口聚焦时的抑制规则、Hook 事件 → 通知映射（SessionStart/UserPromptSubmit 不弹）沿用 core/前端现有规则，移植到 GPUI 的 `NotificationModel`；场景：窗口聚焦/失焦/最小化/托盘、分屏中非激活 pane、hook 未安装。

## 5. 桌宠窗口

- GPUI 第二窗口：`WindowOptions { kind: PopUp/Floating, transparent: true, titlebar: None, focus: false, show: false, is_movable: true }`，置顶 + 不进任务栏（Win32 扩展样式 `WS_EX_TOOLWINDOW | WS_EX_TOPMOST | WS_EX_NOACTIVATE`，若 GPUI 未暴露则用 raw HWND 设置，PoC 已验证）。
- 渲染：精灵帧动画（资源 `$HOME/.codex/pets/**`，按现有 manifest 解析逻辑；解析/尺寸/边界计算从 `desktopPetSize`/`desktopPetRenderedBounds`/`desktopPetMenuGeometry` 移植并迁移其测试用例为 Rust 单测）。
- 交互：拖拽移动（位置持久化）、右键菜单（菜单几何算法移植）、状态联动（`desktopPetStatus`：根据 Tab 状态/Hook 事件切换动画），传输层 `desktopPetTransport` 在 GPUI 内改为直接订阅 Entity，不再走 `emitTo`。
- 低功耗：主窗口隐藏时桌宠仍按设置运行；动画帧率 ≤ 12 fps，静止状态不重绘；系统休眠/锁屏暂停。
- 透明窗口 GPU 合成：若 gpui-pre 在 Windows 上透明窗口有问题（PoC 结论），回退为带圆角不透明小窗并记录。

## 6. Web 服务（web-daemon）与设备 Operation

- `WebDaemonManager`（core，已有逻辑抽出）：启动/停止/状态、discovery 读写、协议版本检查；GPUI 只订阅 `WebServerStatusChanged`/`WebDeviceStatusChanged`。
- Operation 执行：web-daemon 把设备请求投递到主进程（现为 `web-device-operation-ready` 事件 → 前端 `useWebDeviceBridge` 执行）。GPUI 版：`CoreEvent::WebDeviceOperationReady` → `core::web::operations::dispatch(ctx, op)`（core-extraction 批 11 提供）→ 结果回传 web-daemon。需要 UI 参与的操作（例如在终端中输入、切换 Tab）通过 `UiCommand` 通道投递到对应 Entity。
- 设置 UI（二维码、设备列表）在 settings-panels；本任务提供 `WebServiceApi` trait 实现。
- 场景：主窗口隐藏/托盘态仍能执行 Operation；web-daemon 崩溃后状态正确变为离线并允许重启；端口占用提示。

## 7. 更新器

### 7.1 方案
- 不使用 tauri-plugin-updater；core 新增 `update` 模块：
  - 拉取 manifest：endpoints 顺序与 Tauri 一致（R2 镜像优先，GitHub 兜底），超时与重试同现有策略；endpoint 不写死：编译期读取 `option_env!("CLI_MANAGER_UPDATER_ENDPOINTS")`（由 `r2-release-config.mjs` 新增导出，JSON 数组），缺省时使用 `tauri.conf.json` 中的默认值（构建脚本生成常量，CI 测试两者一致）；`CLI_MANAGER_R2_AGENT_MANIFEST_URL` 现有的编译期用法保持不变；
  - manifest 格式：沿用 `latest.json`，**新增平台键** `<tauri 键>-gpui`（`windows-x86_64-gpui`、`darwin-aarch64-gpui`、`linux-x86_64-deb-gpui`、`linux-aarch64-deb-gpui`）。Tauri 客户端按自身键查找（`windows-x86_64`/`-nsis`、`darwin-aarch64`、`linux-<arch>-deb`），新键对其透明；GPUI 客户端只读 `-gpui` 键。`prepare-r2-release.mjs` 的 URL 改写需覆盖新键（加测试）。切换期 manifest 中原键也指向 GPUI 产物（见 release-cutover）。
  - 校验：`minisign-verify` crate，公钥与 `tauri.conf.json` 中 `plugins.updater.pubkey` 相同（构建期从 conf 读取或常量化，CI 对比测试）；签名文件格式与 Tauri bundler 产出的 `.sig` 相同（base64 包裹的 minisign 签名）。
  - 安装：下载到 `%TEMP%`，校验通过后以 passive 模式启动安装包并退出自身。**安装包类型决策**：GPUI 版的 `windows-x86_64-gpui` 键指向 NSIS 包（`/P`），以复用 hooks.nsh 的按路径停进程与菜单注册；MSI 不再作为 GPUI 更新资产（cargo-packager 的 WiX 产物可选手动分发）。实施第 1 步核对：Tauri 现行 MSI 更新路径如何停止 daemon（MSI 无 NSIS hooks，确认是否依赖 Restart Manager 或残留问题），结论写入 `research/installer-choice.md`；R2 切换时 Tauri 客户端读取的 `windows-x86_64` 键要改指 GPUI NSIS 包，需验证 tauri-plugin-updater 2.x 能按扩展名安装 NSIS（见 release-cutover）。
- `distribution` 判定（aur/portable 不自动安装）沿用现有判定逻辑，移入 core。

### 7.2 与会话的关系（与 Tauri 版规则一致）
- 现状：NSIS 安装器会对 PTY daemon 发 `close_all`，即**升级会结束所有终端会话（含后台会话）**；更新 UX 契约要求安装前确认，活动终端 > 0 时显示数量并警告。GPUI 版完全复刻 `tauri-updater-contracts.md` 的 UX 与错误矩阵（静默启动检查不打扰、手动检查可重试、Release 回退链接、无总长度时不显示 NaN、下载完成不自动安装），并补充：
  - 活动数取 daemon `list_sessions`（含后台会话），而非仅当前窗口的 Tab；
  - 可选“空闲时安装”：记录 pending，待 daemon 无会话（`session_status_push_v1` 推送）时提示安装；不做静默安装。
- 更新检查时机与 Tauri 版一致（首屏后延迟任务 + 设置页手动）；检查与下载在 run_io，不阻塞 UI。

## 8. 安装包（NSIS）

### 8.1 构建方式
- GPUI 版不再有 Tauri bundler。选用 **cargo-packager**（同为 CrabNebula/Tauri 团队维护，支持 NSIS、resources、external binaries、minisign 签名与 updater 产物）；若其 NSIS 模板与现有 `hooks.nsh` 的宏钩子（`NSIS_HOOK_PREINSTALL` 等）不兼容，则改为直接维护 `installer/gpui/installer.nsi`（以 Tauri 生成的 `installer.nsi` 为起点固化）。实施第 1 步对比两者，在 `research/installer-choice.md` 记录结论。
- 构建脚本 `scripts/package-gpui.mjs`：
  1. `cargo build --release -p cli-manager-desktop-gpui`；
  2. `node scripts/prepare-helper-binaries.mjs --profile release`（复用现有 helpers 构建与复制）；
  3. `npm run web:build`（apps/web/dist 仍需随包分发给 web-daemon）；
  4. 组装 staging 目录：主程序、3 个 helper、`resources/conpty/{x64,x86,arm64}`、`resources/ssh-agent/**`、`apps/web/dist/**`、`LICENSE`/第三方许可证清单（`cargo about` 生成）；
  5. 生成 NSIS 安装包与 `.sig`，并产出 `latest.json` 片段（`-gpui` 键）。
- 资源路径：`AppPaths::resource_dir()` 在 GPUI 版返回 `exe 所在目录`（Tauri 的 NSIS 布局下 resources 也在安装目录根），以保证 `conpty_sideload` 与 web-daemon 的 `apps/web/dist` 查找不变；对比测试覆盖。
- WebView2：不再是硬依赖（预览按需）。安装器**不**强制安装 WebView2；rich-content-host 在缺失时给出“安装 WebView2 Runtime”入口（下载 Evergreen bootstrapper 由用户触发）。

### 8.2 hooks 与清理
- 复用 `installer/hooks.nsh` 与 `cleanup.ps1`，修改点：
  - `cleanup.ps1` 路径清单新增 `cli-manager-gpui.exe`（双轨期主程序名），主程序候选为 `@(cli-manager.exe, cli-manager-gpui.exe)`；切换后保留两者以清理旧版本。
  - 资源管理器菜单命令指向实际主程序名（`$INSTDIR\${MAIN_BINARY}`），由宏参数化，避免硬编码 `CLI-Manager.exe`。
  - `CheckIfAppIsRunning` 覆盖逻辑若改为自维护 nsi 则不再需要，但保留“只按完整路径停进程”的原则。
- 卸载：保留用户数据与 discovery（与现状一致）；删除注册表菜单、开始菜单项、卸载项。

### 8.3 双轨期安装形态
| 方案 | 说明 | 结论 |
|---|---|---|
| A. 同目录同产品，主程序名不同 | 一个安装包同时带 `cli-manager.exe`(Tauri) 与 `cli-manager-gpui.exe` | 包体翻倍、更新复杂，否决 |
| B. 独立产品（推荐） | GPUI 预览版 productName `CLI-Manager (GPUI Preview)`、独立安装目录与卸载项、主程序 `cli-manager-gpui.exe`；共享数据目录、daemon discovery 与 identifier | 采用；两版不能同时运行（单实例互通保证二次启动转发到已运行实例） |
- 共享 daemon 风险：两套安装目录各有 `cli-manager-daemon.exe`，discovery 只有一个。规则：UI 连接 discovery 指向的 daemon 时校验协议版本与 capabilities，**不校验路径**；版本更旧时沿用现有 `reconcile`/替换规则（无会话时请求 shutdown 并拉起自身目录的 daemon，有会话时降级使用并提示）。cleanup.ps1 只停本安装目录的进程（现状已如此）。

## 9. 其他桌面能力清单

| 能力 | 现有 | GPUI 实现 |
|---|---|---|
| 剪贴板（文本/图片） | tauri-plugin-clipboard-manager | GPUI 剪贴板（文本）+ `arboard`/Win32（图片），经 `UiServices` |
| 文件对话框 | tauri-plugin-dialog | `rfd`（经 UiServices） |
| 打开外部链接/文件 | tauri-plugin-opener/shell | `open` crate / `ShellExecuteW`（经 UiServices） |
| 拖放文件到窗口 | `dragDropEnabled` | GPUI `ExternalPaths` 拖放事件；终端内落点插入路径（terminal-native） |
| 开机自启（若有） | 核对 settings | `auto-launch` crate，注册表项名与 Tauri 版一致 |
| 硬件加速开关 | `load_disable_hardware_acceleration_setting` → WebView 参数 | GPUI 版不适用；设置页隐藏该项，仅对预览 WebView 生效（rich-content-host） |
| 崩溃报告 | `crash_reporter::initialize(log_dir, "app")` | core 中复用，GPUI 启动最早调用；panic hook 见 shell-foundation |
| 日志 | tauri-plugin-log + fern 轮转 | core `logging::init`（fern + 同一轮转与级别规则，`CLI_MANAGER_DEBUG`），文件名 `cli-manager.log` 不变 |

## 10. 测试与验收
- 单实例：Tauri 运行时启动 GPUI（参数转发到 Tauri）/反之；资源管理器菜单两种入口；`--restore-background-session`。
- 托盘：关闭三种行为 × 是否有运行任务 × 是否有后台会话。
- 通知：窗口聚焦/失焦/托盘；动作按钮在应用未运行时点击（冷启动 + 转发）。
- 桌宠：显示/隐藏/拖拽/菜单/状态切换；多显示器与 DPI 缩放（100/150/200%）；主窗口隐藏时运行。
- Web 服务：启停、设备连接、Operation 执行、主窗口隐藏时执行、web-daemon 崩溃恢复。
- 更新：镜像失败回落 GitHub；签名错误拒绝安装；有会话时确认框；portable 不安装；安装后 daemon 被替换为新版本。
- 安装包：全新安装、覆盖安装、从 Tauri 版升级、卸载、回退到 Tauri 版；安装目录含空格/中文；非管理员。

## 11. 多平台（macOS aarch64 / Linux deb）

现有发布覆盖 Windows、macOS aarch64、Linux deb（x64/arm64），GPUI 版必须同等覆盖，Windows 为首要验收平台，其余平台在 R1 前达到功能等价。

| 能力 | macOS | Linux |
|---|---|---|
| 单实例 | 复刻 `tauri-plugin-single-instance` 的 macOS 实现（实施第 1 步调研，记录 socket/通知机制）；另需处理 Apple Event `open`（Finder/Dock 打开） | 复刻插件 Linux 实现（D-Bus 名称 `org.<identifier>.SingleInstance` 之类，以源码为准），`zbus` 实现 |
| 资源管理器菜单 | 不适用（可选：Finder Services，不在本期） | 不适用（可选 `.desktop` Action） |
| 托盘 | `tray-icon`（NSStatusItem）；关闭行为默认“隐藏到 Dock/菜单栏”，遵循 macOS 习惯（Cmd+Q 走 ExitCoordinator） | `tray-icon`（libappindicator/ayatana，deb 依赖声明）；无托盘环境（GNOME 无扩展）时 closeBehavior=tray 退化为最小化并提示 |
| 通知 | `notify_rust`（macOS 后端），动作按钮能力受限时降级为点击激活 | `notify_rust`（D-Bus），动作按钮依赖通知服务器支持 |
| 桌宠 | NSWindow 透明、`level = floating`、`collectionBehavior` 跨桌面；不进 Dock | X11 可用；Wayland 下置顶/定位受限 → 降级为普通小窗并提示 |
| 更新 | 下载 `.app.tar.gz` + `.sig`，minisign 校验，替换 `.app` 包（原子 rename 到同目录后重启）；保留现有 macOS 签名/公证状态（核对 release.yml 是否有 Apple 签名，现未见 `APPLE_*` 变量 → 维持未公证现状并在 README 说明） | deb：与 Tauri 一致，下载 `.deb` + `.sig` 后调用 `pkexec dpkg -i`（或提示用户手动安装，以 Tauri updater 的 deb 行为为准，实施时核对） |
| 打包 | cargo-packager `app`/`dmg`；helpers 放入 `Contents/MacOS/`，resources 放入 `Contents/Resources/`；`AppPaths::resource_dir()` 按平台返回 | cargo-packager `deb`；依赖声明（libxkbcommon、libwayland、libvulkan1/mesa、libayatana-appindicator3）；helpers 放 `/usr/lib/cli-manager/` 或与主程序同目录（保持 daemon 定位逻辑一致） |
| GPU 后端 | Metal | Vulkan（GPUI Linux 要求）；无 Vulkan 的环境（部分虚拟机/远程桌面）记录为不支持并在启动时给出明确错误 |
| 图形兼容 | — | `linux-graphics-contracts.md`：`WEBKIT_*` 两种模式只服务于 WebKitGTK，GPUI 版（预览走降级、无 WebKitGTK）不再需要，设置项隐藏但保留存储值；`auto` 的 `__NV_DISABLE_EXPLICIT_SYNC=1`（Wayland + NVIDIA 专有驱动）对 Vulkan 客户端是否仍需要，在 PoC 用 NVIDIA Wayland 实测后决定；诊断字段规则（不暴露完整环境与路径）沿用；“窗口在首个真实画面渲染前保持隐藏”在 GPUI 版由首帧回调后 `show` 实现 |
| 分发 | — | deb（自更新）+ AUR（`CLI_MANAGER_DISTRIBUTION=aur`，禁用自更新，包装脚本保留全部参数、LF 换行）；AUR PKGBUILD 改为构建 GPUI 版在 R2 同步 |
| 预览 WebView | WKWebView（rich-content-host） | 降级路径（无 WebKitGTK 依赖） |

- CI：GPUI 打包作业沿用同一矩阵；Linux 作业安装 GPUI 构建依赖（`libxkbcommon-dev`、`libwayland-dev`、`libvulkan-dev` 等，以 gpui-pre 文档为准），不再需要 `libwebkit2gtk-4.1-dev`（GPUI 版）。
- 安装器 hooks/cleanup 仅 Windows；macOS/Linux 的“升级前停 daemon”在更新器内完成：安装前向 daemon 发 `close_all`+`routing_stop`+`shutdown`（与 cleanup.ps1 同序列），经会话确认框后执行。
