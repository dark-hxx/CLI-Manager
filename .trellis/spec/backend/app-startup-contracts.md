# App Startup Contracts

## Scenario: Debug-mode F12 DevTools

### 1. Scope / Trigger

- Trigger: 修改主窗口 DevTools 打开入口、F12 调试快捷键、`debugMode` 行为或 Tauri `devtools` feature 时。

### 2. Signatures

- Frontend setting: `settingsStore.debugMode: boolean`
- Frontend handler: `src/App.tsx` 捕获 `KeyboardEvent.key === "F12"`
- Backend command: `app_open_devtools(app: AppHandle) -> Result<(), String>`
- Tauri feature: `tauri = { features = ["devtools", ...] }`

### 3. Contracts

- `debugMode=false` 时，前端必须拦截 F12 并阻止默认 DevTools 行为，但不得调用 `app_open_devtools`。
- `debugMode=true` 时，前端必须拦截 F12 并调用 `app_open_devtools` 打开主窗口 DevTools。
- `app_open_devtools` 只负责打开已存在的 `main` WebView DevTools，不读取或修改设置。
- Release 构建需要启用 Tauri `devtools` feature，否则 Rust 侧 DevTools API 不可用。

### 4. Validation & Error Matrix

- `main` 窗口存在 -> 打开 DevTools 并返回 `Ok(())`。
- `main` 窗口不存在 -> 返回 `"main window not found"`。
- 前端非 Tauri 环境 -> 不注册 F12 处理器。
- 后端打开失败 -> 前端只记录 warn，不弹出用户提示。

### 5. Good/Base/Bad Cases

- Good: 开启调试模式后按 F12 打开 DevTools；关闭后按 F12 无效果。
- Base: 调试模式仍继续驱动现有 debug logging 开关。
- Bad: 只启用 Tauri `devtools` feature 而不拦截 F12，导致关闭调试模式时仍可打开 DevTools。

### 6. Tests Required

- 前端类型检查：`npx tsc --noEmit`
- 后端编译检查：`cd src-tauri && cargo check`
- 手动验证：设置 -> 通用 -> 调试模式关闭时 F12 无效果；开启后 F12 打开 DevTools。

### 7. Wrong vs Correct

#### Wrong

```tsx
window.addEventListener("keydown", (event) => {
  if (event.key === "F12") invoke("app_open_devtools");
});
```

#### Correct

```tsx
window.addEventListener("keydown", (event) => {
  if (event.key !== "F12") return;
  event.preventDefault();
  event.stopPropagation();
  if (useSettingsStore.getState().debugMode) invoke("app_open_devtools");
}, true);
```

## Scenario: Development Single-Instance Domain

### 1. Scope / Trigger

- Trigger: `npm run tauri dev` must be usable while an installed production CLI-Manager instance is already running.

### 2. Signatures

- Dev config: `src-tauri/tauri.dev.conf.json`
- NPM wrapper: `scripts/tauri-cli.mjs`
- Dev command: `npm run tauri dev`

### 3. Contracts

- Production keeps `identifier = "com.cli-manager.app"`.
- Development must keep the production identifier so it reads the same app data and SQLite/store files as production.
- Development must use a prerelease `version` in the dev-only Tauri config, and `tauri-plugin-single-instance` must enable its `semver` feature. Dev and production are separate single-instance domains by version, not by app identifier.
- `npm run tauri dev` must inject the dev config automatically unless the caller already supplied `--config`/`-c`.
- Other Tauri commands such as `build`, `add`, and explicit custom-config invocations pass through unchanged.

### 4. Validation & Error Matrix

- Production app running + `npm run tauri dev` -> dev app launches normally with the same identifier and a dev prerelease version.
- Dev app already running + second `npm run tauri dev` -> existing dev window is focused by the single-instance callback.
- Caller supplies `npm run tauri -- dev --config <file>` or `-c <file>` -> wrapper must not inject the default dev config.
- `npm run tauri build` -> production identifier remains unchanged.

### 5. Good/Base/Bad Cases

- Good: installed production and local dev can run side by side; both read the same project/settings data, and each still prevents duplicate instances within its own versioned single-instance domain.
- Base: no production instance is running; `npm run tauri dev` behaves like normal Tauri dev, with a dev product name and identifier.
- Bad: disabling `tauri_plugin_single_instance` in debug builds, because it hides duplicate-launch regressions.
- Bad: changing the dev identifier for development convenience; this forks the app data directory and makes project/settings data look empty.

### 6. Tests Required

- Type-check or script syntax check after changing the npm wrapper.
- Tauri config validation via `npm run tauri -- dev --help` or a dev smoke run.
- Manual smoke: keep installed production running, run `npm run tauri dev`, and verify the dev window stays open.

### 7. Wrong vs Correct

#### Wrong

