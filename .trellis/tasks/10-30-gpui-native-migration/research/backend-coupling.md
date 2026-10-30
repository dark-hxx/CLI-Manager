# 后端 Tauri 耦合面分析（2026-10-30）

## 1. 规模

| 模块 | 行数 | 说明 |
|---|---|---|
| `src-tauri/src/lib.rs` | 1,745 | Builder、托盘、插件、440 命令注册（`lib.rs:608`） |
| `app/migrations.rs` | 1,199 | 约 41 个 `tauri_plugin_sql::Migration`，`lib.rs:604` 挂载 |
| `commands/` | 4,169 | `mod.rs` 以 `#[path]` 转导出 features；`web_device`/`web_conversation`/`web_server` |
| `infrastructure/` | 26,094 | daemon 13,624、pty 3,272、ssh 3,121、storage 2,107、diagnostics 1,542、process 1,293 … |
| `features/` | 134,340 | history 38k、providers 21k、extensions 14k、hooks 8.5k、git 7k、projects 6.5k、files 6.2k、remote 5.9k、terminal 5.5k … |
| 已无 Tauri 依赖的 crate | — | `history-core`、`hook-schema`、`agent-capabilities-core`、`ssh-agent`、`crates/web-protocol`、`apps/server`(axum) |

## 2. 耦合热点（排除 `#[tauri::command]` 属性）

- `AppHandle`：commands/ 47、terminal 18、history 14、hooks 7、desktop-pet/files/remote/daemon 各 6 …
- `tauri::State<>`：多数是 `State<DaemonBridge>` 注入 → 换成 `Arc<AppContext>`。
- `Emitter`/`.emit` 仅在 10 个文件：`infrastructure/daemon/client.rs`、`infrastructure/files/file_watcher.rs`、`features/git/watcher.rs`、`features/history/catalog.rs`、`features/notifications/system.rs`、`features/open_terminal.rs`、`features/remote/ssh/mod.rs`、`features/terminal/subagent_transcript.rs`、`commands/web_device.rs`、`lib.rs`。
- `tauri::Manager`（路径解析/state）：`infrastructure/storage/app_paths.rs`、`infrastructure/process/conpty_sideload.rs`（资源目录）、desktop-pet、notifications、remote/ssh、terminal/background、deepseek 等。
- `WebviewWindow`：仅 `features/desktop-pet/commands.rs`。
- Rust 侧插件：clipboard_manager（`files/commands/clipboard_image.rs`、`clipboard_import.rs`）、dialog（`hooks/settings/mod.rs`、`commands/web_conversation.rs`）、sql（`app/migrations.rs`、`stats/usage_schema.rs`）。
- `tauri::async_runtime::*`：机械替换为 tokio 句柄。

基本无耦合：`infrastructure/{pty,ssh,webdav,web,system,diagnostics}`、daemon server 侧（仅 `server.rs:857` Origin 白名单含 `tauri://localhost`）、`features/{codex-proxy,extensions,projects,statusline,sync}`。

**重要**：`cli-manager-daemon` / `cli-manager-web-daemon` 二进制依赖 `cli_manager_lib`，当前会链接 Tauri。

## 3. 后端 → 前端事件

静态：`pty-legacy-output`、`pty-legacy-status`、`claude-hook-notification`、`ssh-agent-hook-gap`、`routing-event`、`git-changed`、`project-files-changed`、`history-index-status`、`subagent-transcript-append`、`system-notification-action`、`open-terminal-requested`、`background-task-activate-requested`、`tray-quit-requested`、`web-device-status-changed`、`web-device-operation-ready`。
动态：`pty-status-{sessionId}`、`ssh-agent-install-progress-{hostId}`。

## 4. PTY 架构

