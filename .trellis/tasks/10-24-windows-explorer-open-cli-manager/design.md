# 技术设计：资源管理器右键在此处打开 CLI-Manager

## 1. 现状与触点

已确认的现有能力：

- `src-tauri/src/lib.rs` 已注册 `tauri-plugin-single-instance`，第二实例回调可接收参数并调用 `show_main_window`。
- `src-tauri/src/lib.rs` 已有 `PendingBackgroundSession` 的“启动参数 -> 内存状态/事件 -> 前端取出”模式，可复用其生命周期思路。
- `src/features/terminal/store/terminalStore.ts` 的 `createSession` 已支持 `projectId`、`cwd`、`startupCmd`、`shell`；传入 `projectId=undefined` 且不传 `startupCmd` 即可创建普通临时终端。
- `src/features/terminal/lib/terminalLaunch.ts` 会根据设置解析默认 Shell；PTY 后端 `src-tauri/src/infrastructure/pty/manager.rs` 负责 cwd 与 Shell 的最终启动。
- `src/features/terminal/hooks/useTerminalTabsController.tsx` 已集中处理新建标签、关闭历史视图和切换终端工作区，适合作为外部打开请求的 UI 消费入口。
- `src-tauri/installer/hooks.nsh` 已是 NSIS 安装/卸载钩子入口，可在此增加 HKCU 右键菜单注册与清理。

GitNexus 当前索引与已安装 LadybugDB 版本不兼容；已尝试 `node .gitnexus/run.cjs analyze --force`，分析在解析阶段异常退出。因此本设计的发现清单以现有源码、契约和 grep 结果为准，实施前应重新建立可用索引并补做 impact 分析。

## 2. 总体数据流

```text
Explorer
  └─ HKCU shell command: CLI-Manager.exe --open-terminal <path>
       ├─ 无实例：main.rs -> lib::run/setup -> pending queue
       └─ 有实例：single-instance callback -> pending queue + event + show/focus
                                      |
                                      v
                         App/TerminalTabsController
                           -> drain pending requests
                           -> validate/normalize request
                           -> createSession(undefined, cwd, title, undefined)
                           -> set active + terminal workspace + focus window
```

核心原则是“Rust 只负责参数接收、队列和跨实例传递；前端复用既有终端创建流程”，避免复制 PTY/Shell 启动逻辑。

## 3. 启动参数契约

### 3.1 支持语法

- 必选形式：`--open-terminal <path>`。
- 建议兼容：`--open-terminal=<path>`。
- 扫描所有 argv，不依赖参数位置；忽略空字符串和未知参数。
- 每个出现的参数生成一个请求，保留 argv 顺序；不将命令行字符串再次按空格切分。
- 使用 `String`/OS 参数转换保留 Unicode、空格、盘符和 UNC 前缀。

### 3.2 Rust 请求模型

建议新增独立的轻量模块（例如 `src-tauri/src/features/app/open_terminal.rs`）：

- `parse_open_terminal_args(args: &[String]) -> Vec<String>`：纯函数，便于单测。
- `PendingOpenTerminalRequests(Mutex<VecDeque<String>>)`：不要使用单个 `Option`，防止快速触发丢请求。
- `enqueue_open_terminal_requests(app, paths)`：入队后 emit `open-terminal-requested`；事件只是低延迟通知，队列才是可靠来源。
- `take_pending_open_terminal_requests`：一次性 drain，供前端在启动完成后消费。

队列应设置合理上限（建议 32）；超限时丢弃最旧或拒绝新请求，并记录日志，避免恶意命令行造成无限增长。

### 3.3 单实例与冷启动

- `setup` 读取首实例 argv，解析并入队；不能只依赖 single-instance 回调。
- single-instance 回调读取第二实例 args，入队、emit、`show_main_window`。
- 事件监听建立后如果错过 emit，前端仍通过 `take_pending_open_terminal_requests` 补偿。
- `show_main_window` 保持现有 show/unminimize/set_focus 行为；创建成功后再调用一次聚焦，确保 PTY 标签可见。

