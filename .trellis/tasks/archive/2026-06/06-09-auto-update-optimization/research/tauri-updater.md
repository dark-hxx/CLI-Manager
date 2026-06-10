# Summary

- 官方 Tauri 2 更新不是直接读取 GitHub Releases API；它使用 `tauri-plugin-updater` 校验签名后的更新清单和安装包。
- 前端常规流程是 `@tauri-apps/plugin-updater` 的 `check()` → `downloadAndInstall()` → `@tauri-apps/plugin-process` 的 `relaunch()`；Rust 侧也可用 `UpdaterExt` 执行同样流程并调用 `app.restart()`。
- 本仓库当前只在 `src/stores/updateStore.ts:71-89` 请求 `https://api.github.com/repos/dark-hxx/CLI-Manager/releases/latest` 并打开 Release 页面，Rust 侧只有 `get_app_version`（`src-tauri/src/commands/version.rs:12-20`），尚未接入官方 updater。
- 当前最新 GitHub Release `V0.2.5` 有常规安装包资产，但没有 `latest.json` 和 `.sig` 更新签名资产；这意味着现有发布资产不能直接被官方 Tauri updater 安装。

# Official Setup

## 依赖与插件注册

- Rust crate：`tauri-plugin-updater = "2"`，官方手动安装命令示例为在 `src-tauri` 下执行 `cargo add tauri-plugin-updater --target 'cfg(any(target_os = "macos", windows, target_os = "linux"))'`。
- JS package：`@tauri-apps/plugin-updater`。
- 如果前端安装完成后要重启应用，还需要 `tauri-plugin-process` 和 `@tauri-apps/plugin-process`；官方 JS 示例从 `@tauri-apps/plugin-process` 导入 `relaunch()`。
- Rust 注册方式：在 Tauri builder 中注册 `tauri_plugin_updater::Builder::new().build()`，通常用 `#[cfg(desktop)]` 限制桌面平台。若使用 JS `relaunch()`，还要注册 `tauri_plugin_process::init()`。

## capability / permission

- Updater 前端 API 默认被 capability 阻止，需要在 `src-tauri/capabilities/default.json` 增加 `"updater:default"`。
- `updater:default` 包含：`allow-check`、`allow-download`、`allow-install`、`allow-download-and-install`。
- 若前端调用 `relaunch()`，需要增加 `"process:default"` 或更窄的 `"process:allow-restart"`。

## tauri.conf.json 配置键

官方 `tauri.conf.json` 形态：

```json
{
  "bundle": {
    "createUpdaterArtifacts": true
  },
  "plugins": {
    "updater": {
      "pubkey": "CONTENT FROM PUBLICKEY.PEM",
      "endpoints": [
        "https://github.com/user/repo/releases/latest/download/latest.json"
      ],
      "windows": {
        "installMode": "passive"
      }
    }
  }
}
```

- `bundle.createUpdaterArtifacts`：`true` 时 Tauri 生成 v2 updater artifacts；`"v1Compatible"` 用于旧 v1 迁移，但官方说明 v3 会移除。
- `plugins.updater.pubkey`：必须是 Tauri signer 生成的公钥内容，不是文件路径。
- `plugins.updater.endpoints`：字符串数组；生产模式强制 TLS。只有请求返回非 2xx 时才会尝试下一个 URL。
- endpoint 支持变量：`{{current_version}}`、`{{target}}`（`linux` / `windows` / `darwin`）、`{{arch}}`（`x86_64` / `i686` / `aarch64` / `armv7`）。
- `plugins.updater.dangerousInsecureTransportProtocol`：允许非 HTTPS，仅适合受控开发/测试场景。
- `plugins.updater.windows.installMode`：`passive` 默认且推荐；`basicUi` 需要用户交互；`quiet` 无进度反馈且不能自行请求管理员权限，官方不推荐。

## 签名与更新清单

