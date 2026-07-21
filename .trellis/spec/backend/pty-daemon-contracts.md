# PTY Daemon Contracts (Phase 2: 守护进程)

> Issue #123 Phase 2。把 PTY 宿主从主进程抽为独立守护进程 `cli-manager-daemon`：UI 是客户端，应用真退出后任务继续跑，重启 attach 回放。前置 Phase 1（`background-task-continuation-contracts.md`）已上线。**本契约经用户确认后方可实施。**

## Scenario: VS Code-style PtyHost Direct Transport (Current Contract)

> 本节覆盖并取代下文旧的“进程内 PTY fallback / Tauri output re-emit / raw ring buffer”条款；旧段落仅保留历史背景。

### 1. Scope / Trigger

- Trigger: 修改 `TerminalProcessManager`、`PtyHostSocket`、daemon protocol/server、Replay、flow control 或 `pty/platform/*`。
- 数据流：xterm write callback → ACK → WebSocket → daemon flow control；daemon platform PTY → 5ms buffer → sequence frame → WebSocket binary → xterm。

### 2. Signatures

- Bootstrap commands: `pty_host_get_endpoint() -> Option<{ url, token, protocolVersion, daemonVersion }>`；`pty_prepare_create(...) -> { sessionId, cwd, envVars, shell }` 仅负责 provider/hook 环境准备，不创建进程。
- Discovery: `{ port, wsPort, hookPort, token, pid, version }`。
- Control frames: JSON `auth/ping/list/create/write/ack/resize/close/close_all/attach/detach/reconcile/status`。
- Binary frame header: `version:u8, kind:u8, sessionLen:u16, sequence:u64, cols:u16, rows:u16, dataLen:u32`（big-endian），后接 UTF-8 session id 与原始 PTY bytes。
- `ack`: `{ session_id, sequence, char_count }`；`char_count` 使用 UTF-16 code units，与 xterm/JavaScript string length 一致。

### 3. Contracts

