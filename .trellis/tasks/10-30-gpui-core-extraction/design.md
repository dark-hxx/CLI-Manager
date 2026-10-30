# 设计：M1 根 workspace + 核心 crate 抽取

> 上游：父 `design.md` §0.1、§2、§3、§5.1、§13；`research/backend-coupling.md`。
> 原则：**Tauri 版零行为变化**。每一批迁移都必须能单独编译、单独测试、单独回滚。

## 1. 根 Cargo workspace

### 1.1 现状
- 无根 `Cargo.toml`；`src-tauri/Cargo.toml` 是独立包（含 4 个 bin），通过 path 依赖 `hook-schema`、`history-core`、`agent-capabilities-core`、`../crates/web-protocol`、`../apps/server`。
- 锁文件：`src-tauri/Cargo.lock`、`src-tauri/helpers/Cargo.lock`、`apps/server/Cargo.lock`；仓库根另有一个已过时的 `Cargo.lock`（最后修改于 `91b1737d`）。
- **helper 二进制的实际打包来源**：`src-tauri/helpers`（包 `cli-manager-helpers`，bin 名 `cli-manager-daemon` / `cli-manager-web-daemon` / `cli-manager-codex-proxy`，`build.rs` 用 `embed_resource` 写入 Windows 版本资源以便在任务管理器中区分进程）。`tauri.conf.json` 的 `beforeBundleCommand` → `scripts/prepare-bundle-binaries.mjs` → `scripts/prepare-helper-binaries.mjs`：以 `--manifest-path src-tauri/helpers/Cargo.toml --target-dir <target>/helper-binaries` 构建，再复制到 `<target>/<profile>/`。helpers 目前依赖 `cli-manager`（链接 Tauri 的 lib）。`src-tauri/Cargo.toml` 中同名的 `[[bin]]` 用于开发期 `cargo run --bin`。
- `src-tauri/ssh-agent` 独立构建（CI 用 `cargo zigbuild --manifest-path src-tauri/ssh-agent/Cargo.toml` 交叉编译 Linux），有自己的发布节奏。
- 产物路径被引用：`scripts/package-portable.ps1`（`src-tauri/target/release`）、`scripts/tauri-build-local.mjs`（`CARGO_TARGET_DIR=src-tauri/target/local`）、`scripts/webConversationRuntime.smoke.mjs`（`src-tauri/target/debug/cli-manager-codex-proxy.exe`）。

### 1.2 方案
```toml
# /Cargo.toml
[workspace]
resolver = "2"
members = [
  "src-tauri", "src-tauri/helpers",
  "src-tauri/hook-schema", "src-tauri/history-core", "src-tauri/agent-capabilities-core",
  "crates/web-protocol", "crates/core", "crates/core-db", "crates/core-prefs",
  "apps/server",
  # 后续子任务追加：crates/pty-client, crates/term-engine, crates/preview, apps/desktop-gpui
]
exclude = ["src-tauri/ssh-agent", "spikes/*"]

[workspace.package]
edition = "2021"
license = "AGPL-3.0-or-later"

[workspace.dependencies]   # tokio / serde / sqlx / log / anyhow / thiserror / uuid / chrono ... 版本从 src-tauri/Cargo.toml 搬来

[profile.release]          # 从 src-tauri/Cargo.toml 原样搬来：lto = "fat", codegen-units = 1, strip = "symbols", panic = "abort"
[profile.dev]              # 同上（如有）
```
```toml
# /.cargo/config.toml
[build]
target-dir = "src-tauri/target"     # 保持所有脚本与 CI 的产物路径不变
```
- `[profile.*]` 只能在 workspace 根生效：搬移后删除 `src-tauri/Cargo.toml` 中的 profile 段（cargo 会对成员中的 profile 发出警告并忽略）。
- 锁文件：以 `src-tauri/Cargo.lock` 为基础生成根 `Cargo.lock`（先复制再 `cargo metadata`，避免无谓升级），对比依赖版本差异，确认没有非预期升级后删除 `src-tauri/Cargo.lock`、`src-tauri/helpers/Cargo.lock`、`apps/server/Cargo.lock`。`src-tauri/ssh-agent/Cargo.lock` 保留。
- helpers 成为 workspace 成员后，`prepare-helper-binaries.mjs` 的 `--manifest-path` 构建仍然有效（cargo 会识别所属 workspace 并使用根锁）；独立的 `--target-dir helper-binaries` 保留，避免与 Tauri 主构建的 feature 统一互相污染。需更新 `scripts/prepare-helper-binaries.mjs` 的测试（如有）并在 Windows 上实测 `npm run tauri build`。
- Tauri CLI：`tauri build/dev` 在 `src-tauri` 运行 cargo，会自动识别上层 workspace，产物目录通过 `cargo metadata` 获取（受 `.cargo/config.toml` 影响），无需修改 `tauri.conf.json`。
- `cd src-tauri && cargo test` 仍可用（只构建该成员）。
- CI：`release.yml` 中 ssh-agent 用 `--manifest-path`，不受影响；Windows 打包步骤若使用 `tauri build`，产物路径不变。逐个核对后在 implement 中记录。

