## 问题现象

当多个聊天会话同时打开，其中一个会话持续输出时切换 Tab，WebView 主线程可能被长时间占用，表现为整个 App 卡死。隐藏会话仍保持挂载，持续输出期间还会触发终端 TUI 颜色/背景扫描，进一步放大阻塞。

## 根因

前端输出队列会在一次动画帧中无界合并连续 live PTY frame，最终调用一次超大的 `terminal.write()`。xterm 在写入过程中执行解析和渲染，隐藏会话的 TUI 颜色/背景扫描也同步运行，导致 Tab 切换、React 渲染和输入事件无法及时得到主线程调度。

## 修改内容

1. 为连续 live 输出增加 64 KiB 原始 frame 字节预算，只在完整 PTY frame 边界合并；超预算 frame 独立写入，后续批次等待当前 xterm `write` callback 和下一动画帧。
2. 隐藏会话继续写入 xterm 并保留完整 buffer，但跳过 TUI 颜色/背景扫描；切回可见时由现有可见性 effect 补做一次同步。

Replay/Reset 屏障、PTY frame 边界、xterm `write` callback 后的 `TerminalOutputDelivery.commit()`/ACK 时序均保持不变；未修改 daemon、ConPTY、xterm 版本或依赖。

## 验证

- `terminalReplay.test.mjs`：13/13 通过。
- `terminalTuiColorSync.test.mjs`、`terminalVisibility.test.mjs` 及相关终端测试：19/19 通过。
- `npx tsc --noEmit`：通过。
- `npm run build`：通过。
- `git diff --check`：通过。

全量 `scripts/*.test.mjs` 还存在 3 项与本次改动无关的基线/环境失败：缺少 `cargo` 的 Codex proxy E2E、旧版 SSH agent 版本断言，以及引用仓库中不存在文件的 cursor movement 测试；未修改这些无关问题。

## 人工验证范围

当前环境未启动 Tauri/Vite 窗口进行真实 GUI 高频输出压测，因此仍建议在本地打开多个聊天会话，让一个会话持续输出并反复切换 Tab、分屏和 Workspan，确认 UI 响应、输出完整性及 TUI 颜色恢复。