- WebSocket 仅绑定 `127.0.0.1`，路径固定 `/pty`；Origin 仅允许 Tauri localhost 与本地 dev origin；首帧 token 鉴权。
- Output/replay 必须使用 binary frame；Tauri command 仅用于 endpoint bootstrap 和 provider/hook 环境准备，真正的 create/write/resize/close 由同一 WebSocket 客户端执行。
- daemon 输出最多合并 5ms；客户端未确认字符达到 `100000` 后暂停 PTY reader，直到降到 `5000` 以下；ACK 只能前进，重复/倒序 ACK 不得重复扣减。
- daemon 每个客户端使用独立 writer queue；`clients` 全局锁内只更新订阅/ACK 状态和入队，禁止执行 TCP/WebSocket IO，慢客户端只能通过自身未确认字符触发该会话背压。
- Replay entry 为 `{ cols, rows, sequence, data }`；output 与 resize 共用严格递增的事件 sequence，连续空 resize 合并。Attach 在同一锁序内取得 replay 并注册订阅，订阅注册后到 attached control 入队前产生的 live 帧进入 attach barrier，发送顺序严格为 replay binary → attached control → live binary。
- 活跃会话的完整 Replay 不得在 2 MiB 后静默裁剪：内存保留最近 2 MiB 安全帧，更早的整帧写入 daemon 专属磁盘 spool；关闭会话时删除对应 spool，daemon 新实例启动时清理同环境旧 spool。磁盘写入失败时保留内存数据并告警，不得丢帧。
- 隐藏终端仍订阅并解析输出；不得建立 inactive raw buffer 或切回时批量重放。可释放 WebGL，但不得释放 xterm、PTY 订阅或 scrollback。
- Windows 使用直接 ConPTY API；兼容开关开启时通过受控绝对路径加载打包的 `conpty.dll`，否则使用 kernel32 API，禁止按裸 DLL 名搜索。ConPTY 子进程创建标志不得包含 `CREATE_NEW_PROCESS_GROUP`，并保留 `PSEUDOCONSOLE_RESIZE_QUIRK | PSEUDOCONSOLE_WIN32_INPUT_MODE`。Unix 使用 `openpty`、`setsid`、`TIOCSCTTY`、stdio dup 与进程组 kill；PTY fd 必须设置 `FD_CLOEXEC`，子进程 exec 前必须恢复默认信号处理并清空继承的信号掩码。生产依赖不得重新加入 `portable-pty`。
- Windows 每次创建新 PTY 前必须通过当前用户 token 的 `CreateEnvironmentBlock` 刷新系统/用户环境。普通变量按 daemon 进程环境 → 最新用户环境 → 显式 launch env 合并；`PATH` 特殊处理为“最新用户路径在前，再补 daemon `PATH` 独有项”，路径项按 Windows 大小写不敏感去重。项目/provider/hook 显式传入的 `PATH` 仍整值覆盖最终结果。刷新失败只能回退 daemon 环境并记录 warning，不能阻止终端创建。
- WebSocket auth 与控制请求必须有有界超时；心跳 5 秒一次，15 秒无 Pong 判定失联。重连后重新 attach，并按 xterm 已提交 sequence 过滤 replay，而不是按网络已接收 sequence 过滤。
- `create` 请求的响应若因断线丢失，前端必须以同一 session id 重连并 attach 探测：会话存在则恢复 replay 并视为创建成功，不存在才向调用方返回原始创建错误。create 的 session 检查、容量检查和预留插入必须原子。
- `close`/`close_all` 在发送请求前建立本地 tombstone 并释放输出所有权；即使请求超时或断线，也不得在重连时重新 attach 已由 UI 关闭的会话。daemon 关闭路径必须同步移除 attach、ACK、sequence 与 attach-barrier 状态。
- `pty_reconcile_active_sessions` 的 UI active list 只用于诊断，不得关闭 daemon 后台会话；后台会话只由显式 close/close_all、PTY 退出治理或确定的 daemon 孤儿清理终止。
- `pty_daemon_sessions` 必须区分“daemon 可用且会话为空”和“daemon 不可用/查询失败”：前者返回 `Ok([])`，后者返回 `Err`。启动恢复、后台任务列表等调用者可 catch 后降级为空；退出守卫只能在真实取得列表后认为 daemon 会话已检查。
- 真正退出且 daemon 列表检查成功时，前端必须先 `close_all` 再请求 `pty_daemon_shutdown_if_idle`；列表检查失败时只能关闭当前前台 PTY，再请求 shutdown 作为最终存活性判定。shutdown 返回 `false` 表示无 daemon，可继续退出；shutdown 抛错表示仍有活动会话或控制链路不可信，必须取消 `app_exit` 并恢复退出遮罩。`close_all` 抛错后仍要尝试 shutdown：shutdown 成功表示 daemon 已确认无 alive 会话。转入后台路径禁止调用 close/close_all/shutdown。

### 4. Validation & Error Matrix

- endpoint 缺失 / protocolVersion 不匹配 → create 失败并清理已创建会话，不回退进程内 PTY。
- Windows 用户环境读取失败 → warning + 使用 daemon 环境；显式 launch env 仍覆盖回退结果。
- daemon 会话列表不可用 → `pty_daemon_sessions` 返回错误；退出守卫不得把它当作空列表并直接 `close_all`。
- `close_all` 请求失败但 shutdown 成功 → 允许退出；shutdown 失败 → 保持应用运行，不得在 `finally` 中无条件 `app_exit`。
- 非 loopback / Origin 非白名单 / token 错误 → 握手或 auth 拒绝。
- binary header 长度、kind、version 或 payload 长度非法 → 客户端断开并触发重连。
- ACK sequence 重复、倒序或大于 last sent → 忽略，不改变未确认字符数。
- WebSocket 中断 → daemon 保留会话和 Replay；前端心跳重连、attach、sequence 去重。
- XTerm/Pane 卸载或移动 → `TerminalProcessManager` 保留已接收但尚未由 xterm write callback 提交的帧；新 Display 接管并重写，旧 Display 的迟到 callback 无权 ACK。
- Replay 中的历史 resize → 仅恢复 xterm 回放尺寸，不向 live PTY 转发；回放结束后强制按当前容器重新 fit。
- Unix 交叉检查缺少 GTK/sysroot → 报告环境阻塞，不得把它描述为 Unix 编译通过。

