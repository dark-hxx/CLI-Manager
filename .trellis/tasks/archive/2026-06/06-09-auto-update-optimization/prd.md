# 自动更新功能优化

## Goal

把现有“检查更新”从只能提示用户打开 GitHub Release 页，优化为应用内自动更新流程：自动检测新版本，并在合适的用户确认点完成下载与安装，降低手动下载成本。

## What I already know

* 当前用户目标：优化现有“检查更新”功能，做成自动更新。
* 当前前端已有 `src/stores/updateStore.ts`，通过 GitHub Releases latest API 检测版本。
* 当前 `src/App.tsx` 启动后会静默检查更新，发现新版本后 toast 提示“前往 Release 页面下载更新”。
* 当前 `src/components/settings/AboutSection.tsx` 有手动“检查更新”和“下载更新”按钮，但按钮实际是打开 Release 页面。
* 当前 Rust 侧只有 `get_app_version` 命令，未注册 updater 插件或下载/安装命令。
* 当前 `src-tauri/Cargo.toml` 未声明 `tauri-plugin-updater`。
* 当前 `src-tauri/tauri.conf.json` 未配置 updater endpoints / pubkey。
* 当前 release workflow 使用 `tauri-apps/tauri-action@v0` 发布多平台安装包，但未看到 updater manifest / 签名相关配置。
* 旧设计文档 `.claude/plan/版本显示与更新检测.md` 已建议使用 `tauri-plugin-updater`，但代码尚未落地。

## Assumptions (temporary)

* MVP 优先面向 Windows 桌面自动更新，因为项目定位主要是 Windows 桌面应用。
* 不做完全静默安装；安装/重启前应让用户确认，避免打断正在运行的终端任务。
* 自动检查可继续在启动后的 deferred startup 阶段执行，避免影响首屏。
* 下载与安装应尽量走 Tauri 官方 updater，而不是前端手动下载安装包。

## Open Questions

* 暂无阻塞问题。

## Requirements (evolving)

* MVP 采用“自动检查 + 用户确认后下载并安装”模式：不做后台静默下载，不做强制更新。
* 自动检测新版本，保留设置页手动检查入口。
* 发现新版本时提供应用内更新入口，而不是只打开 Release 页面。
* 用户点击“下载更新”后才开始下载，并展示下载进度。
* 下载完成后，安装/重启前必须有明确用户确认。
* 如果安装前检测到活跃终端，显示强警告和活跃终端数量；用户二次确认后仍可继续。
* 更新失败时不能影响当前应用使用，应展示可理解的错误并允许稍后重试。
* 更新能力必须遵守 Tauri capability / permission 最小授权。
* Tauri updater signing private key 不进入仓库；由用户配置到 GitHub Actions Secrets。
* `tauri.conf.json` 写入用户提供的 updater public key：`dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDdBNEUyMjYxRTlDM0FCMzYKUldRMnE4UHBZU0pPZWdUdXdZSENQWjVBclg3RDhSbkF5QzJMQ3lscUtnaEduUkdmenVpb1IrS0wK`。
* Signing private key 必须安全备份；后续更换电脑不影响已安装用户，只要 GitHub Actions Secrets 或新电脑仍使用同一把 private key。
* Windows updater 资产策略默认沿用当前 Release 文案的 MSI 安装包，不启用 `updaterJsonPreferNsis`。

## Acceptance Criteria (evolving)

* [ ] 应用启动后可自动检查更新，且不阻塞首屏和终端恢复。
* [ ] 设置页“检查更新”仍可手动触发。
* [ ] 发现新版本后能在应用内展示版本号、发布日期、更新说明。
* [ ] 用户确认后可下载并触发安装/重启流程。
* [ ] 网络失败、无更新、manifest 不可用时有明确 UI 状态，不误报。
* [ ] 当前版本号仍来自 Tauri 配置，不硬编码。

## Definition of Done (team quality bar)

* Tests added/updated where practical for version/status logic.
* `npm run build` / `npx tsc --noEmit` 相关类型检查通过。
* `cargo check` 通过。
* Tauri updater 配置、capability 权限、release 发布产物影响已说明。
* 行为变化如需文档或 spec 捕获，按 Trellis 流程更新。

## Out of Scope (explicit)

* 不在 MVP 中自建更新服务器。
* 不在 MVP 中做强制更新。
* 不在 MVP 中做破坏用户会话的静默重启。
* 不在 MVP 中重写 release workflow 之外的发布体系，除非 updater manifest 必需。

## Technical Notes

* 相关文件：`src/stores/updateStore.ts`、`src/App.tsx`、`src/components/settings/AboutSection.tsx`。
* 活跃终端可从 `src/stores/terminalStore.ts` 的 `sessions` 与 `sessionStatuses` 派生，用于安装/重启前提示风险。
* Rust 入口：`src-tauri/src/lib.rs` 注册插件与 commands；当前只注册 `commands::version::get_app_version`。
* Tauri 配置：`src-tauri/tauri.conf.json` 当前无 updater 配置。
* Capability：`src-tauri/capabilities/default.json` 当前无 updater 权限。
* 发布流程：`.github/workflows/release.yml` 当前用 `tauri-apps/tauri-action@v0`，需要确认是否能产出 updater 所需 artifact/manifest/signature。

## Research References

* [`research/tauri-updater.md`](research/tauri-updater.md) — 官方 updater 需要 `tauri-plugin-updater`、签名清单、capability 权限和 release workflow 配合。
* [`research/auto-update-ux.md`](research/auto-update-ux.md) — 对有长时间终端会话的应用，检查/下载可自动，安装/重启必须用户确认。

## Research Notes

### Feasible approaches here

**Approach A: 官方 updater，用户确认后下载并安装（Recommended）**

* How it works: 启动/设置页调用 Tauri updater `check()`；发现更新后显示应用内卡片；用户点击后下载并安装；安装/重启前明确提示。
* Pros: 用 Tauri 官方签名校验与安装流程，安全边界清晰，代码量适中。
* Cons: 首个支持 updater 的版本仍需用户手动安装一次；需要配置 signing secret、updater manifest 和 release workflow。

**Approach B: 后台自动下载，用户确认安装**

* How it works: 启动检查到更新后直接后台下载；下载完成后提示安装/重启。
* Pros: 用户少等下载时间，体验更接近成熟桌面应用。
* Cons: 实现状态更复杂；会占用网络；需要处理重复下载、版本过期、下载缓存和失败重试。

**Approach C: 保留 GitHub API 检测，只自动打开下载页**

* How it works: 继续用 GitHub Releases API；发现更新后更强提醒或自动打开 Release。
* Pros: 改动小。
* Cons: 不是真正自动更新，没有签名安装闭环，仍依赖用户手动下载。

### Additional constraints

* 官方 updater 不消费 GitHub Releases API 原始响应；需要 `latest.json` 或动态更新服务器返回指定 JSON。
* Tauri updater 强制签名校验，现有 release 资产缺少 `latest.json` 和 `.sig`，不能直接被当前官方 updater 消费。
* Windows install 阶段会退出应用；CLI-Manager 有活跃终端时必须避免静默重启。
* 若前端调用 updater/process API，需要在 `src-tauri/capabilities/default.json` 增加最小权限。