- Tauri updater 强制校验签名，不能关闭。
- 生成密钥：`npm run tauri signer generate -- -w ~/.tauri/myapp.key`。
- 构建时必须提供私钥环境变量：`TAURI_SIGNING_PRIVATE_KEY`，可选 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`；官方说明 `.env` 文件不生效。
- 生成的 `.sig` 文件内容必须写入更新 JSON 的 `signature` 字段；不能填 `.sig` 的路径或 URL。
- 静态 JSON endpoint 需要形如：

```json
{
  "version": "v1.0.0",
  "notes": "release notes",
  "pub_date": "2026-06-09T00:00:00Z",
  "platforms": {
    "windows-x86_64": {
      "signature": "<sig file content>",
      "url": "https://github.com/user/repo/releases/download/v1.0.0/app.msi"
    },
    "darwin-aarch64": {
      "signature": "<sig file content>",
      "url": "https://github.com/user/repo/releases/download/v1.0.0/app.app.tar.gz"
    },
    "linux-x86_64": {
      "signature": "<sig file content>",
      "url": "https://github.com/user/repo/releases/download/v1.0.0/app.AppImage"
    }
  }
}
```

- 静态 JSON 必填：`version`、`platforms.[target].url`、`platforms.[target].signature`。
- Tauri 会先校验整个 JSON 文件，再比较版本；因此 JSON 中已有平台配置必须完整有效。
- 动态更新服务器无更新时返回 `204 No Content`；有更新时返回 `200 OK`，JSON 必填 `version`、`url`、`signature`。
- `tauri-apps/tauri-action@v0` 的 README 说明 `includeUpdaterJson` 默认会上传 updater JSON（仅在 updater 已配置时相关），并提供 `updaterJsonPreferNsis` 用于 Windows 同时存在 NSIS 和 WiX/MSI 时选择 JSON 指向哪个安装包。

## download / install / restart 常规流程

JS 侧官方流程：

```ts
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

const update = await check();
if (update) {
  await update.downloadAndInstall((event) => {
    // event.event: "Started" | "Progress" | "Finished"
  });
  await relaunch();
}
```

- `check(options?)` 返回 `Promise<Update | null>`。
- `downloadAndInstall(onEvent?, options?)` 下载安装包并安装；也可以拆成 `download()` 和 `install()`。
- 下载事件包含：`Started`（`contentLength`）、`Progress`（`chunkLength`）、`Finished`。
- Rust 侧流程等价：`app.updater()?.check().await?` → `update.download_and_install(...).await?` → `app.restart()`。
- 如果用 Rust command 给前端上报下载进度，官方示例使用 `tauri::ipc::Channel` 和一个 `PendingUpdate` state 缓存待安装更新。

# Repo Mapping

## 当前代码位置

| 文件 | 当前状态 |
|---|---|
| `src/stores/updateStore.ts:57-64` | 通过 `invoke("get_app_version")` 获取当前版本。 |
| `src/stores/updateStore.ts:71-89` | 请求 GitHub Releases API，比较 `tag_name`，只保存 Release HTML URL。 |
| `src/components/settings/AboutSection.tsx:29-37` | 点击“下载更新”时用 `openUrl(updateInfo.downloadUrl)` 打开网页。 |
| `src/components/settings/AboutSection.tsx:122-128` | UI 文案仍是“下载更新”，实际是外链跳转。 |
| `src/App.tsx:166-185` | 启动后静默检查，发现新版本后 toast 提示并打开 Release 页面。 |
| `src-tauri/src/commands/version.rs:12-20` | Rust 只暴露 `get_app_version`，无 updater command。 |
| `src-tauri/src/lib.rs:175-296` | 已注册 log/dialog/fs/shell/store/sql/opener 等插件，未注册 updater/process。 |
| `src-tauri/Cargo.toml:20-40` | Tauri 2 相关依赖存在，但没有 `tauri-plugin-updater` / `tauri-plugin-process`。 |
| `package.json:12-45` | 有多个 Tauri JS 插件，但没有 `@tauri-apps/plugin-updater` / `@tauri-apps/plugin-process`。 |
| `src-tauri/tauri.conf.json:36-45` | `bundle.targets = "all"`，没有 `createUpdaterArtifacts`，没有 `plugins.updater`。 |
| `src-tauri/capabilities/default.json:8-32` | 没有 `updater:default` 或 `process:*` 权限。 |
| `.github/workflows/release.yml:51-86` | 使用 `tauri-apps/tauri-action@v0` 构建 Release；未设置 updater signing 环境变量，未显式配置 `includeUpdaterJson` / `updaterJsonPreferNsis`。 |

## 发布流程约束

- Release tag 模式是 `V__VERSION__`（`.github/workflows/release.yml:56`），当前最新 release 是 `V0.2.5`；Tauri 静态 endpoint 可使用 `https://github.com/dark-hxx/CLI-Manager/releases/latest/download/latest.json`，不需要手写 GitHub API 解析。
- 当前 workflow matrix 构建 Windows、macOS Apple Silicon、Linux；静态 `latest.json` 需要覆盖对应平台键，例如 `windows-x86_64`、`darwin-aarch64`、`linux-x86_64`。
- 当前 `bundle.targets = "all"` 会产出多种包；最新 release 已同时包含 Windows NSIS `.exe` 和 MSI `.msi`，Tauri Action 的 updater JSON 对 Windows 资产选择会受 `updaterJsonPreferNsis` 影响。
- `.trellis/spec/guides/version-update-checklist.md` 要求 `package.json`、`package-lock.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`、`src-tauri/tauri.conf.json` 版本保持一致；updater 版本比较依赖这些版本源准确。

