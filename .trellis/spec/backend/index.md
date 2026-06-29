# Backend Development Guidelines

> Concrete backend contracts for Rust/Tauri code in this project.

---

## Guidelines Index

| Guide | Description | Status |
|-------|-------------|--------|
| [WebDAV Sync Contracts](./webdav-sync-contracts.md) | WebDAV sync request/response boundaries, size checks, and validation cases | Active |
| [Terminal Runtime Monitoring Contracts](./terminal-runtime-monitoring-contracts.md) | PTY env keys, shell OSC marker format, and tab runtime status mapping | Active |
| [Tauri Updater Contracts](./tauri-updater-contracts.md) | Signed updater config, capabilities, release artifacts, and install/relaunch UX contracts | Active |
| [cc-switch Integration Contracts](./ccswitch-integration-contracts.md) | External SQLite read-only access (sqlx, no rusqlite), secret masking, and per-project settings.json env replacement | Active |
| [History Stats Contracts](./history-stats-contracts.md) | History usage stats payloads, token/cost fields, cache behavior, and frontend normalization | Active |
| [Model Pricing Contracts](./model-pricing-contracts.md) | User-configurable model prices, remote sync, backend cache bridge, and cost calculation authority | Active |
| [CLI Hook Contracts](./cli-hook-contracts.md) | Claude/Codex hook install events, bridge payload fields, and sub-agent transcript routing | Active |
| [WSL Path Contracts](./wsl-path-contracts.md) | WSL UNC 路径的 Plan 9 限制、wsl.exe 规避方案、路径转换工具签名和安全性 | Active |
| [ccusage Contracts](./ccusage-contracts.md) | ccusage 运行环境显式开关、缓存 scope 与前后端 WSL 判定合约 | Active |
| [Project File Command Contracts](./project-file-command-contracts.md) | 项目根目录内文件浏览、读写、复制移动和路径边界校验命令合约 | Active |
| [App Startup Contracts](./app-startup-contracts.md) | 应用启动链路、单实例约束与主窗口唤醒行为 | Active |

---

## Pre-Development Checklist

Before modifying Rust/Tauri backend code:

- [ ] Read the relevant contract file for the affected module.
- [ ] Keep existing Tauri command signatures stable unless the task explicitly changes the contract.
- [ ] Validate external input at the Rust boundary, not only in the WebView.
- [ ] Run `cd src-tauri && cargo check` after backend changes.
