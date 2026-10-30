# 原生终端（daemon 客户端 + GPUI 渲染）

> 父任务：`.trellis/tasks/10-30-gpui-native-migration`（先读其 `prd.md`、`design.md`、`implement.md`）。
> 已确认约束：`gpui-pre 0.3`（Zed 2026-09 快照）、GPU 原生渲染、界面单进程（保留 PTY daemon 与 web-daemon，见父 design §0.1）、仅预览（Markdown 文件 / HTML / PDF）按需嵌入系统 WebView。
> 详细设计见本目录 `design.md`，执行步骤见 `implement.md`。

## 目标
用 GPUI 原生实现终端：`crates/pty-client`（Rust 版 `PtyHostSocket`，连接现有 daemon）、`crates/term-engine`（alacritty_terminal 封装）、TerminalElement 渲染、输入/IME、分屏树、Tab 与 Workspan、后台任务与退出守卫。

## 依赖
`gpui-core-extraction`（daemon 协议扩展）、`gpui-shell-foundation`。可与 `gpui-rich-content-host` 并行。

## 范围
父 design §5、父 implement §3。`pty-daemon-contracts.md` 的全部客户端条款（鉴权、心跳、重连 attach、sequence 过滤、create 丢失探测、tombstone、退出顺序）都适用于 `pty-client`；`background-task-continuation-contracts.md` 全部适用。`browser/TerminalPi*`、换行快捷键、鼠标交互、reflow/resize 屏障等历史修复都要移植并附测试。

## 约束
- 禁止依赖 Zed 的 `terminal` / `terminal_view`（GPL）。
- 不在 UI 进程内创建 PTY；daemon 不可用时终端创建明确失败并提示，不回落。
- 隐藏终端继续订阅并解析输出，只是不绘制；不建立 inactive raw buffer。
- checkpoint 必须是 xterm 与 alacritty 都能重放的 ANSI 流，保证两壳可互相 attach。

## 验收标准
- [ ] PowerShell / CMD / Pwsh / WSL / Git Bash / SSH 下，Claude Code、Codex、OpenCode、vim、htop、less 交互正常（鼠标、备用屏、颜色、Kitty 键盘）。
- [ ] 中文 IME（微软拼音、搜狗）在终端中组合与上屏正确，候选窗跟随光标。
- [ ] 性能：`cat` 100 MB 吞吐不低于 xterm WebGL 基线；8 分屏滚动 60 fps；键入延迟 p95 ≤ 10 ms。
- [ ] 分屏：上下左右中 5 个 drop zone、深层节点拆分/关闭、锁定布局、跨 Workspan 切换。
- [ ] Tab 状态（hook + shell 双源，按 `TAB_STATUS_PRIORITY` 合并）在 Hook 已装、未装、只装其一三种情况下正确。
- [ ] 退出守卫 ask / background / minimize / discard 四种分流与 Tauri 版一致；“转入后台”后 UI 退出、会话在 daemon 中继续，重开后可从后台任务列表 attach。
- [ ] daemon 被杀/重启、WS 断线、create 响应丢失三种故障下，行为符合 `pty-daemon-contracts.md` 的错误矩阵。
- [ ] 跨壳 attach：Tauri 版转入后台的会话可在 GPUI 版中 attach 并正确显示，反之亦然。

## 性能优化（P1 终端侧、P3）
详见父任务 `research/perf-opportunities.md`。
- [ ] P3：`pty-client` 把二进制帧 payload 以 `bytes::Bytes` 切片零拷贝交给 term-engine；声明 `ws_ack_bytes_v1`，ACK 按字节计数，不做 UTF-16 换算。
- [ ] P3：每个会话的 VT 解析在后台任务执行；主线程按帧（跟随 vsync）读取 damage 区域并绘制。大量输出（`cat` 100 MB）期间 UI 不冻结超过 100 ms。
- [ ] P3：保留 daemon 侧 5 ms 输出合并；同一帧内的多次 damage 只绘制一次。
- [ ] P3：所有分屏共享字形缓存与行 shaping 缓存；scrollback 上限可配置。
- [ ] P1：后台任务列表由 daemon 会话状态推送驱动（删除 3 s 轮询，见 `useTerminalTabsController.tsx:1697`）；孤儿会话对账（`terminalStore.ts:65`）只保留诊断用途，改为事件触发 + 低频兜底；子代理目录发现改为目录 watcher。