```rust
#[cfg(not(debug_assertions))]
.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
    show_main_window(app);
}))
```

#### Correct

```json
{
  "version": "1.2.1-dev.0"
}
```


> CLI-Manager 桌面应用启动期的可执行约束。

---

## Scenario: Single-instance desktop startup

### 1. Scope / Trigger

- Trigger: 修改 `src-tauri/src/lib.rs` 的 `run()` 启动链路、窗口首次创建逻辑、托盘唤醒逻辑、Tauri 启动插件顺序时。

### 2. Signatures

- 启动入口：`src-tauri/src/lib.rs::run()`
- 窗口唤醒辅助：`show_main_window<R: Runtime>(app: &AppHandle<R>)`
- 单实例插件注册：
  `tauri_plugin_single_instance::init(|app, _args, _cwd| { ... })`

### 3. Contracts

- 桌面端只允许一个 CLI-Manager 进程实例存在。
- 当用户在应用已运行时再次从桌面、任务栏或其他壳入口启动应用：
  - 新实例必须被单实例插件拦截。
  - 已运行实例必须尝试唤醒 `main` 窗口。
- 唤醒 `main` 窗口的标准行为：
  - `window.show()`
  - `window.unminimize()`
  - `window.set_focus()`
- 单实例插件必须在 `tauri::Builder::default()` 链上最先注册。

### 4. Validation & Error Matrix

- `main` 窗口存在 -> 执行显示、取消最小化、聚焦。
- `main` 窗口不存在 -> 允许静默跳过，不得 panic。
- 单实例插件未最先注册 -> 视为错误配置，重复启动拦截行为不再有保证。

### 5. Good/Base/Bad Cases

- Good: 应用最小化到托盘后再次启动，旧窗口被拉起且无第二个进程。
- Base: 应用已在前台，再次启动后仍保持单实例，只做一次聚焦。
- Bad: 移除或后置单实例插件，导致桌面重复启动出现多个进程。

### 6. Tests Required

- 后端编译检查：`cd src-tauri && cargo check`
- 后端回归测试：`cd src-tauri && cargo test`
- 手动验证：
  - 先启动应用并隐藏/最小化。
  - 再从桌面或任务栏启动一次。
  - 断言不会出现第二个 CLI-Manager 进程，且已有主窗口被显示并聚焦。

### 7. Wrong vs Correct

#### Wrong

- 在托盘点击、二次启动回调里各自复制窗口唤醒逻辑。
- 先注册其他插件，再注册单实例插件。

#### Correct

- 统一复用 `show_main_window(...)`。
- 在 `tauri::Builder::default()` 后立刻注册单实例插件，再继续其他插件和 `setup(...)`。

## Scenario: App exit cleanup feedback

### 1. Scope / Trigger

- Trigger: window close, tray quit, or close-confirm dialog chooses exit while terminal PTYs and optional auto-backup may still be active.
- This is cross-layer because React drives exit UX, WebDAV backup may cross the network, and Rust owns PTY process cleanup.

### 2. Signatures

- Frontend close behavior setting: `settingsStore.closeBehavior: "minimize" | "exit" | "ask"`.
- Frontend cleanup entry: `runExitCleanup(source: string) -> Promise<void>` in `src/App.tsx`.
- Frontend overlay state: `exitPhase: "syncing" | "closing" | null`.
- Frontend overlay component: `ExitProgressOverlay({ phase, notice })`.
- Backend command during exit: `pty_close_all() -> Result<(), String>`.

### 3. Contracts

- If `closeBehavior="minimize"`, close requests hide the window and must not run exit cleanup.
- All true-exit paths (tray quit, `closeBehavior="exit"`, and close dialog confirm exit) must enter `runExitCleanup`.
- `runExitCleanup` must show an exit overlay before starting potentially slow work; the app must not appear frozen while sync or PTY cleanup runs.
- Close-phase auto-backup writes the outbox before network upload and is bounded by a frontend timeout (currently 8 seconds). Timeout or error must show a short overlay notice, log a warning, and continue exit cleanup; queued uploads retry next startup.
- `pty_close_all` runs after the sync phase and before session metadata clearing / window destroy.
- Exit-path notices should not be normal toast notifications because the app is about to destroy the window.

### 4. Validation & Error Matrix

| Condition | Required behavior |
|---|---|
| Auto-backup skipped, succeeds, or is queued | Advance from `syncing` to `closing`. |
| Auto-backup returns error | Show failure notice briefly, log warning, then continue exit. |
| Auto-backup does not settle before timeout | Show timeout notice briefly, log warning, then continue exit; outbox remains authoritative. |
| `pty_close_all` fails | Log warning and continue to clear session state / destroy window. |
| Exit requested twice while cleanup is active | Do not start independent duplicate cleanups; keep the existing overlay path authoritative. |

### 5. Good/Base/Bad Cases

