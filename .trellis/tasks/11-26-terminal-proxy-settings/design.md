# V1.5.3 · 代理配置架构设计（Design）

## 1. 数据模型与存储

- **前端偏好（`settings.json`）**：`Settings.proxySettings: ProxySettings`
  - `globalEnabled: boolean`
  - `globalUrl: string`
  - `globalNoProxy: string`
  - `agents: Record<string, AgentProxyRule>`（键为 `CliToolDescriptor.id`）
- **项目配置（SQLite `projects` 表）**：
  - Migration **v43**：`ALTER TABLE projects ADD COLUMN proxy_config TEXT NOT NULL DEFAULT '';`
  - 空串等价于 `{ mode: "inherit", url: "", noProxy: "" }`；非默认配置序列化为紧凑 JSON。
  - `src-tauri/src/features/app-data/repair/mod.rs` 在 `db_repair_known_migration_drift` 中补齐 `ensure_project_proxy_config_column` 漂移修复。
  - `sync/commands.rs` 与 `syncStore.ts` 同步更新 `projects` 备份导出和恢复白名单，并保留旧版列清单以兼容历史备份恢复。

## 2. 共享解析与环境注入链路

- **`src/shared/lib/cliTools.ts`**：导出 `PROJECT_CLI_TOOL_OPTIONS`、`resolveCliToolDescriptor`、`resolveProxyAgentId`，作为新建项目弹框与设置页 Agent 列表的唯一数据源。
- **`src/shared/lib/proxySettings.ts`**：负责 URL 协议/格式校验、凭据剥离、`NO_PROXY` 本地回环保护合并、三层优先级解析与环境变量合并。
- **`src/features/terminal/lib/terminalLaunch.ts`**：在 `resolvePtyLaunch()` 内分别为 SSH 分支与 Local/WSL 分支解析并注入代理环境变量。
- **Rust PTY 平台与 WSL 转发**：
  - `src-tauri/src/infrastructure/pty/manager.rs`：`apply_wsl_env_forwarding` 转发非空代理变量至 `WSLENV`（跳过 `direct` 空值）。
  - `src-tauri/src/infrastructure/pty/platform/windows.rs` & `unix.rs`：空值代理键视为显式移除宿主/用户环境继承的代理变量；非代理空值变量（如 `DSH_TUI_RESUME_SESSION=""`）不受影响。

## 3. 连通性探测命令

- **`src-tauri/src/features/system/proxy.rs`**：新增 `proxy_test_connection(proxy_url, timeout_ms)` 命令，校验协议（仅允许 `http` / `https` / `socks5` / `socks5h`）与主机端口后，执行有界超时的异步 `TcpStream::connect`，返回脱敏后的 `ProxyTestResult`（不包含任何凭据或原始 URL）。

## 4. UI 设计

- **设置页**：`src/features/settings/components/pages/ProxySettingsPage.tsx`，在 `SettingsModal` 导航中位于 `ssh-hosts` 之后、`sync` 之前（保持既有相邻 Tab 顺序契约不变），支持全局代理配置、按 CLI 类型列表展开配置与连通性测试。
- **项目弹框**：独立组件 `src/features/projects/components/ProjectProxySection.tsx` 接入 `ConfigModal.tsx`，默认收起并展示生效状态摘要，保存前校验自定义代理 URL 并对不合法输入自动展开提示。

## 5. 验证计划

- `node --test scripts/proxySettings.test.mjs scripts/settingsDialog.test.mjs scripts/settingsFocus.test.mjs scripts/settingsPresentation.test.mjs`
- `npx tsc --noEmit`
- `npm run check:architecture -- --strict`
- `cd src-tauri && cargo check && cargo test`
- `node .gitnexus/run.cjs detect-changes --scope all --repo .`