- `cli-manager-daemon` 独立常驻进程，发现文件 `daemon.json`/`daemon.dev.json`。
- daemon 不只托管 PTY：同时绑定 Hook 上报端口（端口写入 PTY 子进程环境，需比 UI 活得久，`daemon/server.rs:939`）、本地 Provider 路由 HTTP 代理（`daemon/routing.rs`、`route_http/`）与 SSH Agent 桥（`ssh_agent_bridge/`）；Hook 通知经 NDJSON `HookReport` 帧转发给 UI（`daemon/client.rs:235`）。
- UI 启动后在后台线程 `connect_or_spawn` daemon（`lib.rs:480-505`），成功后 `reconcile_persisted_service` 恢复本地路由；进程内 PTY 路径已删除，daemon 不可用时终端创建明确失败。
- daemon 无会话且无客户端 10 分钟自灭；Windows 上自挂 `KILL_ON_JOB_CLOSE` Job Object 防孤儿。
- 通道：Tauri 进程 ↔ daemon 为 TCP NDJSON（`daemon/client.rs`、`daemon/protocol.rs`）；WebView ↔ daemon 为 WebSocket `/pty`（二进制帧 20 字节头，kind=output/replay/input/checkpoint/replay_reset；控制协议 v2；feature：`ws_binary_output_v1`、`ws_binary_input_v1`、`checkpoint_replay_v1`、`terminal_colors_v1`）。
- **终端仿真全部在 xterm.js**；Rust 无 VT 解析器。daemon 只保存原始 replay ring + spool，以及 `pty/osc_color.rs`、`mouse_snapshot.rs` 小型扫描器。
- **Checkpoint 是前端 xterm SerializeAddon 生成的 ANSI 快照**，由客户端上传。GPUI 客户端需能生成等价的 ANSI 序列化快照（见 design.md §5.4）。
- ACK `char_count` 为 UTF-16 code unit。

## 5. SQLite

- `~/.cli-manager/cli-manager.db` 与 `providers.db`（`infrastructure/storage/app_paths.rs`）。
- Rust 侧约 55 个文件已通过 sqlx 访问；前端约 117 处 `db.select/execute` 分布约 15 个文件。
- 迁移由 tauri-plugin-sql 执行（内部即 sqlx Migrator，写 `_sqlx_migrations`）。抽到 core 后改为 `sqlx::migrate::Migrator` 时，**version/description/checksum 必须与历史一致**，否则已有用户库会报 checksum mismatch。

## 6. 偏好文件（tauri-plugin-store JSON）

`settings.json`、`sessions.json`/`sessions.dev.json`、`sync-config.json`、`external-session-sync.json`、`extension-list-order.json`、`data-root.json`。plugin-store 格式即普通 JSON 对象，serde 可直接读写；需保证双壳写入格式一致且不互相截断（原子写 + 文件锁）。

## 7. 系统集成

- 托盘 `main-tray`（显示/退出；退出发 `tray-quit-requested` 交给 UI 做 PTY 退出守卫）。
- 单实例 `tauri-plugin-single-instance`：转发 `--open-terminal <path>` 等参数到 `open_terminal::enqueue`。
- 更新：`tauri-plugin-updater` + minisign 公钥 + GitHub `latest.json` + NSIS passive；`tauri-plugin-process` relaunch。
- 关闭行为：`App.tsx:1556-1628`（最小化到托盘 / 后台任务模式 / 退出清理）。
- 无全局快捷键、无 deep-link。
- Explorer 右键：NSIS `installer/hooks.nsh` 写 `HKCU\Software\Classes\Directory\shell\CLIManager` → `CLI-Manager.exe --open-terminal "%1"`。

## 8. Web 栈

- `apps/server`（axum）+ `apps/web`、`apps/web-tap`（React + xterm）继续存在，不在本次迁移范围内。
- `crates/web-protocol`（serde，`DEVICE_PROTOCOL_VERSION=4`）。
- Web 设备操作目前由 WebView 的 JS（`useWebDeviceBridge.ts`）通过 invoke 执行 → GPUI 版必须把 Operation 分发器下沉到 Rust core（这本身也是去 JS 化的收益）。

## 9. 抽核建议

1. `infrastructure/*`（除 `storage/app_paths`、`process/conpty_sideload`、`daemon/client` 的 Tauri 部分）与 `shared/` 原样迁入 `cli-manager-core`。
2. `AppHandle` → `EventSink` trait（约 15 个静态事件 + 2 个动态族）；路径 → `AppPaths` provider；`State<DaemonBridge>` → `AppContext`；`tauri::async_runtime` → tokio。
3. `#[tauri::command]` 变成 `src-tauri` 薄适配层。
4. 前端 SQL 与 store JSON 收拢为 Rust Repository。
5. daemon、web-daemon 二进制改依赖 core，不再链接 Tauri。
