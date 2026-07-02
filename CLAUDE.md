# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目简介

CLI-Manager 是基于 **Tauri 2** 的 Windows 桌面应用：前端 React 19 + TypeScript 负责 UI 与状态，Rust 后端负责 PTY 会话、Shell 解析、Git 操作、历史解析、WebDAV 同步与 CLI Hook 桥接。前端通过 `invoke()` 调用后端命令，后端通过事件向前端推送数据。

## 常用命令

```bash
npm install                  # 安装前端依赖
npm run tauri dev            # 启动桌面应用（开发，启动 Rust + 前端）
npm run dev                  # 仅启动前端 Vite（见下方说明，会复用已存在的 dev server）
npm run tauri build          # 构建发行版

npx tsc --noEmit             # 前端类型检查（build 前置，等价于 npm run build 的 tsc 阶段）
npm run build                # tsc && vite build（仅前端产物）

cd src-tauri && cargo check  # Rust 编译检查
cd src-tauri && cargo test   # Rust 全部测试
cd src-tauri && cargo test <test_name>   # 运行单个 Rust 测试
```

- 前端无 ESLint/Prettier 与前端测试框架，**类型检查（`tsc --noEmit`）是前端唯一的静态校验**。改完前端务必跑它。
- `npm run dev` 走的是 `scripts/dev-server.mjs`：它会探测 `localhost:1420`，若已有 CLI-Manager 的 Vite server 则复用而非重启，端口被非本应用占用时直接报错退出。
- 调试日志：设置环境变量 `CLI_MANAGER_DEBUG=1`（或 `true/yes/on`）开启 Rust Debug 级日志并输出到 Webview/Stdout；日志文件名 `cli-manager.log`，位于 Tauri LogDir。

## 架构要点

### IPC 边界
- 所有后端命令在 `src-tauri/src/lib.rs` 的 `invoke_handler![]` 集中注册——**新增命令必须在此登记，否则前端 invoke 会失败**。命令实现分散在 `src-tauri/src/commands/*.rs`（terminal/fs/shell/history/sync/version/background/hook_settings/ccusage/ccswitch/git/model_pricing/logging）。
- 后端 → 前端走事件：PTY 输出 `pty-output-{sessionId}`；CLI Hook 通知 `claude-hook-notification`；托盘退出 `tray-quit-requested`。

### 终端与 PTY
- `src-tauri/src/pty/`（`manager.rs` 会话生命周期、`boundary.rs` 命令边界/Shell 集成 OSC 解析）维护 PTY 会话；`shell_resolver.rs` + `wsl.rs` 决定如何启动 PowerShell/CMD/Pwsh/WSL/Bash。
- 前端 `stores/terminalStore.ts` 是终端核心：管理会话列表、激活态，并通过 `stores/terminalPaneTree.ts` 维护**分屏的树形结构**（水平/垂直分屏、拖拽 reorder/split 都在这棵树上操作）。
- **Tab 状态有双数据源**：CLI Hook（`hook`）与 Shell 集成 OSC 序列（`shell`），二者按 `TAB_STATUS_PRIORITY` 合并出最终的 Tab 通知态（none/running/attention/done/failed）。改动状态逻辑时要同时考虑两个来源。

### CLI Hook 桥接（Claude / Codex）
- `src-tauri/src/claude_hook.rs` 在启动时绑定 `127.0.0.1` 随机端口起一个 TCP server，用一次性 token 校验，接收 Claude/Codex 的 hook 上报（SessionStart/UserPromptSubmit/Notification/Stop/StopFailure/PermissionRequest），转成 `claude-hook-notification` 事件发给前端。
- `hook_settings.rs` 负责把 hook 配置安装/卸载进 Claude/Codex 的配置目录；`hook_client.rs` 是上报端。
- 前端在 `App.tsx` 监听该事件：`SessionStart`/`UserPromptSubmit` 仅用于绑定 sessionId 不弹 toast，其余事件弹通知。实时统计（CcusageStatsPanel）依赖 hook 上报的 sessionId，未安装 hook 时会引导去设置。

### 数据层
- SQLite 通过 `tauri-plugin-sql`，**migrations 定义在 `lib.rs` 的 `migrations()`，当前到 v11**。新增表/列必须追加新的 `Migration`（只增不改，向后兼容），不要修改历史 migration。
- 前端用 `Database.load("sqlite:cli-manager.db")` 直接读写 SQLite（见 `src/lib/`）。表：`projects`、`groups`、`command_templates`、`command_history`、`session_meta`、`sync_meta`、`ccusage_cache`、`model_prices`。
- 用户偏好（设置/主题/快捷键/同步配置等）走 `tauri-plugin-store`，由 `stores/settingsStore.ts` 管理，与 SQLite 分离。

### 前端状态（Zustand，`src/stores/`）
每个领域一个 store：`settingsStore`(偏好/主题/字体)、`projectStore`(项目树)、`terminalStore`+`terminalPaneTree`(终端/分屏)、`sessionStore`(会话持久化)、`historyStore`(历史会话浏览)、`syncStore`(WebDAV)、`templateStore`(命令模板三级作用域)、`commandHistoryStore`、`gitStore`、`ccusageStore`、`modelPricingStore`、`updateStore`。Store 之间通过 `useXxxStore.getState()` 直接互调（如 terminalStore 读 settings/session）。

### 启动时序（`App.tsx` 的 `init()`）
1. 先 `loadSettings()`；2. 并行 load sync + session，预热 model pricing；3. `projectStore.fetchAll()`；4. **`sessionStore.clear()`——启动时刻意不恢复历史终端**，避免重建 PTY 并重跑 startupCmd；5. 首屏渲染后再跑延迟任务（自动同步、检查更新）。
- 窗口关闭行为由 `closeBehavior` 设置控制：最小化到托盘 / 直接退出 / 弹窗询问，逻辑在 `App.tsx` 的 `onCloseRequested` 与托盘菜单中。

### 同步
- `src-tauri/src/sync/` + `src-tauri/src/webdav/`：WebDAV 远端存储 + 冲突处理。自动同步在启动与关闭时触发，冲突时不静默覆盖，提示用户手动处理。

## 约定

- `src-tauri/capabilities/default.json` 控制 Tauri 权限/asset 协议 scope（终端背景图等资源访问受其严格限制）。新增需要文件/资源访问的能力时要同步更新 capability。
- 终端背景图片复制到 `appLocalData/backgrounds/<hash>.<ext>`，asset scope 锁定该目录。

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **CLI-Manager** (9826 symbols, 19133 relationships, 300 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/CLI-Manager/context` | Codebase overview, check index freshness |
| `gitnexus://repo/CLI-Manager/clusters` | All functional areas |
| `gitnexus://repo/CLI-Manager/processes` | All execution flows |
| `gitnexus://repo/CLI-Manager/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