### 5. Good/Base/Bad Cases

- Good: 100 MiB 连续输出逐帧 ACK，hash 一致，无丢失/重复；慢 WebView 触发 daemon 背压而不是裁剪。
- Good: daemon 启动后用户安装新 CLI，新 PTY 的 `PATH` 立即包含新用户路径，同时保留 daemon 临时工具目录；项目显式 `PATH` 仍完全接管。
- Good: 无任务真实退出执行 close_all + shutdown；shutdown 确认后才调用 app_exit，后台继续模式完全不触碰 PTY/daemon。
- Base: 新会话由 Tauri command 生成 session id 并完成 provider/hook env，随后 WebSocket create 在启动 PTY 前注册当前客户端；create/write/resize/output/close 全部直连 PtyHost。
- Base: daemon 不存在时 `pty_daemon_sessions` 报不可用，shutdown 返回 false，前端可正常退出。
- Bad: 收到 binary output 后立刻 ACK，而不是等 `terminal.write(..., callback)` → xterm 尚未解析时 daemon 继续灌入，内存失控。
- Bad: WebSocket 重连后无 sequence 过滤地重放完整 ring → 用户看到重复输出。
- Bad: 最新用户 `PATH` 整值覆盖 daemon `PATH` → 应用启动时注入的临时工具目录丢失。
- Bad: 在退出清理 `finally` 中无条件 app_exit → daemon 拒绝 shutdown 时仍强退，残留后台进程且丢失诊断机会。

### 6. Tests Required

- Rust: binary header、协议未知字段/type、Attach barrier 顺序、尺寸化 Replay/resize 独立 sequence、spool 不丢帧、writer queue、后台 reconcile、direct ConPTY spawn/write/read/resize；断言 ConPTY 子进程不使用 `CREATE_NEW_PROCESS_GROUP` 且保留 resize/Win32 input flags；环境合并测试覆盖键大小写、fresh `PATH` 优先、daemon 独有路径补回、显式 `PATH` 整值覆盖。
- Frontend: `npx tsc --noEmit`；Node 回归验证 auth/request timeout、close tombstone、未提交帧重挂接管、ACK 顺序、隐藏 Tab 持续更新；退出编排测试覆盖 close_all + shutdown、后台不清理、daemon 查询失败只关前台、shutdown 失败禁止退出、close_all 失败但 shutdown 成功。
- Backend: `cargo check && cargo test`。Unix 必须在真实 macOS/Linux CI 或具备 GTK/sysroot 的构建机执行；Windows 交叉编译缺少 GTK sysroot 不算代码失败，也不算通过。
- 手动矩阵：PowerShell/pwsh/CMD/Git Bash/WSL、Bash/Zsh/Fish；普通 Tab/分屏/Pane 全屏/应用全屏/Workspan；最小化/托盘/退出后 daemon 续跑；hook 装/未装。

### 7. Wrong vs Correct

#### Wrong

```ts
socket.onmessage = (frame) => {
  terminal.write(frame.data);
  acknowledge(frame.sequence, frame.data.length);
};
```

#### Correct

```ts
terminal.write(frame.data, () => {
  acknowledge(frame.sequence, frame.rawUtf16Length);
});
```

#### Wrong

```typescript
try {
  await closeAll();
  await shutdownDaemonIfIdle();
} finally {
  await exitApp();
}
```

#### Correct

```typescript
const cleanup = await cleanupTerminalProcessesForExit(...);
if (cleanup.canExit) await exitApp();
```

## Scenario: Host PTY Sessions in a Detached Daemon Process

### 1. Scope / Trigger

