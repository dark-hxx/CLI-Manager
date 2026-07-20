# Backend Development Guidelines

> Concrete backend contracts for Rust/Tauri code in this project.

---

## Guidelines Index

| Guide | Description | Status |
|-------|-------------|--------|
| [WebDAV Sync Contracts](./webdav-sync-contracts.md) | WebDAV sync request/response boundaries, size checks, and validation cases | Active |
| [Terminal Runtime Monitoring Contracts](./terminal-runtime-monitoring-contracts.md) | PTY env keys, shell OSC marker format, and tab runtime status mapping | Active |
| [Terminal OSC Color Contracts](./terminal-osc-color-contracts.md) | OSC 10/11 ownership, daemon color frames, local/WSL replies, and SSH filtering | Active |
| [Tauri Updater Contracts](./tauri-updater-contracts.md) | Signed updater config, capabilities, release artifacts, and install/relaunch UX contracts | Active |
| [cc-switch Integration Contracts](./ccswitch-integration-contracts.md) | External SQLite read-only access (sqlx, no rusqlite), secret masking, and per-project settings.json env replacement | Active |
| [History Stats Contracts](./history-stats-contracts.md) | History usage stats payloads, token/cost fields, cache behavior, and frontend normalization | Active |
| [History Index Contracts](./history-index-contracts.md) | Cached history list, FTS5 search, incremental refresh, and failure fallback | Active |
| [Model Pricing Contracts](./model-pricing-contracts.md) | User-configurable model prices, remote sync, backend cache bridge, and cost calculation authority | Active |
| [CLI Hook Contracts](./cli-hook-contracts.md) | 本地及 SSH Claude/Codex Hook 安装、事件、bridge payload、通知与子 Agent transcript 路由 | Active |
| [WSL Path Contracts](./wsl-path-contracts.md) | WSL UNC 路径的 Plan 9 限制、wsl.exe 规避方案、路径转换工具签名和安全性 | Active |
| [ccusage Contracts](./ccusage-contracts.md) | ccusage 运行环境显式开关、缓存 scope 与前后端 WSL 判定合约 | Active |
| [Project File Command Contracts](./project-file-command-contracts.md) | 项目根目录内文件浏览、读写、复制移动和路径边界校验命令合约 | Active |
| [App Startup Contracts](./app-startup-contracts.md) | 应用启动链路、单实例约束与主窗口唤醒行为 | Active |
| [Linux Graphics Contracts](./linux-graphics-contracts.md) | WebKitGTK/NVIDIA/Wayland 分级兼容、诊断与 AUR 渠道 | Active |
| [Worktree Isolation Contracts](./worktree-isolation-contracts.md) | Git worktree 并行任务隔离、生命周期和安全边界合约 | Active |
| [Git Status Contracts](./git-status-contracts.md) | Git 状态收集三条链路（面板/Replay/WSL）的过滤合约与嵌套子仓库处理 | Active |
| [Command Suggestion Contracts](./command-suggestion-contracts.md) | LLM 命令提示 Tauri command、OpenAI 兼容请求、快速检测、超时与安全回退合约 | Active |
| [App Data Persistence Contracts](./app-data-persistence-contracts.md) | Stable `.cli-manager` data paths, non-destructive legacy store migration, and safe legacy DB recovery | Active |
| [Statusline Contracts](./statusline-contracts.md) | 内置 Claude 状态栏子命令、配置存储、预览、旧配置导入与安装边界 | Active |
| [System Resource Contracts](./system-resource-contracts.md) | CPU 物理核心、逻辑线程与前端展示字段契约 | Active |
| [Local Path Opening Contracts](./local-path-opening-contracts.md) | WebView 本地路径打开、Rust command 参数与 opener scope 边界 | Active |
| [SSH Remote Terminal Contracts](./ssh-remote-terminal-contracts.md) | SSH 主机、远程项目、OpenSSH Launch Plan、PTY/daemon、能力路由与同步安全边界 | Active |
| [SSH Agent Contracts](./ssh-agent-contracts.md) | `cli-manager-ssh-agent`、共享 SSH transport、probe/安装、远端 Hook 配置、spool bridge 与身份边界 | Active |

---

## Pre-Development Checklist

Before modifying Rust/Tauri backend code:

- [ ] Read the relevant contract file for the affected module.
- [ ] Keep existing Tauri command signatures stable unless the task explicitly changes the contract.
- [ ] Validate external input at the Rust boundary, not only in the WebView.
- [ ] Run `cd src-tauri && cargo check` after backend changes.