# Risks

- 签名风险：Tauri updater 签名和 Windows/macOS 代码签名不是一回事。当前 release body 明确提示 Windows SmartScreen 和 macOS 未签名/未公证；这不会替代 Tauri updater 的 `.sig`，也不会消除系统信任提示。
- 引导风险：现有已安装版本没有官方 updater 插件和公钥配置，不能自动升级到“首个支持官方 updater 的版本”；用户至少需要手动安装一次带 updater 的版本。
- 资产风险：当前 `V0.2.5` Release 没有 `latest.json` 和 `.sig`，官方 updater 不能消费这些资产完成安装。
- Endpoint 风险：当前 `api.github.com/repos/.../releases/latest` 响应不是 Tauri updater 所需格式；官方 updater 需要静态 `latest.json` 或动态服务器 JSON。
- GitHub latest 风险：`releases/latest/download/latest.json` 指向 GitHub 认定的 latest release；draft / prerelease 不会按普通 latest 语义暴露，测试预发布通道需要单独 endpoint 或 release 策略。
- Windows 安装风险：`quiet` 模式无法自行请求管理员权限；如果安装包需要提权，`passive` 或 `basicUi` 更安全。当前同时产出 `.exe` 和 `.msi`，必须明确 updater JSON 偏向 NSIS 还是 MSI。
- 生产/开发差异：生产模式强制 HTTPS；本地 HTTP 测试需要 `dangerousInsecureTransportProtocol`，该配置不应进入正式发布配置。
- JSON 完整性风险：静态 JSON 会整体校验；其中任一平台已有配置缺少 `url` 或 `signature` 都可能导致检查失败，即使当前机器不是该平台。

# Recommended MVP

1. 使用官方 updater 替换现有“GitHub API 检查 + 打开网页”的更新路径；保留现有 `updateStore` / `AboutSection` 状态入口，改为承载 `check()`、下载进度、安装和重启状态。
2. 增加最少依赖：`tauri-plugin-updater`、`@tauri-apps/plugin-updater`；若由前端重启，则同时增加 `tauri-plugin-process`、`@tauri-apps/plugin-process` 和 `process:allow-restart`。
3. 在 `tauri.conf.json` 增加 `bundle.createUpdaterArtifacts = true` 和 `plugins.updater`：`pubkey` 使用 signer 公钥内容，`endpoints` 使用 `https://github.com/dark-hxx/CLI-Manager/releases/latest/download/latest.json`，Windows 先使用默认/显式 `passive`。
4. 在 `src-tauri/capabilities/default.json` 增加 `updater:default`；如果只需要重启，不授予完整 `process:default`，优先使用 `process:allow-restart`。
5. 在 GitHub Actions Secrets 配置 `TAURI_SIGNING_PRIVATE_KEY` 和可选 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`，并传给 `.github/workflows/release.yml` 的 tauri-action；保留或显式设置 `includeUpdaterJson: true`。
6. Windows MVP 先明确一个 updater 资产策略：沿用 action 默认 MSI，或设置 `updaterJsonPreferNsis: true` 指向 NSIS；不要同时让 UI 文案暗示两套安装路径。
7. 第一版交互保持简单：检查到更新 → 展示版本/说明 → 用户点击下载并安装 → 显示进度 → 安装完成后提示/执行重启。

# External References

- Tauri 2 Updater plugin docs：https://v2.tauri.app/plugin/updater/
- Tauri 2 JavaScript updater API：https://v2.tauri.app/reference/javascript/updater/
- Tauri 2 Process plugin docs：https://v2.tauri.app/plugin/process/
- Tauri Action v0 README：https://github.com/tauri-apps/tauri-action/tree/v0