## 2. crate 划分

| crate | 内容来源 | 依赖 |
|---|---|---|
| `crates/core-prefs` | `shared/preferences` 的 Rust 等价物（新写）、`infrastructure/storage` 中的 data-root 解析 | serde、serde_json、fs4 |
| `crates/core-db` | `app/migrations.rs`（中立化）、`stats/usage_schema.rs`、各 features 的建连代码、`commands/db_repair.rs` 的漂移修复、前端 SQL 对应的 Repository | sqlx（sqlite, runtime-tokio）、core-prefs |
| `crates/core` | `infrastructure/*`、`shared/*`、`features/*` 的业务逻辑、`web_daemon.rs`、`web_device_outbox.rs`、`device_identity.rs` | core-db、core-prefs、history-core、hook-schema、agent-capabilities-core、web-protocol |
| `src-tauri`（lib + 4 bin） | 命令适配层、`lib.rs` Builder/插件/托盘、`TauriEventSink`/`TauriPaths`/`TauriUiServices` | core、tauri* |

daemon / web-daemon / codex-proxy：
- 打包路径：`src-tauri/helpers` 的依赖从 `cli-manager` 改为 `cli-manager-core`（三个 main 只调用 core 的 `run_daemon` 等入口），bin 名与版本资源不变 → 打包产物不再链接 Tauri。GPUI 安装包复用同一 helpers 构建产物。
- 开发路径：`src-tauri/Cargo.toml` 中同名 `[[bin]]` 删除（避免同一 workspace 内两个包产出同名二进制导致 cargo 警告与产物覆盖），开发期 `scripts/dev-server.mjs`/`tauri dev` 改为调用 `prepare-helper-binaries.mjs` 的 debug 构建；实施前先核对 `scripts/dev-server.mjs` 与 `features/terminal/commands.rs` 中定位 daemon 可执行文件的逻辑（`daemon_executable_path`）。
- 验证：`cargo tree -p cli-manager-helpers -e normal -i tauri` 为空。

## 3. 去 Tauri 化接口

### 3.1 EventSink 与事件映射

