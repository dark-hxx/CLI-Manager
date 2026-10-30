# 实施步骤：原生终端

> 先读：本目录 `prd.md`、`design.md`；`pty-daemon-contracts.md`（PtyHost Direct Transport 一节全部条款）；`background-task-continuation-contracts.md`；`workspace-session-restore-contracts.md`；poc-gates 的终端/IME/checkpoint 结论。
> 前置：只读 Git 同步检查；对 core 中被调用/修改的函数先 `impact`。本任务新增 crate 为主。

## 步骤

### A. pty-client（约 2 周）
1. 建 `crates/pty-client`，加入根 workspace；frame 编解码（与 `protocol.rs` 共享常量：把帧定义放到 core 或独立 `crates/pty-protocol`，避免重复）。
2. bootstrap、auth（client_features）、控制请求超时、心跳。
3. 会话：create（含丢失探测）、attach、write（`ws_binary_input_v1`）、resize、close、tombstone。
4. committed_seq 游标 + 字节 ACK 节流；replay/replay_reset/checkpoint 处理接口（回调给 term-engine）。
5. 重连状态机；exit 顺序。
6. 测试：对接真实 daemon（测试中以子进程启动 `cli-manager-daemon`，临时 data dir）——契约错误矩阵逐条一个集成测试；模糊测试帧解码。

### B. term-engine（约 3 周，可与 A 并行）
1. Term 封装、EventProxy、vte 预扫描（OSC 133/633/8/52/颜色）。
2. 键盘编码（含 Kitty）、鼠标上报、粘贴规则。
3. 兼容层移植（design §3.3 表格逐行），每条附测试。
4. `serialize_to_ansi` + M0 fixture 往返测试；Unicode 宽度差异表与修正。
5. 搜索、选区（单词/行选择规则与 xterm 一致）、URL 检测。
6. 基准：criterion 解析吞吐（仅作开发参考，P12 暂缓不进 CI）。

### C. 视图与渲染（约 2.5 周）
1. TerminalElement：快照读取、行 shaping 缓存、背景合并、光标/选区/搜索层。
2. 字体与回退链、连字、背景图。
3. 低功耗订阅；隐藏 pane 不请求帧。
4. 性能测量：`cat` 100 MB、8 分屏、键入延迟（复用 `scripts/bench`）。

### D. 输入与 IME（约 1 周）
1. EntityInputHandler；候选窗定位；组合态按键屏蔽。
2. 剪贴板文本/图片、拖放路径转换。
3. 手测矩阵：微软拼音、搜狗、日文 IME × PowerShell/WSL/Claude Code TUI。

### E. 会话模型、分屏、Tab（约 2 周）
1. pane_tree/workspan/tabs/layout lock 纯数据移植 + 测试。
2. Resizable 视图、Tab 拖拽、5 drop zone、锁定布局拖拽。
3. Tab 状态双源合并 + hook 超时回退。
4. 工作区快照持久化与恢复（按 restore 契约）。
5. 终端 Markdown 预览入口（对接 PreviewHost，rich-content-host 完成前用占位）。

### F. 后台任务与退出（约 1 周）
1. ExitCoordinator + RunningTasksExitDialog + 记住选择。
2. 后台任务列表（session_status 驱动）、attach、reconcile 触发策略。
3. 与 shell-foundation 的 CloseCoordinator、desktop-integration 的托盘/更新入口对接（对方未完成时提供 trait 接口）。
4. 手测：契约 §6 的 7 条验收在 GPUI 版逐条执行。

### G. 收尾（约 0.5 周）
1. 跨壳 attach 手测（Tauri → GPUI、GPUI → Tauri）。
2. spec：新增 `.trellis/spec/frontend/gpui-terminal-contracts.md`（数据通路、ACK 游标、渲染帧规则、IME、退出守卫映射）；`pty-daemon-contracts.md` 增补原生客户端条款的验证记录。
3. CHANGELOG、`docs/功能清单.md`（GPUI 预览版终端能力）。

总估时约 10–12 人周（A/B 并行可压缩）。

## 验证命令

```bash
cargo test -p cli-manager-pty-client -p cli-manager-term-engine
cargo test --workspace
cargo run -p cli-manager-desktop-gpui
node scripts/bench/run-baseline.mjs --target gpui --suite terminal
```

## 完成标准
prd 全部验收项勾选并附测量数据；场景矩阵中“运行环境 / 分屏 / 多会话 / Hook / 进程生命周期 / 输入法 / 双壳共存”维度有记录。

## 回退
GPUI 终端为新增代码；唯一共享改动是 daemon 协议（core-extraction 已完成且向后兼容）。若性能门槛不达标，暂停本任务，父任务评估是否 No-Go。
