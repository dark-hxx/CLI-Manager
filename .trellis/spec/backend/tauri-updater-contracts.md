# Tauri Updater Contracts

> Executable contracts for CLI-Manager's Tauri 2 auto-update pipeline across React, Tauri config/capabilities, GitHub Actions release artifacts, and installer restart UX.

---

## Scenario: Official Tauri updater release and install flow

### 1. Scope / Trigger

- Trigger: changes touching update checks, update downloads/install, `src-tauri/tauri.conf.json`, `src-tauri/capabilities/default.json`, updater/process plugins, or release workflow signing env.
- This is a cross-layer contract because the frontend calls Tauri plugin APIs, the WebView capability grants updater/restart permissions, Tauri config defines signed update endpoints, and GitHub Actions must publish matching `latest.json` / signature artifacts.
- Do not use the GitHub Releases REST API as the actual auto-update mechanism. GitHub Releases may only be used as a manual fallback link.

### 2. Signatures

Frontend update store surface:

```ts
interface UpdateState {
  currentVersion: string | null;
  checking: boolean;
  updateAvailable: boolean;
  updateInfo: UpdateInfo | null;
  pendingUpdate: Update | null;
  downloading: boolean;
  downloadProgress: number;
  downloadTotalBytes: number | null;
  downloadedBytes: number;
  readyToInstall: boolean;
  installing: boolean;
  lastCheckedAt: string | null;
  error: string | null;
  releaseFallbackUrl: string;
  fetchVersion(): Promise<void>;
  checkUpdate(options?: { silent?: boolean }): Promise<UpdateInfo | null>;
  downloadUpdate(): Promise<boolean>;
  installAndRelaunch(): Promise<void>;
  reset(): void;
}
```

Tauri updater APIs used by frontend:

```ts
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

const update = await check();
await update.download((event) => { /* progress */ });
await update.install();
await relaunch();
```

Rust plugin registration:

```rust
.plugin(tauri_plugin_updater::Builder::new().build())
.plugin(tauri_plugin_process::init())
```

### 3. Contracts

#### Tauri config

`src-tauri/tauri.conf.json` must include:

```json
{
  "bundle": {
    "createUpdaterArtifacts": true
  },
  "plugins": {
    "updater": {
      "pubkey": "<Tauri updater public key content>",
      "endpoints": ["https://github.com/dark-hxx/CLI-Manager/releases/latest/download/latest.json"],
      "windows": {
        "installMode": "passive"
      }
    }
  }
}
```

- `pubkey` is public and may be committed.
- The matching private key must never be committed.
- Production endpoints must be HTTPS.
- Windows updater asset strategy is default/MSI; do not set `updaterJsonPreferNsis` unless the installer strategy is intentionally changed.

#### Capability / permissions

`src-tauri/capabilities/default.json` must grant only:

```json
"updater:default",
"process:allow-restart"
```

- Do not grant `process:default` for updater UI.
- Do not add file-system permissions for updater downloads; Tauri updater owns that flow.

#### Release workflow env

`.github/workflows/release.yml` must pass secrets to `tauri-apps/tauri-action`:

```yaml
env:
  TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
with:
  includeUpdaterJson: true
```