```rust
pub trait EventSink: Send + Sync + 'static { fn emit(&self, event: CoreEvent); }

#[non_exhaustive]
pub enum CoreEvent {
    PtyLegacyOutput(Value), PtyLegacyStatus(Value), PtyStatus { session_id: String, payload: Value },
    HookNotification(Value), SshAgentHookGap { host_id: String, dropped: u64 },
    RoutingEvent(Value), GitChanged(GitChangedPayload), ProjectFilesChanged(FilesChangedPayload),
    HistoryIndexStatus(Value), SubagentTranscriptAppend(Value), SystemNotificationAction(Value),
    OpenTerminalRequested(Value), BackgroundTaskActivateRequested(Value), TrayQuitRequested,
    WebDeviceStatusChanged(Value), WebDeviceOperationReady(Value), WebServerStatusChanged(Value),
    SshAgentInstallProgress { host_id: String, payload: Value },
    DesktopPet { name: &'static str, payload: Value },
    // P1 新增（Tauri 侧不映射）：
    DaemonSessionStatus(SessionStatusPush), RequestLogAppended(Value), UsageUpdated { session_id: String },
    SubagentDirChanged { session_id: String },
}
```
- 第一阶段 payload 保持 `serde_json::Value`（与现有 emit 的 JSON 完全一致），降低迁移风险；GPUI 侧需要强类型时在 core 中补 typed struct 并提供 `From`。
- `TauriEventSink` 映射表（快照测试锁定）：

| CoreEvent | Tauri 事件名 |
|---|---|
| PtyLegacyOutput / PtyLegacyStatus | `pty-legacy-output` / `pty-legacy-status` |
| PtyStatus | `pty-status-{session_id}` |
| HookNotification | `claude-hook-notification` |
| SshAgentHookGap | `ssh-agent-hook-gap` |
| RoutingEvent | `routing-event` |
| GitChanged / ProjectFilesChanged | `git-changed` / `project-files-changed` |
| HistoryIndexStatus | `history-index-status` |
| SubagentTranscriptAppend | `subagent-transcript-append` |
| SystemNotificationAction | `system-notification-action` |
| OpenTerminalRequested | `open-terminal-requested` |
| BackgroundTaskActivateRequested | `background-task-activate-requested` |
| TrayQuitRequested | `tray-quit-requested` |
| WebDevice* / WebServerStatusChanged | `web-device-status-changed` / `web-device-operation-ready` / `web-server-status-changed` |
| SshAgentInstallProgress | `ssh-agent-install-progress-{host_id}` |
| DesktopPet | `desktop-pet-*`（逐个列出，含 `emitTo` 目标窗口） |
| 新增四项 | 不映射（Tauri 版维持现有轮询） |

- 事件枚举前，用 `grep -rn "\.emit(\|emit_to(\|emit_all("` 全量核对，表格不全处在实施时补齐。

### 3.2 路径、UI 能力、运行时

```rust
pub trait AppPaths: Send + Sync {
    fn data_dir(&self) -> PathBuf;          // ~/.cli-manager 或 data-root.json 指定
    fn app_local_data_dir(&self) -> PathBuf; fn app_config_dir(&self) -> PathBuf;
    fn log_dir(&self) -> PathBuf; fn resource_dir(&self) -> PathBuf; fn cache_dir(&self) -> PathBuf;
}
pub trait UiServices: Send + Sync {
    fn pick_file(&self, o: PickOptions) -> BoxFuture<'_, Option<PathBuf>>;
    fn pick_folder(&self, o: PickOptions) -> BoxFuture<'_, Option<PathBuf>>;
    fn save_file(&self, o: SaveOptions) -> BoxFuture<'_, Option<PathBuf>>;
    fn read_clipboard_image(&self) -> Result<Option<RgbaImage>, CoreError>;
    fn write_clipboard_text(&self, text: &str) -> Result<(), CoreError>;
    fn open_external(&self, target: &str) -> Result<(), CoreError>;
}
pub struct AppContext {
    pub paths: Arc<dyn AppPaths>, pub events: Arc<dyn EventSink>, pub ui: Arc<dyn UiServices>,
    pub daemon: Arc<DaemonBridge>, pub db: DbPools, pub prefs: PrefsStore, pub rt: tokio::runtime::Handle,
}
```
- 路径实现必须与 Tauri 的 `app.path()` 解析结果逐项一致（`TauriPaths` 直接委托 Tauri；`NativePaths` 用 `dirs` + identifier `com.cli-manager.app` 计算，并有对比测试：同一机器两种实现输出相同）。
- `conpty_sideload` 只需要 `resource_dir`，改为接收 `&dyn AppPaths`。
- `tauri::async_runtime::spawn` → `ctx.rt.spawn`；`spawn_blocking` 同理。Tauri 版在 setup 中把 Tauri 自己的 tokio runtime 句柄注入（保持单 runtime）。

