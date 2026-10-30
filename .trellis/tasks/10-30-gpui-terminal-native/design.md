# 设计：原生终端（daemon 客户端 + GPUI 渲染）

> 上游：父 `design.md` §5；core-extraction 的 daemon 协议扩展（`ws_ack_bytes_v1`、`ws_native_client_v1`、`checkpoint_ansi_v1`、`session_status_push_v1`）；契约 `.trellis/spec/backend/pty-daemon-contracts.md`、`.trellis/spec/frontend/background-task-continuation-contracts.md`、`workspace-session-restore-contracts.md`。
> 移植源：`src/features/terminal/`（约 3.5 万行，136 文件）。

## 1. 模块划分

```
crates/pty-client/            # 无 GPUI 依赖，可独立测试
  bootstrap.rs   socket.rs   frame.rs   session.rs   ack.rs   reconnect.rs   tombstone.rs   exit.rs
crates/term-engine/           # 无 GPUI 依赖
  term.rs  input/{keys.rs, kitty.rs, mouse.rs, paste.rs}  osc/{shell_integration.rs, hyperlink.rs, clipboard.rs, colors.rs}
  compat/{pi_ansi.rs, pi_compat.rs, output_filter.rs, newline_shortcut.rs, opencode_clipboard.rs, cli_context.rs}
  reflow.rs  serialize.rs  search.rs  selection.rs  snapshot.rs
apps/desktop-gpui/src/terminal/
  model.rs (TerminalModel)  pane_tree.rs  workspan.rs  tabs.rs  tab_status.rs
  element.rs (TerminalElement)  glyph_cache.rs  view.rs  pane_view.rs  dnd.rs  ime.rs
  exit_coordinator.rs  background_tasks.rs  replay.rs  markdown_preview_entry.rs
```

## 2. pty-client（Rust 版 PtyHostSocket）

### 2.1 职责对照

| `PtyHostSocket.ts` / `TerminalProcessManager` 行为 | pty-client 实现 |
|---|---|
| bootstrap：`pty_host_get_endpoint`、`pty_prepare_create` | 直接调用 core 函数（同进程），得到 `{url, token, protocolVersion, daemonVersion}` 与 create 参数 |
| 首帧 auth，声明能力 | `client_features = [ws_ack_bytes_v1, checkpoint_ansi_v1, session_status_push_v1]`；无 Origin 头（`ws_native_client_v1`） |
| 控制请求有界超时（15 s） | `request(frame, timeout)`，`id` 关联 |
| 心跳 5 s，15 s 无 Pong 判失联 | 独立 task |
| 二进制帧解码（20 字节头） | `frame.rs`，长度/kind/version 非法 → 断开重连 |
| 重连后 attach，按“已提交给渲染器”的 sequence 过滤 replay | `SessionCursor { committed_seq }`：term-engine 解析完成后才前进 |
| replay_reset / replay / checkpoint | 交给 term-engine：reset → 清屏并按 checkpoint 重建 → 应用 replay 条目（历史 resize 只用于回放尺寸） |
| ACK：渲染器提交后才 ACK，单调前进 | `ack.rs`：按字节累计，节流（≥ 32 KiB 或 16 ms 一次） |
| create 响应丢失 → 同 id attach 探测 | `create()` 失败时执行探测，存在则视为成功 |
| close/close_all 先建 tombstone | `tombstone.rs`，重连时跳过已关闭会话 |
| 退出：列表成功 → close_all → shutdown_if_idle；列表失败 → 只关前台 → shutdown | `exit.rs`，严格遵循契约错误矩阵 |
| Pane 卸载/移动时保留未提交帧 | `SessionHandle` 与视图解耦：输出总是进入 term-engine，视图只是读取者 |

### 2.2 数据通路与背压
```
WS reader task ──Bytes(payload 切片，零拷贝)──► per-session mpsc(有界) ──► parse task（term-engine，持有 Mutex<Term>）
                                                                  └─ 解析完成：committed_seq 前进 → ack.rs 累计 → WS writer
```
- 背压由 daemon 负责（高水位 100,000 / 低水位 5,000，`ws_ack_bytes_v1` 下按字节）。客户端 mpsc 有界，满时 reader 等待（不丢帧），因为 daemon 侧已限流。
- parse task 运行在 tokio blocking-safe 的专用线程池（`spawn_blocking` 或 rayon 小池），避免大输出拖慢 IO task。

## 3. term-engine

### 3.1 Term 封装
- `TermHandle { term: Mutex<alacritty_terminal::Term<EventProxy>>, damage: AtomicBool, title, cwd, shell_state }`。
- `EventProxy` 接收 alacritty 事件：Title、Bell、ClipboardStore/Load（OSC 52，受设置控制）、PtyWrite（如 DA/DSR 响应 → 通过 pty-client 写回）、ColorRequest（`terminal_colors_v1` 语义）。
- Unicode：alacritty 的宽度计算与 xterm `unicode-graphemes` 不完全一致 → 在 M0 checkpoint 往返测试的基础上补齐差异表；必要时在 term-engine 中做字素簇合并层（emoji ZWJ、VS16）。