## 4. 路径策略

### 4.1 校验边界

建议在 Rust 消费前做一次轻量校验，在前端创建前再做一次防御性检查：

- trim 外层空白，但不移除根目录所需的分隔符；`C:\` 必须保持为根路径。
- 使用 `PathBuf`/`metadata` 判断目录，避免手写反斜杠拆分；UNC 路径按原生 Windows Path 处理。
- 不强制 `canonicalize`，以免网络共享、权限或尚未准备好的路径因解析失败而无法打开；若需要去除尾部分隔符，只允许对非根路径做。
- 非目录、空路径、不可访问目录返回结构化错误码（如 `open_terminal_invalid_path`、`open_terminal_not_directory`），前端通过 i18n 映射文案。

### 4.2 文件右键策略

P0 仅注册 `Directory` 与 `Directory\\Background`，因此不会收到文件路径。若未来增加文件右键，使用独立 `--open-file` 语义并明确“打开所在目录/文件编辑器”，不要让 `--open-terminal` 隐式改变含义。

## 5. 前端消费与终端创建

建议新增 `src/features/terminal/api/externalOpenTerminal.ts`，封装：

- `listen` 事件与 `invoke(take_pending_open_terminal_requests)` 的统一消费。
- `normalizeExternalTerminalPath`、标题生成（优先最后目录名，根目录显示完整盘符/共享名）。
- `openExternalTerminalPath(path)`：
  1. 忽略重复消费标记；
  2. 调用 `useTerminalStore.getState().createSession(undefined, path, title, undefined)`；
  3. 调用 `useHistoryStore.getState().closeHistory()`，切到 terminal workspace；
  4. 使用返回的 session id 设为 active；
  5. `focusMainWindow`，失败只记录日志并保留已创建会话。

消费入口放在 `useTerminalTabsController`，因为它拥有 `setActiveWorkspaceTab`、`closeHistory` 和当前 UI 视图上下文。App 只负责保证 startup ready 后允许消费，不在 `App.tsx` 复制终端创建逻辑。

启动阶段建议使用状态门控：

```text
queued -> app initialized -> (restore prompt resolved, if any) -> draining -> opened/failed
```

如果用户选择恢复旧会话，外部请求在恢复完成后处理；如果恢复被禁用或无可恢复会话，则基础初始化完成后立即处理。

## 6. Windows Explorer 注册

### 6.1 注册表项

在 NSIS post-install 中写入当前用户键：

- `HKCU\\Software\\Classes\\Directory\\shell\\CLIManager`：写入 `MUIVerb` 和 `Icon`。
- `HKCU\\Software\\Classes\\Directory\\shell\\CLIManager\\command`：`"$INSTDIR\\CLI-Manager.exe" --open-terminal "%1"`。
- `HKCU\\Software\\Classes\\Directory\\Background\\shell\\CLIManager`：写入 `MUIVerb` 和 `Icon`。
- `HKCU\\Software\\Classes\\Directory\\Background\\shell\\CLIManager\\command`：`"$INSTDIR\\CLI-Manager.exe" --open-terminal "%V"`。

不设置 `Extended`，使其默认显示在常规菜单（Windows 11 可能仍归入“显示更多选项”，这是系统行为）。

### 6.2 安装/卸载与升级

- 安装、升级后都重写命令路径，避免安装目录变化后注册表指向旧 exe。
- 卸载只删除上述固定键，不执行宽泛的 `HKCU\\Software\\Classes\\Directory\\shell` 清理。
- 使用 HKCU 避免管理员权限和多用户污染；未来可加设置项控制注册/注销并提供“修复右键菜单”。
- NSIS 宏应与现有停止进程钩子保持独立，注册失败写日志但不阻断主程序安装。

## 7. 错误、可观测性与安全

- 日志记录请求来源（cold-start/second-instance）、规范化路径、队列长度、创建结果；不记录命令行中除路径外的敏感参数。
- Explorer 传入路径只作为 `cwd`，不能拼接到 Shell 命令字符串，避免命令注入。
- 事件 payload 仅传单个路径字符串；可靠队列通过受控 IPC drain，避免前端重复消费。
- 路径校验失败不得创建项目、PTY 或持久化残留。

## 8. 扩展路线（不进入 P0）

1. **可配置右键菜单**：放在 `GeneralSettingsPage` 的“系统集成 / Windows 资源管理器”区块，提供启用/禁用、修复注册和当前注册状态；不单独新增设置页。
2. **文件右键**：`--open-file`，可选“打开所在目录”或文件编辑器。
3. **动作子菜单**：在目录下启动默认 Shell、PowerShell、CMD、WSL，或直接执行用户选择的模板/CLI（必须有明确的安全确认和 quoting 规则）。
4. **项目识别但不强制创建**：检测目录是否匹配已有项目/Worktree，仅复用项目配置，不自动落库。
5. **多目录批量打开**：Explorer 多选通过多个 argv 传入，支持“一个 Workspan 多标签”或“每目录独立 Workspan”策略。
6. **现代 Windows 11 菜单**：评估 `IExplorerCommand`/COM shell extension；仅在传统 NSIS 注册满足需求后再投入。

## 9. 关键取舍

| 方案 | 选择 | 原因 |
|---|---|---|
| 单路径 Option vs 请求队列 | 队列 | 支持连续触发并避免启动竞态丢请求 |
| 前端新写 PTY 逻辑 vs 复用 `createSession` | 复用 | 保持 Shell、监控、持久化和错误处理一致 |
| HKLM vs HKCU | HKCU | 无管理员权限、符合桌面用户预期、影响范围可控 |
| canonicalize vs metadata | metadata + 原路径 | 支持 UNC/权限边界，避免无谓路径解析失败 |
| 自动创建项目 vs 临时会话 | 临时会话 | 满足 issue 语义，降低数据库与生命周期耦合 |

## 10. macOS/Linux 兼容策略

### macOS

- `--open-terminal <path>` 作为跨平台应用协议保留；通过 Finder/终端执行 `open -a "CLI-Manager" --args --open-terminal "/path"` 时，仍走同一套单实例队列和前端终端创建逻辑。
- 不在本期伪造 Windows 注册表式入口。后续可提供签名的 Finder Quick Action/Service（接收选中的文件夹路径），安装到用户 `~/Library/Services`；该机制天然覆盖“选中目录”，但不能可靠覆盖 Finder 空白处右键。
- 若未来要求 Finder 空白处右键，需要评估 Finder Sync Extension 或独立 Finder 插件，属于新的 macOS target、签名和发布工作，不纳入 V1.4.5。
- macOS 默认 Shell 继续由现有 `defaultShellForOs`/设置决定（通常为 zsh）；不注入 Claude/Codex 启动命令。

### Linux

- 保留同一 CLI 参数和单实例行为，允许桌面环境或脚本通过 `CLI-Manager --open-terminal <path>` 调用。
- 文件管理器右键入口不作为 V1.4.5 的稳定承诺，因为 Nautilus、Dolphin、Thunar 等扩展机制不同；后续可分别提供 `.desktop` action 或文件管理器脚本。

### 兼容边界

- 参数解析、请求队列、前端会话创建和错误模型必须平台无关。
- Explorer/NSIS、Finder Quick Action、Linux `.desktop` 仅作为平台适配层，不能渗透到终端创建核心。
- 设计验收时至少验证：macOS 通过 `open -a ... --args` 的冷启动/已运行实例，以及 Linux 直接 CLI 调用不崩溃；完整右键菜单验收仍以 Windows 为准。