### 3.3 命令层
- core 函数签名：`pub async fn xxx(ctx: &AppContext, req: Req) -> Result<Resp, CoreError>`；同步函数保持同步。
- `CoreError`：`#[derive(Debug, thiserror::Error)]`，`impl Serialize` 输出与现有 `String` 错误完全相同的文本（大部分命令现在 `map_err(|e| e.to_string())`）；结构化错误（如 routing 的 `RoutingError`）保持原结构。
- Tauri 适配：`#[tauri::command] pub async fn git_status(state: State<'_, Arc<AppContext>>, req: Req) -> Result<Resp, CoreError> { core::git::status(&state, req).await }`。命令名、参数名（含 camelCase 转换）不变。
- 用 GitNexus `impact` 逐命令确认前端调用点不受影响；用 `tool_map`/grep 生成“命令清单 → core 函数”对照表放在 spec 中。

## 4. core-db

### 4.1 迁移中立化
```rust
pub struct MigrationDef { pub version: i64, pub description: &'static str, pub sql: &'static str, pub kind: MigrationKind }
pub static MIGRATIONS_MAIN: &[MigrationDef] = &[ ... ];   // 逐条从 app/migrations.rs 搬运，sql 字符串逐字节不变
```
- Tauri：`MIGRATIONS_MAIN.iter().map(|m| tauri_plugin_sql::Migration { version: m.version, description: m.description, sql: m.sql, kind: ... })`。
- GPUI：构造 `sqlx::migrate::Migrator`（`Migration::new(version, description.into(), MigrationType::Simple, sql.into(), false)`）。
- **一致性测试**：临时目录分别用两条路径迁移空库 → 读取 `_sqlx_migrations(version, description, checksum)` → 断言完全相同；再用一份“旧版本真实库”fixture（由 Tauri 版 v33/v41 生成）用 GPUI 路径打开，断言无 checksum mismatch。
- `stats/usage_schema.rs` 同样处理。
- `db_repair_known_migration_drift` 迁入 core-db，两壳在迁移前都调用。

### 4.2 连接池（P2）
```rust
pub struct DbPool { writer: SqlitePool /* max=1 */, reader: SqlitePool /* max=N=min(4, cores) */ }
impl DbPool { pub async fn open(path, opts) -> Result<Self>; pub fn read(&self) -> &SqlitePool; pub fn write(&self) -> &SqlitePool; }
pub struct DbPools { pub main: DbPool, pub providers: DbPool, pub history_catalog: Option<DbPool> }
```
- `after_connect`：`PRAGMA journal_mode=WAL; synchronous=NORMAL; temp_store=MEMORY; cache_size=-16000; mmap_size=268435456; busy_timeout=5000; foreign_keys=ON`（`foreign_keys` 以现状为准，先核实现有连接是否开启，不改变语义）。
- 读写分离的一致性：写入后立即读取的路径（如“插入后返回列表”）统一走 writer 连接执行读取，或在同一事务内完成；实施时逐处标注。
- 替换约 135 处临时连接：按 feature 分批，每批跑该 feature 的测试；例外清单（外部 `cc-switch.db` 只读打开、修复工具、迁移前的探测）写入 spec。
- Tauri 前端仍通过 tauri-plugin-sql 访问同一库（另一组连接），WAL + busy_timeout 保证共存；P2 的“消除前后端争锁”收益只在 GPUI 版完全体现。