- Good: user confirms exit and immediately sees “syncing/closing” progress feedback instead of a 3-5 second unresponsive window.
- Good: slow WebDAV close backup times out at the frontend limit, leaves an outbox file, and the app still exits.
- Base: auto-backup disabled; overlay quickly transitions to terminal closing and exits.
- Bad: awaiting WebDAV sync and serial PTY cleanup before showing any UI feedback.
- Bad: reporting close-sync failures only via toast while destroying the window.

### 6. Tests Required

- Frontend type-check: `npx tsc --noEmit` after changing exit UI or cleanup logic.
- Backend checks: `cd src-tauri && cargo check` and `cd src-tauri && cargo test` after changing `pty_close_all`.
- Manual desktop verification: tray quit, `closeBehavior="exit"`, and close dialog confirm exit all show the overlay and eventually exit.
- Manual slow-backup verification: simulate slow/failed WebDAV upload and confirm the outbox survives while exit continues.

### 7. Wrong vs Correct

#### Wrong

```tsx
await runCloseAutoSync();
await invoke("pty_close_all");
await getCurrentWindow().destroy();
```

#### Correct

```tsx
setExitPhase("syncing");
const result = await withTimeout(runCloseAutoSync(), CLOSE_SYNC_TIMEOUT_MS);
if (result !== "success" && result !== "skipped") await showExitNotice(result);

setExitPhase("closing");
await invoke("pty_close_all").catch(logWarn);
await getCurrentWindow().destroy();
```

## Scenario: SQLite migration checksum drift repair

### 1. Scope / Trigger

- Trigger: modifying `src-tauri/src/lib.rs::migrations()`, adding SQLite migrations, or changing startup database loading in `src/lib/db.ts`.
- SQLx validates `_sqlx_migrations.checksum` by migration version. A released migration version must never be reused for different SQL.

### 2. Signatures

- Backend migrations: `src-tauri/src/lib.rs::migrations() -> Vec<Migration>`.
- Backend repair command: `db_repair_known_migration_drift() -> Result<DbMigrationRepairResult, String>`.
- Frontend entry: `src/lib/db.ts::getDb() -> Promise<Database>`.
- SQLite bookkeeping table: `_sqlx_migrations(version, description, success, checksum, execution_time)`.

### 3. Contracts

- `getDb()` must call `db_repair_known_migration_drift` before the first `Database.load(...)`.
- The repair command must only use `app_paths::db_path()`; do not accept an arbitrary frontend path.
- Repair is limited to known migration drift versions `13..=15`.
- Repair rewrites only `_sqlx_migrations` rows for known complete schema states; it must not delete user data tables or rerun unsafe `ALTER TABLE` statements.
- Current migration SQL strings shared with repair code must live in one source of truth, not duplicated with separate literals.

### 4. Validation & Error Matrix

| Condition | Required behavior |
|---|---|
| DB file missing | Return `repaired=false`, let Tauri SQL create and migrate normally. |
| `_sqlx_migrations` missing | Return `repaired=false`, let Tauri SQL initialize migrations normally. |
| Old `13=cli_args` only | Move applied record to current `14=cli_args`; SQLx later applies missing `13` and `15`. |
| Old `13=cli_args`, `14=worktree`, `15=favorite` | Rewrite records to current `13=favorite`, `14=cli_args`, `15=worktree`. |
| Current records already match | No-op. |
| Partial feature schema | Return explicit `migration_repair_partial_*` error; do not rewrite records. |
| Unknown migration drift outside `13..=15` | Leave it to SQLx to fail loudly. |

### 5. Good/Base/Bad Cases

- Good: an install that previously applied the worktree branch migrations can still start after merging master migration order.
- Base: a clean database runs normal SQLx migrations with no repair.
- Bad: deleting all `_sqlx_migrations` rows. That causes `ALTER TABLE` migrations to rerun and can corrupt startup.
- Bad: changing SQL for an already released migration version without a compatibility repair and regression tests.

### 6. Tests Required

- Rust unit tests for each supported old lineage and for partial-schema rejection.
- `cargo check --manifest-path src-tauri/Cargo.toml`.
- `cargo test --manifest-path src-tauri/Cargo.toml db_repair`.
- `npx tsc --noEmit --pretty false` after touching `src/lib/db.ts`.

### 7. Wrong vs Correct

#### Wrong

```rust
Migration {
    version: 13,
    description: "new_meaning",
    sql: "ALTER TABLE projects ADD COLUMN something_else TEXT;",
    kind: MigrationKind::Up,
}
```

#### Correct

```rust
pub(crate) const MIGRATION_NEW_FEATURE_VERSION: i64 = 16;

Migration {
    version: MIGRATION_NEW_FEATURE_VERSION,
    description: "new_feature",
    sql: MIGRATION_NEW_FEATURE_SQL,
    kind: MigrationKind::Up,
}
```