### 3.2 OSC 与扩展
| 功能 | 来源 | 实现 |
|---|---|---|
| OSC 133/633 shell 集成 | `infrastructure/pty/boundary.rs`（后端已有解析）+ 前端 shell 状态 | 用 `vte` 预扫描器在送入 alacritty 前截取 OSC 133/633，产出 `ShellEvent::{PromptStart, CommandStart, CommandFinished(exit)}`，供 Tab 状态 `shell` 源 |
| OSC 8 超链接 | xterm WebLinks + OSC 8 | alacritty 支持 hyperlink 单元属性；纯文本 URL 检测用正则（与 WebLinks addon 规则一致） |
| OSC 52 | 剪贴板 | 写入需用户设置允许；读取默认拒绝 |
| Kitty 键盘协议 | `3ba3d707` 修复 | alacritty 已支持 kitty keyboard flags；换行快捷键配置在 `input/newline_shortcut.rs` 中按 Kitty 模式编码 |
| 鼠标上报 | `TerminalMouseInteraction`、`470344d7` | `input/mouse.rs`：SGR/UTF8/X10，Shift 绕过上报做选区；macOS Option 选区 |
| Sixel / iTerm2 图片 | xterm addon-image | 第一版：识别 DCS/OSC 1337 后丢弃数据并在该位置画占位行“[图片]”；不进 checkpoint |

### 3.3 兼容层移植（每条附测试）
| 源文件 | 目标 | 说明 |
|---|---|---|
| `browser/TerminalPiAnsiTransform*` | `compat/pi_ansi.rs` | OMP/Pi 输出变换 |
| `browser/TerminalPiCompatibility*` | `compat/pi_compat.rs` | |
| `browser/TerminalPiIme*` | `apps/.../ime.rs` 规则部分 | |
| `browser/TerminalPiOutputFilter*` | `compat/output_filter.rs` | |
| `TerminalNewlineShortcut*` | `input/newline_shortcut.rs` | |
| `TerminalMouseInteraction*` | `input/mouse.rs` | |
| `TerminalReflowPolicy*`、`TerminalResizeDebouncer*`、`TerminalResizeRenderBarrier*` | `reflow.rs` + view 层 resize 去抖 | |
| `OpenCodeTuiClipboard*` | `compat/opencode_clipboard.rs` | |
| `TerminalCliContext*` | `compat/cli_context.rs` | |
- 移植方法：先读 TS 源与其测试（若有）→ 提取规则表 → Rust 实现 → 把 TS 测试用例翻译为 Rust 测试；无测试的规则从 git log 找对应 bug 修复提交补用例。

### 3.4 序列化（checkpoint_ansi_v1）
- `serialize_to_ansi(&Term, opts) -> Vec<u8>`：重置序列 → 备用屏标志 → 每行 SGR + 文本（宽字符占位处理）→ 滚动区 → 光标位置/可见性/形状 → 标题 → 模式（应用光标键、括号粘贴、鼠标模式、Kitty flags）。
- scrollback 包含行数受上限控制（与 xterm SerializeAddon 的 `scrollback` 参数一致）。
- 上传时机与 Tauri 版一致（读 `TerminalProcessManager` checkpoint 逻辑核实触发条件：resize、空闲、detach）。
- 往返测试 fixture 复用 M0 的 xterm headless 生成脚本，迁入 `crates/term-engine/tests/fixtures`。

## 4. 渲染：TerminalElement（P3）

- 帧循环：GPUI `request_animation_frame` 仅在 `damage` 为真或光标闪烁时请求；读取时短暂加锁复制可见区快照（`RenderableContent` → 自有 `FrameSnapshot`，含 damage 行号），释放锁后再 shaping 与绘制。
- 行 shaping 缓存：`LruCache<(row_hash, font_key), ShapedLine>`，所有 pane 共享；按行内容 + 属性哈希。
- 字形：GPUI 文字系统负责 atlas；连字开关；CJK/emoji 回退字体链从设置读取。
- 绘制层次：背景色块合并（同色连续单元合并为一个 quad）→ 文本 run → 下划线/删除线 → 选区 → 搜索高亮 → 光标 → IME 组合文本。
- 背景图：设置中的终端背景图片（`appLocalData/backgrounds/<hash>.<ext>`）以 GPUI `img` 绘制，透明度按设置。
- 隐藏 pane：继续解析，不请求帧；Background 低功耗态降帧（shell-foundation 的 LowPowerController）。
- 8 分屏 60 fps 预算：每帧 ≤ 8 ms 主线程（shaping 命中缓存时）。

## 5. 输入与 IME