### 4.3 Repository
- 覆盖前端直连的 20 张表：`projects`、`groups`、`worktrees`、`command_history`、`command_templates`、`ssh_hosts`、`ssh_host_groups`、`ssh_host_tool_preferences`、`ssh_agent_installations`、`ssh_agent_tool_integrations`、`session_meta`、`session_favorite_snapshots`、`message_stars`、`history_generated_titles`、`history_edit_audit`、`ai_replay_sessions`、`ai_replay_events`、`model_prices`、`ccusage_cache`、`sync_meta`。
- 方法从前端 SQL 逐条翻译（保留排序、默认值、`ON CONFLICT` 语义），每个方法附测试；对照表“TS 文件:行 → Repo 方法”写入 spec，供 GPUI 子任务直接查用。
- 本子任务只提供 Repository，不改 React 前端（Tauri 版继续直连 SQL）。

## 5. core-prefs
```rust
pub struct PrefsStore { root: PathBuf, locks: DashMap<PathBuf, Arc<Mutex<()>>> }
impl PrefsStore {
    pub fn load<T: DeserializeOwned + Default>(&self, file: PrefsFile) -> Result<T>;
    pub fn update<T, F: FnOnce(&mut T)>(&self, file: PrefsFile, f: F) -> Result<()>;  // 读-改-写 在文件锁内
}
#[derive(Serialize, Deserialize, Default)] #[serde(default, rename_all = "camelCase")]
pub struct Settings { /* 已知字段 */ #[serde(flatten)] pub extra: serde_json::Map<String, Value> }
```
- 文件位置与 tauri-plugin-store 一致（核实 store 的保存目录：`app_data_dir` 或 `app_config_dir`）。
- 原子写：同目录临时文件 → `fsync` → `rename`（Windows 用 `ReplaceFileW` 语义的 `std::fs::rename`）；进程间锁：`fs4` 对 `<file>.lock` 加独占锁。
- 注意：tauri-plugin-store 自身不加锁，Tauri 版与 GPUI 版不会同时运行（单实例），因此锁主要防 GPUI 进程内并发与 daemon 读取。
- 默认值与迁移：以 `src/shared/preferences/settingsStore.ts` 的默认值为准生成对照测试（TS 侧导出默认值 JSON fixture）。

## 6. daemon 协议扩展（向后兼容）

| 能力 | daemon 声明 | 客户端声明 | 行为 |
|---|---|---|---|
| `ws_ack_bytes_v1` | `AuthOk.features` | WS `auth` 帧新增 `client_features: Vec<String>`（`#[serde(default)]`） | 双方都有 → 该连接 ACK 的 `char_count` 解释为字节数，高/低水位按字节；否则保持 UTF-16 |
| `ws_native_client_v1` | `AuthOk.features` | — | WS 握手允许“无 Origin 头”的连接（仍只绑定 127.0.0.1，首帧 token 必须正确）；带 Origin 的连接仍按白名单校验（`server.rs:857`） |
| `checkpoint_ansi_v1` | `AuthOk.features` | `client_features` | 标记该客户端上传的 checkpoint 为“标准 ANSI 重放流”；daemon 存储时记录 `checkpoint_format`，attach 时在 replay 头中告知，便于客户端决定是否信任 |
| `session_status_push_v1` | NDJSON 控制面与 WS 的 `AuthOk.features` | `client_features` | daemon 在会话 create/exit/close/状态变化时推送 `session_status { session_id, status, exit_code?, title?, cwd? }`；未声明的客户端不收到 |

- 实现位置：`infrastructure/daemon/protocol.rs`（帧与 feature 常量）、`server.rs`（握手/ACK/推送）、`client.rs`（NDJSON 客户端声明 `session_status_push_v1` 并转为 `CoreEvent::DaemonSessionStatus`）。
- 测试：新旧客户端并存（一个 UTF-16、一个字节 ACK 订阅同一会话）背压互不影响；无 Origin 连接 + 错误 token 被拒；未声明客户端收不到 push；旧 daemon（不声明）+ 新客户端降级为旧行为。
- 同步更新 `pty-daemon-contracts.md`（新增 Scenario 小节，不改既有条款）。