- `TAURI_SIGNING_PRIVATE_KEY` is required for releases that should auto-update.
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` is optional and required only when the signing key was generated with a password.
- The first version that includes updater support still requires manual installation; earlier releases without `latest.json` / `.sig` cannot be consumed by the official updater.

#### UX behavior

- Startup update check may run silently after startup readiness; failures must not interrupt first screen or terminal restore.
- Manual settings-page check may surface errors and retry actions.
- Download starts only after user clicks the download action.
- Install/relaunch requires explicit confirmation.
- If terminal sessions are active, the confirmation must show the active count and warn that tasks may be interrupted; the user may still confirm.
- Keep a Release-page fallback link for manifest/signature/network failures.
- AUR-managed installs (`get_app_version().distribution === "aur"`) must skip updater check/download/install and use the AUR package page as the fallback. Package-manager ownership takes precedence over the standalone updater UX.

### 4. Validation & Error Matrix

| Condition | Required behavior |
|---|---|
| No update available | `checkUpdate` returns `null`, sets `lastCheckedAt`, clears stale update state. |
| Startup check fails | No toast/error interruption; current app continues normally. |
| Manual check fails | Show a stable, understandable error with retry and Release fallback. |
| `latest.json` missing or invalid | Treat as update-check failure; do not claim no update. |
| Signature validation fails | Treat as updater failure; do not install; keep Release fallback. |
| Download progress has `contentLength` | Show percentage and byte progress. |
| Download progress lacks total length | Show indeterminate/downloading state, not `NaN`. |
| Download fails midway | Keep current app usable; allow retry or reset. |
| Download finished | Set `readyToInstall`; do not install automatically. |
| Active terminal count > 0 | Show strong warning with count before install/relaunch. |
| User confirms install | Call `install()` then `relaunch()` only after confirmation. |
| User chooses later | Keep downloaded/pending state when safe; do not close resources during active download/install. |

### 5. Good/Base/Bad Cases

- Good: release workflow publishes signed updater artifacts; app startup silently detects a new version; settings page displays notes; user downloads; active terminal warning appears; user confirms install/relaunch.
- Base: GitHub latest release lacks updater JSON; manual check shows failure and the Release fallback link, while terminal sessions continue unaffected.
- Bad: checking `https://api.github.com/repos/.../releases/latest` and manually comparing `tag_name` for the auto-update path bypasses Tauri's signed updater contract.
- Bad: granting `process:default` just to relaunch the app expands permissions beyond the updater UI need.

### 6. Tests Required

- TypeScript checks:
  - `checkUpdate({ silent: true })` must not set user-visible `error` on failure.
  - Progress math must handle unknown `contentLength` without `NaN`.
  - `reset()` must close pending updater resources only when not downloading/installing.
- UI checks:
  - Settings page renders no-update, checking, update-available, downloading, ready-to-install, installing, and error states.
  - Active terminal warning includes the count when at least one non-exited/non-error terminal exists.
  - Install action is unavailable until download is finished and confirmation is visible.
- Backend/config checks:
  - `src-tauri/tauri.conf.json` parses and includes `bundle.createUpdaterArtifacts` plus updater endpoint/pubkey.
  - `src-tauri/capabilities/default.json` includes `updater:default` and `process:allow-restart`, not `process:default`.
  - `cargo check --manifest-path src-tauri/Cargo.toml` passes after plugin changes.
- Release checks:
  - GitHub Actions release has `TAURI_SIGNING_PRIVATE_KEY` available.
  - Published release includes `latest.json` and signature-backed updater artifacts.

### 7. Wrong vs Correct

#### Wrong

```ts
const response = await fetch("https://api.github.com/repos/dark-hxx/CLI-Manager/releases/latest");
const latestVersion = (await response.json()).tag_name;
```

This can notify users, but it is not a signed installable update path.

#### Correct

```ts
const update = await check();
if (update) {
  await update.download(onDownloadEvent);
  await update.install();
  await relaunch();
}
```

#### Wrong

```json
"permissions": ["updater:default", "process:default"]
```

#### Correct

```json
"permissions": ["updater:default", "process:allow-restart"]
```

## Scenario: Target-scoped Tauri configuration features

### 1. Scope / Trigger

- Trigger: adding or moving a Tauri Cargo feature whose enablement must match a platform-specific `tauri.*.conf.json` value, such as `macos-private-api` / `app.macOSPrivateApi`; or adding a Windows native sidecar consumed beside the debug executable during `npm run tauri dev`.

### 2. Signatures

```toml
[dependencies]
tauri = { version = "2", features = ["tray-icon", "protocol-asset", "devtools"] }

[target.'cfg(target_os = "macos")'.dependencies]
tauri = { version = "2", features = ["macos-private-api"] }
```

```json
// src-tauri/tauri.macos.conf.json
{ "app": { "macOSPrivateApi": true } }
```

```text
# scripts/tauri-cli.mjs, Windows `tauri dev` only
cargo build --locked --manifest-path <repo>/src-tauri/Cargo.toml \
  --bin cli-manager-codex-proxy [--target <triple>] [--release]
```

### 3. Contracts