- Trigger: 改动 `pty/manager.rs`、`commands/terminal.rs` 的 7 个 PTY 命令、`pty-output-{sessionId}`/状态事件链路、daemon 发现/鉴权、attach 回放、hook 上报转发时。
- 跨层：前端 `terminalStore`（attach-first 恢复与后台任务状态接入）→ Tauri 命令（改为转发）→ DaemonClient ↔ loopback TCP ↔ `cli-manager-daemon`（PtyManager + ring buffer + hook 转发/状态缓存）。

### 2. Signatures

- 新二进制：`cli-manager-daemon`（workspace 新 crate `daemon/`，复用 `pty::manager`/`pty::boundary`/`shell_resolver`/`wsl` —— 这些模块随之与 `AppHandle` 解耦，输出改为回调/trait `PtyOutputSink`）。
- 发现文件：`~/.cli-manager/daemon.json`（dev 构建 `daemon.dev.json`，隔离规则对齐 sessions 文件）：`{ "port": u16, "hookPort": u16, "token": String, "pid": u32, "version": String }`。daemon 启动时原子写入，退出时删除。
- 传输：`127.0.0.1` TCP，换行分隔 JSON 帧（NDJSON）。首帧必须 `{"type":"auth","token":...,"clientVersion":...}`，失败即断连。
- 请求：`create/write/resize/close/close_all/reconcile/status/list/attach/detach`（与现有 7 命令一一对应 + attach 语义）。推送：`{"type":"output","sessionId","data"(base64)}`、`{"type":"exit","sessionId","status"}`、attach 应答含 `{"sessionId","replay"(base64), "meta"}`。`SessionMeta` 额外包含 `taskStatus` / `taskUpdatedAtMs`，用于区分 CLI 任务状态与 PTY/shell 存活状态。
- 主应用侧：`DaemonClient`（managed state）。`commands/terminal.rs` 各命令签名与注册名**不变**，实现改为：daemon 可用 → 转发；不可用 → 现有进程内 `PtyManager`（保留为 fallback，代码不删）。
- Hook 转发：daemon 常驻一个稳定 hook 转发端口；PTY 环境变量 `CLI_MANAGER_NOTIFY_PORT/TOKEN` 指向 **daemon**，daemon 把 hook 上报转发给当前连接的 app 客户端；无客户端时缓存最近 N 条（默认 200），attach 时补发。daemon 同时从 hook 事件维护 `taskStatus`：`UserPromptSubmit`→`running`，`Notification`/`PermissionRequest`→`attention`，`Stop`→`done`，`StopFailure`→`failed`。

### 3. Contracts

- **★前端零感知**：`pty-output-{sessionId}`、状态事件、7 个 invoke 命令的名称/参数/返回值语义不变。DaemonClient 收到 output 帧后由主进程原样 re-emit。`safe_emit_boundary`（UTF-8+ANSI 安全边界）逻辑必须保留在 daemon 侧切帧处，不得在转发层二次切割。
- **★hook 链路不因重启断裂**：现状 hook 端口随 app 每次启动变化且被烘焙进 PTY 子进程 env——daemon 化后 PTY 进程比 app 长寿，因此 hook 上报必须收口到 daemon 的稳定转发端口。app 的 `claude_hook.rs` 本地 server 保留，仅接收 daemon 转发（升级路径：daemon 模式下 `pty_create` 注入 daemon 端口而非 app 端口）。
- 鉴权：仅 `127.0.0.1`；token 随机 UUID，首帧校验失败立即断连并记日志；`daemon.json` 写入用户主目录（继承用户 ACL），不进日志。所有请求帧字段做格式/范围校验（sessionId 必须是已知 UUID，cols/rows 有界），非法帧断连——WebView→Rust→daemon 全程按不可信输入处理。
- Ring buffer：每会话保留尾部输出，字节上限默认 2 MiB/会话（≈对齐 `SNAPSHOT_MAX_LINES=2000` 的量级），attach 回放该 buffer；超限丢头部，必须在 ANSI 安全边界处丢弃。
- **★attach 输出交接必须无缝且有序**：daemon 侧必须在同一临界区内取得 ring-buffer 回放快照并把当前客户端加入会话订阅。前端恢复会话时必须先完成 `pty-output-{sessionId}` 监听注册，再调用 `pty_attach`；attach 应答返回前到达的实时帧先暂存，最终按“回放快照 → 暂存实时帧 → 后续实时帧”顺序写入 Display。禁止在任务中心或 `restoreSessions` 中先 attach、后挂载 XTerm，也禁止用持久化 scrollback 兜底掩盖该时序缺口。
- daemon 恢复会话必须保留原 `startupCmd` 作为 Tab 厂商/CLI 图标元数据，但不得重新执行该命令；一次性待 attach 状态属于 `terminalStore` 运行态，不得写入 `sessions.json`。
- 生命周期：
  - app 启动：读 daemon.json → 版本握手成功且 pid 存活 → attach `list` 全部会话；文件不存在/连接失败/token 拒绝 → 视为无 daemon，拉起新 daemon（Windows 仅使用 `CREATE_NO_WINDOW`，Unix `setsid`）；拉起失败 → **降级进程内 PTY，应用必须照常可用**，仅 toast 提示后台续跑不可用。
  - app 正常退出：默认 `detach`（daemon 续跑）；用户在 Phase 1 弹窗选"仍然退出"→ 先 `close_all` 再退出（保持"仍然退出=中断任务"语义不变）。
  - daemon 自灭：无会话 且 无客户端连接 持续 10 分钟 → 自动退出并删 daemon.json。有会话时永不自灭。
  - 版本握手不匹配：daemon 无会话 → daemon 自杀，app 拉起新版本；有会话 → 沿用旧 daemon 并记 warn（协议帧需向后兼容：未知字段忽略，未知 type 报错不崩）。