## 7. Web 设备与 web-daemon
- `web_daemon.rs` 进程模型不变；其中的设备连接逻辑原样迁入 `core::web::device`，web-daemon bin 只调用它。
- 主进程侧：把 `commands/web_device.rs` 与 `useWebDeviceBridge.ts` 中“收到 Operation → 调用哪个命令”的分发表下沉为 `core::web::operations::dispatch(ctx, op) -> Result<OpResult>`。Tauri 版继续由 JS 执行（不改行为），GPUI 版直接调用 `dispatch`。分发表与 JS 版本逐项对照测试。

## 8. 迁移批次（每批独立提交）

| 批 | 内容 | 风险 |
|---|---|---|
| 0 | 根 workspace、`.cargo/config.toml`、锁文件合并；无代码移动 | 构建/CI 路径 |
| 1 | `crates/core` 空壳 + `shared/*` + 无耦合 infrastructure（pty/ssh/webdav/web/system/diagnostics/process 非 sideload 部分） | 低 |
| 2 | daemon server 与协议（含 Origin 判定抽成参数）、daemon/web-daemon/codex-proxy bin 改依赖 core | 中 |
| 3 | `EventSink`/`AppPaths`/`UiServices`/`AppContext` + Tauri 实现；`DaemonClient` 改用 EventSink；`app_paths`、`conpty_sideload` | 中 |
| 4 | 纯逻辑 features：codex-proxy、extensions、projects、statusline、sync、agents、deepseek、app-data | 低 |
| 5 | 轻耦合 features：git（watcher）、files（watcher、clipboard → UiServices）、notifications、open_terminal、remote、desktop-pet（WebviewWindow 留在适配层） | 中 |
| 6 | 重耦合 features：history（catalog emit）、hooks（settings dialog → UiServices）、terminal（background、subagent_transcript）、providers、stats | 中高 |
| 7 | core-db：迁移中立化 + 一致性测试；连接池；替换临时连接（按 feature 分子批） | 高（数据） |
| 8 | core-db Repository（20 张表）+ 对照表 | 低（未接入生产） |
| 9 | core-prefs | 低（未接入 Tauri 生产路径） |
| 10 | daemon 协议扩展（§6）+ P1 新事件 | 中 |
| 11 | Web 设备 Operation 分发下沉 | 中 |

## 9. 测试策略
- 每批：`cargo check --workspace`、`cargo test --workspace`、`cd src-tauri && cargo test`、`npx tsc --noEmit`（确认未误改前端）。
- 快照测试：EventSink 映射、命令清单（命令名 + 参数名）在抽取前后一致（抽取前先生成基准快照）。
- 关键手动冒烟（批 2、3、6、7、10 后）：见 prd 冒烟清单。
- GitNexus：每批前 `impact`（被移动的公共函数）、提交前 `detect_changes`。

## 10. 风险
| 风险 | 应对 |
|---|---|
| 移动文件导致 GitNexus/历史追溯断裂 | 使用 `git mv`，一批只做“移动 + 最小改名”，逻辑改动另起提交 |
| 迁移 checksum 不一致导致用户库报错 | §4.1 双重测试；发布前用真实旧库验证 |
| 读写分离引入“写后读不到” | 写后读路径走 writer；增加回归测试 |
| 架构治理脚本（`npm run check:architecture`）只认识 `src-tauri` 路由入口，迁移后误报或漏检 | 批 1 起同步扩展 `scripts/architecture/{core,rust}.mjs` 的入口与依赖规则（core 不得依赖 tauri、features 之间的依赖方向沿用现规则），每批重建基线并在提交说明中列出基线变化 |
| bin 迁出后 bundler 找不到 helper | 批 2 优先验证 `npm run tauri build` 产物包含 4 个 exe |
| 前端与 core 同时持有连接导致锁等待 | busy_timeout + 批量写事务；压测并发 |