- Configuration-sensitive Tauri features must be declared under the same Cargo target that owns the corresponding platform config.
- Windows and Linux direct Cargo commands must not activate `macos-private-api`.
- macOS builds must activate `macos-private-api` and keep `app.macOSPrivateApi = true`.
- Tests must exercise the real Cargo invocation; do not inject a synthetic `TAURI_CONFIG` merely to suppress the consistency error.
- On Windows, the `scripts/tauri-cli.mjs` `dev` entrypoint must build `cli-manager-codex-proxy` before spawning Tauri, because remote Codex handoff resolves `current_exe().with_file_name("cli-manager-codex-proxy.exe")`.
- The prebuild must forward both `--target <triple>` / `--target=<triple>` and `-t <triple>` / `-t=<triple>` as Cargo's `--target <triple>`.
- The prebuild must forward `--release` only before Tauri's `--` argument boundary, so the proxy uses the same Cargo profile and executable directory without interpreting runner/application arguments.
- A failed or unavailable Cargo prebuild must return a non-zero exit and must not start Tauri. Non-Windows platforms and non-`dev` Tauri commands must not run this prebuild.

### 4. Validation & Error Matrix

| Condition | Required behavior |
|---|---|
| `macos-private-api` is in common dependencies | Reject: Windows/Linux direct Cargo builds can fail Tauri feature/config consistency checks. |
| macOS target feature is missing | Reject: macOS transparent/private-API window behavior loses its required Cargo capability. |
| macOS feature exists but `macOSPrivateApi` is false/missing | Reject through the existing macOS window-controls verification. |
| Common and target dependency declarations are correctly split | Windows/Linux resolve only common features; macOS additionally resolves `macos-private-api`. |
| Windows `tauri dev` without a target | Build the proxy into Cargo's default debug target before Tauri starts. |
| Windows `tauri dev` with either target syntax | Build the proxy for the same target triple before Tauri starts. |
| Windows `tauri dev --release` | Build the proxy in the release profile before Tauri starts. |
| Windows proxy Cargo build fails | Return Cargo's non-zero result and do not invoke Tauri. |
| Non-Windows or a non-`dev` Tauri command | Do not build the Windows proxy. |

### 5. Good / Base / Bad Cases

- Good: Windows Codex proxy E2E calls `cargo build --locked` directly and succeeds without platform-config overrides.
- Base: normal Tauri CLI builds continue merging the platform config and resolve the same target-specific feature set.
- Bad: set `TAURI_CONFIG` inside one test to claim success while the manifest still enables a macOS-only feature globally.
- Good: `npm run tauri dev -- --target x86_64-pc-windows-msvc` completes the proxy prebuild before launching the dev process.
- Bad: rely on Cargo's `default-run = "cli-manager"` and launch Tauri without compiling the separately consumed proxy binary.

### 6. Tests Required

- Inspect `cargo metadata --no-deps` and assert the common `tauri` dependency excludes `macos-private-api` while the macOS-target dependency includes it.
- Run `npm run test:codex-proxy:e2e` on Windows.
- Run `cargo check --locked --manifest-path src-tauri/Cargo.toml`.
- Run `node scripts/verify-macos-window-controls.mjs`.
- Run `npm run test:tauri-dev-proxy` on Windows. Assert Cargo runs before Tauri, target forwarding covers long and short forms, release profile respects the `--` boundary, Cargo failure prevents Tauri launch, and `build` does not prebuild the proxy.

### 7. Wrong vs Correct

#### Wrong

```toml
[dependencies]
tauri = { version = "2", features = ["macos-private-api"] }
```

#### Correct

```toml
[dependencies]
tauri = { version = "2", features = ["tray-icon", "protocol-asset", "devtools"] }

[target.'cfg(target_os = "macos")'.dependencies]
tauri = { version = "2", features = ["macos-private-api"] }
```

#### Wrong

```js
spawn("tauri", ["dev", ...args]);
```

#### Correct

```js
const proxyBuildCode = await buildWindowsDevProxy(tauriArgs);
if (proxyBuildCode !== 0) process.exitCode = proxyBuildCode;
else spawn("tauri", tauriArgs);
```