- 孤儿回收：`pty_reconcile_active_sessions` 语义改为对 daemon 会话集执行；app 崩溃后 daemon 中的会话不是孤儿（这正是特性），只有 daemon.json 中 pid 已死而残留的 PTY 子进程才按现有孤儿清理逻辑处理。
- **★进程治理（防孤儿/防性能劣化）**：
  - **Windows ConPTY Ctrl+C 契约**：daemon 自举禁止使用 `DETACHED_PROCESS` 或 `CREATE_NEW_PROCESS_GROUP`。ConPTY 收到 ETX (`0x03`) 后需要向兼容的控制台进程组投递 Ctrl+C；错误 flags 会造成普通输入正常、但运行中的 PowerShell/CMD/Claude/Codex 任务无法中断。GUI 主进程本身无控制台，Windows daemon 仅使用 `CREATE_NO_WINDOW` 隐藏窗口。
  - **Job Object 兜底**：Windows 上 daemon 启动即创建 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 的 Job Object，所有 PTY 子进程挂入——daemon 无论正常退出还是被强杀，系统自动回收全部子进程树，物理上杜绝 PTY 孤儿（Unix 对应 `setsid` + 进程组 kill）。
  - **daemon 单实例**：启动时以独占创建方式写 daemon.json；发现已有存活实例（pid 活且端口可握手）→ 新 daemon 立即自退，禁止多 daemon 并存。
  - **孤儿 daemon 清扫**：app 每次启动扫描一次——daemon.json 存在但 pid 已死 → 删文件；反向情况（无文件但存在同名 `cli-manager-daemon` 进程且属当前用户、且非另一环境实例）→ 尝试连接握手，握手不上视为僵尸，优雅终止失败后 kill。
  - **自灭规则细化**：无客户端连接时，全部会话均已 exited（子进程死、仅剩 buffer）→ 宽限 5 分钟后视同"无会话"参与 10 分钟自灭计时；exited 会话的 ring buffer 在自灭前保留供 attach 回放。
  - **资源上限**：会话数上限 64；总 buffer 内存上限 128 MiB（超限从最旧 exited 会话开始丢弃）；daemon 空闲时不做周期性轮询（事件驱动），避免后台 CPU 占用。