- 键盘：GPUI KeyDown → 全局保留键表检查（shell-foundation）→ `input/keys.rs` 编码（含 Kitty flags、应用光标模式、Alt 前缀、Windows 下 Ctrl+C/V 规则与 Tauri 版一致：读 `useTerminalInput.ts` 核实）。
- IME：实现 `EntityInputHandler`：`marked_text_range`、`replace_and_mark_text_in_range`、`bounds_for_range`（光标单元格 → 屏幕坐标）；组合期间按键不透传；提交文本经粘贴规则（括号粘贴模式）写入。
- 粘贴：多行确认、括号粘贴、`TerminalPiCompatibility` 规则；剪贴板图片 → core `clipboard_image`（落盘并插入路径，行为与 Tauri 版一致）。
- 拖放：`ExternalPaths` → 按 shell 类型做路径转换（WSL `wsl_path`、Git Bash、SSH 远程上传规则沿用 core）。

## 6. 会话模型、分屏树、Tab

- `TerminalModel`：会话表 `HashMap<SessionId, SessionEntry { handle, meta, kind(real/pseudo), tab_status }>`、`PaneTree`、`Workspan` 列表、激活态。
- `pane_tree.rs`/`workspan.rs`/`tabs.rs`：从 `api/terminalPaneTree.ts`(430 行)、`api/terminalWorkspan.ts`(408 行)、`lib/terminalStoreLayout.ts`、`lib/terminalTabsModel.ts`、`api/terminalLayoutLock.ts` 逐函数移植为纯数据结构；TS 侧的单元测试（如有）逐条翻译。
- 视图：`Resizable` 嵌套；Tab 栏拖拽排序；5 个 drop zone（上/下/左/右/中）；锁定布局拖拽规则（`lib/lockedLayoutDrag.ts`）。
- Tab 状态：`tab_status.rs` 移植 `TAB_STATUS_PRIORITY` 合并（hook 源来自 `CoreEvent::HookNotification` 按 sessionId 绑定；shell 源来自 term-engine `ShellEvent`），含 hook running 超时回退。
- 会话持久化：工作区快照（`sessions*.json`，PrefsStore）与 `workspace-session-restore-contracts.md` 一致；每 10 s 快照保持现状（P11 暂缓）。
- Markdown 预览入口：终端内 Markdown 预览面板改为调用 rich-content-host 的 PreviewHost。

## 7. 后台任务与退出守卫

- `ExitCoordinator::request_exit(source, prechecked)` = TS 的 `requestExitGuardedByRunningTasks`：
  - 运行任务判定 `running_task_session_ids()`（真实 PTY + 合并态 running；`backgroundIncludeFinishedTasks` 扩展规则）。
  - 按 `exitWithRunningTasksBehavior` 分流 ask/background/minimize/discard；`RunningTasksExitDialog` 原生实现，含“记住选择”（先持久化再动作）。
  - background：daemon 可用 → UI 真退出（不调用 close/close_all/shutdown）；不可用 → 降级托盘常驻。
  - 无运行任务 / discard：pty-client `exit.rs` 的 close_all → shutdown_if_idle 顺序，失败矩阵严格遵循契约（shutdown 抛错则取消退出并恢复遮罩）。
  - 所有入口（关窗 exit、关闭确认、托盘退出、更新前）必须走它。
- 后台任务列表：订阅 `CoreEvent::DaemonSessionStatus`；启动/重连时 `list` 一次做全量；点击 → attach 到新 Tab（`BackgroundTaskActivateRequested` 同路径）。
- 孤儿对账：重连/attach 完成后与收到 session_status 时调用 `reconcile`（仅诊断）；兜底定时器 ≥ 60 s 且仅窗口可见时运行。
- 后台模式通知：Stop/StopFailure/attention 必发系统通知（desktop-integration 提供通知通道）。

## 8. 故障与场景

| 场景 | 预期 |
|---|---|
| daemon 不可用 | 新建终端明确失败，toast + 状态栏重试；已打开的 pane 显示“连接中断，正在重连” |
| WS 断线 | 心跳检测 → 重连 → attach → 按 committed_seq 过滤 replay；画面无重复 |
| daemon 被杀 | 会话丢失；pane 显示“会话已结束（终端服务重启）”，Tab 状态 failed；不自动重建 PTY |
| create 响应丢失 | attach 探测 |
| 跨壳 attach | 读 replay 头中的 checkpoint 格式：`ansi_v1` 或 xterm 格式都按 ANSI 重放；图片丢弃 |
| WSL / SSH / Git Bash / CMD / Pwsh | 启动参数由 core `shell_resolver`/`wsl` 决定，与 Tauri 版一致 |
| 分屏深层节点关闭 | 树折叠规则与 TS 一致 |
| 窗口最小化/托盘 | 只解析不绘制；恢复后一帧内刷新 |
| IME 组合中切 pane | 取消组合，不写入 PTY |

## 9. 不在本任务范围
文件拖放上传到 SSH 远程的 UI（沿用 core 行为即可）、终端设置页（settings-panels）、通知通道实现（desktop-integration）。
