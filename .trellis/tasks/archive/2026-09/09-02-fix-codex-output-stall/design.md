# Issue #245 技术设计

## 1. 现状与边界

现有链路为：

```text
PTY reader
  -> DaemonPtyEventSink(sync_channel(1))
  -> 5 ms/64 KiB daemon output worker
  -> SessionBuffer + client high-water wait
  -> PtyHostSocket/WebSocket
  -> TerminalProcessManager
  -> global requestAnimationFrame scheduler
  -> xterm terminal.write(callback)
  -> commit -> ACK(char_count)
```

问题在两个相互放大的阻塞点：hidden WebView 中 rAF 不运行，前端没有调用 xterm callback；daemon worker 等不到 ACK 后等待高水位，进而阻塞有界 PTY 事件通道。修复需要同时处理调度触发条件和背压阻塞位置。

外部资料与本项目映射：

- [MDN Page Visibility API](https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API) 与 [Chrome background tabs](https://developer.chrome.com/blog/background_tabs/) 说明 hidden 页面会停止/限制 rAF，并节流 timer。
- [WebKit 后台页面功耗说明](https://webkit.org/blog/8970/how-web-content-can-affect-power-usage/) 明确列出 inactive page 会停止 rAF、节流 timer，macOS 还会受到 App Nap 影响；[Tauri WebView API](https://github.com/tauri-apps/tauri/blob/dev/packages/api/src/webview.ts) 说明 hidden view 默认可能进一步被暂停或卸载，且 `backgroundThrottling` 不是 Windows/Linux 的通用解法。
- Debian [gnome-terminal #1068339](https://bugs.debian.org/cgi-bin/bugreport.cgi?bug=1068339) 的 `ffmpeg`/最小化终端案例与本 issue 的“进程写入最终阻塞、切回后追赶”最接近。
- [xterm.js Flow Control](https://xtermjs.org/docs/guides/flowcontrol/) 规定了 write callback + ACK watermark 的模式，同时警告 WebSocket 自定义流控计数不一致会永久阻塞；本项目的 ACK 时机应保留，但 server 生产线程不能绑定到 hidden client 的消费速度。

## 2. 设计原则

1. ACK 仍然代表 xterm 写入完成，绝不把 ACK 提前到收到 WebSocket/放入前端队列。
2. 背压的暂停对象是“慢客户端的投递”，不是“PTY 生产者”；输出先进入已有有界 session ring/spool。
3. 以 sequence 作为唯一恢复游标；实际入 writer 队列后才更新 `last_sent_sequence` 与 unacknowledged UTF-16 数量。
4. 保持现有控制帧优先、WebSocket 二进制输出、NDJSON 兼容和 replay/reset 语义。
5. 所有跨 session 的共享热路径改动先用 GitNexus impact 复核；修改后用测试和 detect_changes 收口。

## 3. 前端调度方案

在 `src/hooks/useTerminalDisplay.ts` 的全局 scheduler 中增加 document 可见性感知：

- `document.visibilityState !== "hidden"`：继续使用 rAF，维持现有“单帧一个 xterm write”和 visible/hidden 公平配额；同时挂一个约 250ms 的 watchdog，rAF 迟迟不运行时由 watchdog 接管并取消未执行的 rAF。
- `document.visibilityState === "hidden"`：改用单一 timer（约 250 ms）驱动同一批选取逻辑。timer 每次只消费一个 terminal entry，然后按现有逻辑继续排程，避免单个会话垄断。
- 首次有 pending entry 时安装一次 `visibilitychange` listener；状态切换时取消当前 rAF/watchdog handle 并依据新状态重新排程，确保 rAF 被暂停后不会留下不可达任务。
- pending map 清空或 hook dispose 时取消 rAF/timer；移除全局 listener，防止窗口生命周期结束后引用 terminal。
- 测试环境没有 `document` 时按可见路径运行，保持既有纯 Node 测试兼容；测试显式提供 `document.visibilityState`、事件监听和可控 timer。

timer 只作为 best-effort 的实时刷新。由于 Tauri/WebKit 可能节流 timer、App Nap，甚至暂停/卸载 hidden view，daemon 侧“暂停客户端投递、继续有界缓存 PTY 输出”是避免任务被反向阻塞的必要保障；不通过关闭 WebView background throttling 来规避问题。

不修改 `TerminalProcessManager` 的 commit/drain 算法：它已经保证 FIFO、replay/reset 边界和“回调后 ACK”。

## 4. daemon 背压方案

### 4.1 投递状态

保留每客户端每 session 的：

- `unacknowledged_chars`
- `flow_control_paused`
- `last_sent_sequence`
- `last_acknowledged_sequence`

调整语义：

- 新输出先在 `SessionEntry.buffer` 中保存并分配 sequence。
- 对处于 attach barrier 的客户端，继续放入 `attaching`，保证 replay 控制帧先于 barrier 后的 live output。
- 对正常 attached 客户端：若该 session 已 paused，则跳过本次 writer 投递；否则投递并在成功后更新发送游标/未确认字符。达到高水位后只标记该客户端 paused。
- `ClientWriter` 仍使用既有 2 MiB output queue 上限；发送失败继续关闭并清理客户端状态。

### 4.2 恢复补发

`acknowledge_output` 在确认客户端降到低水位后，保持该 session 的 paused 状态，先取得有界 live-frame 快照，再入队补发并最后解除 paused，避免新 live frame 越过尚未补发的旧 frame：

1. 先取得 session entry 锁，短暂取得 clients 状态更新 ACK 计数但不立即移除 paused；释放 clients 锁后在 session entry 锁内读取一次包含 spool 与内存的原始 live-frame 快照。
2. 重新取得 clients 锁，只针对触发 ACK 的 attached、非 attaching、仍 paused 客户端补发；补发使用快照过滤 `last_sent_sequence` 之后的帧，不在全局 clients 临界区回读磁盘，也不为其他客户端重复读取同一 spool。
3. 只发送可表示为现有 `DaemonFrame::Output` 的实际输出帧；resize 信息继续由后续 output 的 cols/rows 携带，空 resize 记录不制造虚假 ACK，但空 resize 的 sequence 参与缺口检测。
4. 每成功入队一帧就递增该客户端 unacknowledged；刚达到高水位立即停止该客户端本轮补发并保持 paused，下一个低水位 ACK 再继续。
5. 如果 session buffer 已经越过客户端游标，关闭该客户端连接，让既有重连 attach 根据 `oldest_sequence` 发送 replay reset 与完整保留回放；不得把缺失 sequence 后的 suffix 当作普通 Output，也不得重复发送已确认帧。checkpoint 快照始终排除在 live backlog 之外。

### 4.3 锁与顺序

生产与 ACK 补发路径统一为 `session entry lock -> clients lock -> ClientWriter queue lock`；SessionBuffer/spool 回读发生在全局 clients 锁外，任一锁内都不等待 ACK、PTY 或 socket 实际写出。paused 状态在快照和入队期间保持，使 ACK 恢复时旧缓冲帧先于新 live frame，同时其他 session 不会被大磁盘 replay 拖住。

删除 `wait_for_output_capacity` 及其专用 Condvar/notify 路径；高/低水位字段本身保留作为每客户端投递闸门。

## 5. 兼容性与失败处理

- 不增加 daemon protocol version 或新帧类型。
- daemon 重启、客户端断线、detach/close 时清理发送/暂停游标，现有 attach replay 继续负责恢复。
- SessionBuffer/spool 和 ClientWriter 仍有固定上限；writer 满时按现有策略关闭客户端，重连走 replay。
- `char_count` 继续由实际 UTF-8 数据按 UTF-16 code unit 计算；replay/空帧不改变既有 `char_count=0` 行为。
- 不新增用户可见文本；诊断只复用既有日志/资源字段，避免 i18n 范围扩张。

## 6. 验证策略

- 前端：hidden document timer 触发、visible/hidden 切换迁移、dispose 清理、单帧单写、回调后 commit/ACK。
- Rust：输出跨过高水位后 `emit_daemon_output`/输出 worker 可继续接收并写入 session buffer；ACK 到低水位后顺序补发；多客户端只暂停慢客户端；已有 attach/replay/queue 上限测试。
- 集成：终端相关 Node tests、Rust daemon tests、TypeScript、Rust fmt/check；最后运行 GitNexus detect_changes。