- 环境隔离：dev 与安装版使用不同发现文件与不同 daemon 实例，互不 attach；dev daemon 的二进制路径来自 `target/debug`。
- 与 Phase 1 关系：Phase 1 弹窗语义升级——"转入后台"在 daemon 模式下允许**真退出 app 进程**（任务在 daemon 里跑）；托盘常驻路径保留为 daemon 不可用时的降级。快照落盘 + resume 恢复链路**完整保留**，作为 daemon 与 app 双双死亡时的最终兜底。

### 4. Validation & Error Matrix

- daemon.json 存在但 pid 已死 / 端口拒连 → 删除残留文件，拉起新 daemon，不报错给用户。
- token 校验失败（文件被篡改/串版本）→ 断连 + 删除文件重拉。
- 传输中断（daemon 崩溃）→ app 侧对全部 attach 会话发 exit 状态（error），提示用户；xterm 标签保留可手动重开。
- 单会话 attach 回放失败 → 该会话空画面 + warn，不影响其他会话。
- attach 期间持续输出 → 回放与实时输出均保留且不重复；前端监听失败或 daemon 会话在 list 后消失 → 结束待 attach 状态并提示恢复失败，不重跑 `startupCmd`。
- 非法帧/超长帧（>8 MiB）→ 断连防 DoS。
- WSL 会话：env 转发（`apply_wsl_env_forwarding`）在 daemon 侧执行，行为与现状一致。

### 5. Good/Base/Bad Cases

- Good: codex 任务运行中真退出 app → daemon 续跑；重开 app 自动 attach，尾部 2 MiB 画面回放，任务不间断可继续输入。
- Base: 首次启动无 daemon → 拉起后创建会话；daemon 拉起失败 → 进程内 PTY 降级，一切照旧。
- Base: 后台期间 claude 任务 Stop → hook 上报进 daemon 缓存并把 `taskStatus` 更新为 `done`；app 重开后后台任务中心继续展示该任务，直到用户恢复/删除/丢弃。
- Bad: 转发层对 output 再切帧 → ANSI 序列被截断，前端花屏（必须只在 daemon 源头切）。
- Bad: hook env 仍注入 app 端口 → app 重启后 hook 上报打到死端口，Tab 状态永久 running。
- Bad: 版本升级直接杀有会话的旧 daemon → 用户任务被静默中断。

### 6. Tests Required（验收标准）

- Rust 单测：协议帧编解码（含未知字段/未知 type）、auth 失败断连、ring buffer 上限与 ANSI 边界丢弃、daemon.json 读写与 pid 存活判定、dev/安装版文件名选择；Windows daemon flags 必须等于 `CREATE_NO_WINDOW` 且不得包含 `DETACHED_PROCESS` / `CREATE_NEW_PROCESS_GROUP`。
- `cd src-tauri && cargo check && cargo test`；`npx tsc --noEmit`。
- Rust 回归测试必须同时断言 Attach 返回已有 replay，且对应客户端已进入该 session 的订阅集合。
- 手动：真退出→daemon 续跑→重开 attach 回放；杀 daemon→app 降级可用；杀 app→daemon 10 分钟内因仍有会话不自灭；无会话 10 分钟后 daemon 自灭且 daemon.json 删除；"仍然退出"确实 close_all；hook 通知在 app 重启后仍能绑定 Tab 状态；WSL/PowerShell/CMD/Pwsh 各建一次会话行为一致；dev 与安装版并行互不串扰。

### 7. Wrong vs Correct

#### Wrong

```rust
// 转发层按固定长度切 output 再发前端 —— ANSI/UTF-8 序列被拦腰截断
let chunk = &buffer[..4096];
app_handle.emit(&format!("pty-output-{id}"), base64(chunk));
```

#### Correct

```rust
// daemon 源头用 safe_emit_boundary 切帧，转发层只透传完整帧
let safe = safe_emit_boundary(&pending); // daemon 侧
send_frame(OutputFrame { session_id, data: base64(safe) });
// app 侧收到帧后原样 re-emit，不做任何再分片
```

#### Wrong

```rust
command.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
```

#### Correct

```rust
// 保持 ConPTY Ctrl+C 控制事件的进程组兼容性。
command.creation_flags(CREATE_NO_WINDOW);
```
