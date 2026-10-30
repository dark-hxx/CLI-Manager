# 前端功能清单与迁移分级（2026-10-30）

规模：`src/` 约 15.9 万行 TS/TSX；`invoke()` 557 处，约 385 个不同命令；`@tauri-apps/api/event` 18 处导入。

> 2026-10-30 决策更新：只有“预览”（Markdown 文件预览 / HTML / PDF）使用按需 WebView；下表中标 C 的 Markdown 阅读（转录、提示词、About）与所有 Monaco 编辑点改为原生实现。“单进程”解释为界面单进程：GPUI 版仍作为 PTY daemon 的客户端（见父 design §0.1），本文 §2 的结论继续有效。

分级：**A** 普通表单/列表（原生直接实现）；**B** 需自研原生控件；**C** 富文档渲染（按需系统 WebView，缺失时降级）。

## 1. 功能表

| 目录 | 行数(文件) | 关键文件 | 用户功能 | 重 Web 依赖 | 分级 |
|---|---|---|---|---|---|
| `src/app` | 2,260 (5) | `App.tsx`、`WindowTitleBar.tsx`、`ExitProgressOverlay` | 根壳：自绘标题栏、启动时序、通知、托盘退出 | plugin-notification、window API | A |
| `features/terminal` | 34,667 (136) | `useXTermController.ts`、`terminalStore.ts`、`terminalRuntime.ts`、`useTerminalInput.ts`、`transport/PtyHostSocket.ts`、`api/terminalPaneTree.ts`、`api/terminalWorkspan.ts`、`browser/*`（Pi/OMP 兼容、IME、鼠标、换行快捷键、Resize 屏障） | 多 Tab/分屏 PTY、回放、后台任务、IME、拖放文件、Web 设备桥 | xterm 6.1 beta + 8 addon、dnd-kit | **B**（Markdown 预览为 C） |
| `features/settings` | 30,059 (98) | Hook/Theme/Statusline/SSH/DesktopPet/Provider 设置页、`updateStore.ts` | 全部设置页 | mantine(58)、dnd-kit、qrcode.react、Monaco(`NativeProviderCodeEditor`) | A（排序列表/主题编辑 B-lite；JSON 编辑器 C） |
| `features/history` | 15,223 (48) | `historyStore.ts`（直连 SQL）、`HistoryWorkspace`、`SessionDetailPane`、`HistoryListPane` | 历史会话浏览/搜索/收藏/转录阅读 | react-virtual、recharts、diff、MarkdownContent | B；转录渲染 **C** |
| `features/projects` | 13,436 (62) | `useSidebarController.tsx`、`ProjectTree`、`ConfigModal`、`worktreeStore`、`conflicts/ConflictMonacoEditor` | 项目/分组树、Worktree、冲突解决 | dnd-kit、react-virtual、Monaco、emoji 数据 | B；冲突编辑器 C |
| `features/git` | 11,751 (58) | `GitWorkspace`、`GitChangesPanel`、`gitStore`、`components/diff/*`、`MonacoDiffFallback`、`lib/gitTransport.ts`(48 invoke) | Git 状态/暂存/提交/引用/Hunk 级 Diff | react-diff-view、refractor、react-virtual | **B**（原生 Diff + tree-sitter 高亮） |
| `features/stats` | 9,222 (23) | `CcusageStatsPanel`、`StatsPanel`、`EChart.tsx`、`TimelineHeatmap`、`statsScreenshot.ts` | 用量/成本/Token 仪表盘、请求日志、截图导出 | echarts、recharts、html-to-image | **B**（自绘图表；可选 C） |
| `features/files` | 5,574 (24) | `FileExplorerSidebar`、`fileExplorerStore`、`FileEditorContent`、`liveServerClient` | 文件树、编辑器、Markdown/HTML 预览 | Monaco、MarkdownContent | 树 B；编辑/预览 **C** |
| `features/extensions` | 3,815 (31) | MCP/Skills 面板、`McpEditorDialog`(Monaco) | MCP 与 Skills 管理 | mantine、dnd-kit、Monaco | A；JSON 编辑 C |
| `features/desktop-pet` | 3,355 (11) | `DesktopPetApp.tsx`、`useDesktopPetCoordinator.ts` | 透明置顶桌宠窗口 | window/emitTo API | B（透明浮窗 + 精灵动画） |
| `features/remote` | 2,179 (12) | `sshHostStore.ts`（plugin-sql） | SSH 主机、远程文件/Git | — | A |
| `features/workspace` | 1,253 (9) | `CommandPalette`、`useKeyboardShortcuts`、`WorkspanTabBar` | 命令面板、快捷键、Workspan | dnd-kit、radix | A（GPUI Action/Keymap 原生支持） |
| `features/prompts` | 1,093 (3) | `templateStore.ts`（直连 SQL） | 提示词/命令模板 | MarkdownContent | A（预览 C） |
| `features/providers` | 944 (3) | `ProviderSwitchModal` | Provider 快速切换 | lobehub 图标 | A |
| `features/sync` | 928 (2) | `syncStore.ts` | WebDAV 同步 | — | A |
| `features/agents` | 500 (3) | `agentCapabilities.ts` | Agent 能力探测 | — | A |
| `shared/ui` | 2,138 (24) | `MarkdownContent.tsx`、select/dialog/context-menu | 设计系统原语 + Markdown 渲染 | radix、mantine、@lobehub/icons(28)、react-markdown、remark-gfm/math、katex、react-syntax-highlighter | 原语 A；**Markdown C** |
| `shared/i18n` | 10,234 | 中英字典 + opencc-js | 多语言、简繁转换 | opencc-js | A（Rust 侧用 `zhconv`/opencc 绑定 [待选型]） |
| `shared/preferences/settingsStore.ts` | 1,942 | plugin-store | 用户偏好 | — | A（需兼容既有 store JSON） |

## 2. 终端细节（迁移重灾区）

- xterm addon：Fit、Search、Serialize、WebLinks、Image（Sixel/iTerm）、WebGL、Unicode11、UnicodeGraphemes。
- 分屏/拖拽：`api/terminalPaneTree.ts`、`api/terminalWorkspan.ts`、`SplitTerminalView`、`PaneLeafView`、`PaneTabBar`、`PaneContentDropZones`、`SortableTerminalTabs`、`lib/lockedLayoutDrag.ts`、`api/terminalLayoutLock.ts`。
- 传输：`PtyHostSocket.ts` 通过 `ws://127.0.0.1:*/pty` 直连独立 PTY daemon（见 `.trellis/spec/backend/pty-daemon-contracts.md`）。**GPUI 壳必须继续作为 daemon 客户端**（保留会话跨 UI 存活、回放、背压），不能改成进程内 PTY。
- ACK 计数单位是 UTF-16 code unit（与 xterm 对齐）→ Rust 客户端需按协议计算或协议升级为字节计数（协议版本号 +1，双端兼容）。
- 其他 Web 专属：`onDragDropEvent` 文件拖放、`lib/terminalIme.ts`、`lib/terminalClipboardImage.ts`、`browser/TerminalPi*`（OMP/Pi 兼容层）。
- 许可证：**不得使用 Zed 的 `terminal`/`terminal_view`（GPL）**；以 `alacritty_terminal`（Apache-2.0）为 VT 内核自研 GPUI 渲染元素。

## 3. Tauri 插件 JS 用法（需在 Rust 侧找到等价物）

| 插件 | 典型位置 | GPUI 替代 |
|---|---|---|
| plugin-sql | `shared/platform/db.ts`、`remote/api/sshHostStore.ts` | 统一 Rust 仓储层（sqlx） |
| plugin-store | settings/session/sync/historySource/externalSessionSync/ExtensionSortableList | 读写同一 store JSON 文件（兼容格式） |
| plugin-dialog（17 文件） | 设置页、项目配置、导入 | `rfd` 原生文件对话框 |
| plugin-opener（10 文件） | 链接、Live Server、关于页 | `open`/`opener` crate |
| plugin-clipboard-manager | systemClipboard、终端粘贴、统计截图 | GPUI 剪贴板 + `arboard`（图片） |
| plugin-process / updater | updateStore、开发者页 | 自研更新器（复用 minisign 校验） |
| plugin-notification | App.tsx | `notify-rust`（已在依赖中） |
| plugin-log | logger | `log` + 现有文件日志 |

## 4. 前端直连 SQLite 的表

`projects`、`groups`、`worktrees`、`command_history`、`command_templates`、`ssh_hosts`、`ssh_host_groups`、`ssh_host_tool_preferences`、`ssh_agent_installations`、`ssh_agent_tool_integrations`、`session_meta`、`session_favorite_snapshots`、`message_stars`、`history_generated_titles`、`history_edit_audit`、`ai_replay_sessions`、`ai_replay_events`、`model_prices`、`ccusage_cache`、`sync_meta`。
连接参数：WAL + `synchronous=NORMAL`，加载前调用 `db_repair_known_migration_drift`。

## 5. 前端监听的事件

`tray-quit-requested`、`claude-hook-notification`、`subagent-transcript-append`、`system-notification-action`、`background-task-activate-requested`、`ssh-agent-hook-gap`、`project-files-changed`、`git-changed`、`history-index-status`、`open-terminal-requested`、`web-device-status-changed`、`web-device-operation-ready`、`web-server-status-changed`、`desktop-pet-*`（7 个）。另有经变量订阅的 PTY 状态事件，需在迁移时逐文件核对。

## 6. 多窗口

`tauri.conf.json` 静态声明 `main`（无边框 1200×800）与 `desktop-pet`（190×210 透明置顶、跳过任务栏）。`src/main.tsx` 按 label 分发。GPUI 对应两次 `cx.open_window`；透明/点击穿透需逐平台 PoC。

## 7. 结论

- **C（按需 WebView）**：`MarkdownContent`（GFM+KaTeX+Prism）及其所有使用方；所有 Monaco 使用点（文件编辑、MCP JSON、冲突编辑、Provider 代码编辑、Monaco Diff 回落）；HTML 预览。
- **B（自研原生控件）**：终端网格、分屏树与拖拽 Tab、虚拟列表、Hunk Diff、图表、桌宠。
- **A（直接原生）**：设置（主体 3 万行）、remote、sync、prompts、providers、workspace、agents。
- 资源替换：@lobehub/icons（28 个 Provider 图标导出 SVG）、lucide（116 处，改用 SVG 资产）、opencc-js、qrcode.react（→ `qrcode` crate）、html-to-image（→ GPUI 离屏渲染或省略）。
