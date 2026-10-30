# 随迁移一并完成的性能优化候选（2026-10-30）

> 原则：只收录**迁移时本来就要重写或搬动**的代码上的优化，避免额外扩大范围。每项都附代码证据、预期收益、风险与归属子任务。
> 状态（2026-10-30 用户确认）：**P1–P8 纳入计划**，验收标准已写入对应子任务 `prd.md`；P9–P12 暂缓。

## 总览（按收益/成本排序）

| # | 优化 | 证据 | 收益 | 成本/风险 | 归属子任务 |
|---|---|---|---|---|---|
| P1 | 轮询改事件驱动 + 窗口不可见时整体降频 | 前端 27 处 `setInterval` | 空闲 CPU/唤醒次数大幅下降，耗电降低 | 低 | 各功能子任务 + shell-foundation |
| P2 | 统一 SQLite 连接池与读写分离 | Rust 侧约 135 处临时 `connect`；前端另有一个 plugin-sql 连接池 | 减少每次开库与 PRAGMA 的开销；消除锁竞争 | 中（需逐处替换） | core-extraction |
| P3 | 终端管线零拷贝 + 解析下沉到后台任务 | 现状：daemon → WS 二进制帧 → JS → xterm；ACK 按 UTF-16 计数 | 吞吐与延迟的主要来源 | 中 | core-extraction（协议）+ terminal-native |
| P4 | Git 状态增量化，少启子进程 | `features/git/status.rs:131` 每次刷新执行 `git status --porcelain=v1 -z` | Windows 上每次启动进程约 30–100 ms；大仓库尤甚 | 中 | workspace-features |
| P5 | 历史/实时转录：共享 watcher + 增量尾读 | `history/live_transcript.rs:100-125` 每个文件一个线程，100 ms sleep + 1 s 超时循环；history 中 57 处 serde_json 解析 | 线程数与唤醒次数下降；大 JSONL 只解析新增部分 | 中 | workspace-features |
| P6 | 启动懒加载：字体、索引、定价 | `statusline/mod.rs:385`、`system/fonts.rs:21` 各自 `load_system_fonts()` | 字体多的 Windows 机器上节省数百毫秒级开销 | 低 | shell-foundation |
| P7 | 全局分配器 | `src-tauri/Cargo.toml` 的 release profile 已是 `lto="fat"`、`codegen-units=1`、`strip="symbols"`、`panic="abort"`；未使用 mimalloc | 多线程分配吞吐提升（经验值 5–15%，以 M0 测量为准） | 低 | poc-gates（测量）+ shell-foundation |
| P8 | WebView2Loader 延迟加载 | “按需”约束要求启动时不加载 WebView 相关 DLL | 启动时少加载 DLL，内存更干净 | 低 | rich-content-host |
| P9 | 列表虚拟化 + 分页查询 + 增量更新 | 历史/Git 列表现为整批拉取后由前端虚拟化 | 万级列表的首屏时间与内存 | 低 | workspace-features |
| P10 | 后台任务的能效 QoS | 索引、同步、统计都是后台批处理 | 不抢前台终端的 CPU，降低功耗 | 低 | core-extraction |
| P11 | 回放持久化改为追加写 + 压缩 | `sessionSnapshotPersistence.ts` 每 10 s 写一次完整快照 | 减少写放大与 IO 抖动 | 中 | terminal-native |
| P12 | 内置性能观测与回归基准 | 当前没有持续的性能基准 | 防止优化成果被后续改动回退 | 低 | poc-gates（建立基线）+ release-cutover |

## 详细说明

### P1 轮询改事件驱动

GPUI 版中 core 与 UI 同进程，core 直接通过 `EventSink` 把变化推给 UI；daemon 侧的会话变化通过控制面推送帧转发。大部分轮询失去存在理由：

| 现有轮询 | 位置 | 替代 |
|---|---|---|
| Git 后台刷新 15 s | `git/api/GitChangesPanel.tsx:482/531` | 已有 `features/git/watcher.rs`，改为 watcher 事件驱动；仅当 watcher 失效（网络盘、部分 WSL 路径）时退回轮询 |
| 文件树刷新 15 s | `files/api/ProjectFileRefreshController.tsx:59` | 已有 `infrastructure/files/file_watcher.rs`，同上 |
| 后台任务列表 3 s | `terminal/hooks/useTerminalTabsController.tsx:1697` | daemon 新增 `session_status` 推送帧（会话增减、退出、状态变化），DaemonClient 转为 `CoreEvent`，**轮询删除** |
| PTY 孤儿会话对账 | `terminal/store/terminalStore.ts:65` | 契约规定 reconcile 只用于诊断；改为 WS 重连/attach 后与收到 `session_status` 时触发，外加低频兜底（≥ 60 s，仅窗口可见时） |
| 统计面板 5 s / 2 s | `terminal/components/TerminalStatsPanel.tsx:565` | Hook 上报（UserPromptSubmit/Stop）触发刷新，计时器只作兜底 |
| 请求日志同步 60 s | `app/App.tsx:748` | 路由层写入日志时发事件 |
| 系统资源采样 | `stats/api/useSystemResources.ts:137` | 面板可见时才采样；窗口不可见时暂停 |
| 子代理目录发现 | `terminal/store/terminalRuntime.ts:251` | 改用目录 watcher |
| 待激活后台会话 | `app/App.tsx:1060` | 单实例参数转发直接投递事件 |

另外，GPUI 窗口失去焦点、最小化或隐藏到托盘时，统一进入“低功耗模式”：停止光标闪烁和动画、暂停资源采样与 statusline 刷新、合并重绘。

### P2 统一 SQLite 访问

- 现状：`features/*` 中有多个各自的 `open_database()` / `SqliteConnection::connect`（extensions、remote、providers、stats、history catalog …）。每次调用都要开文件、执行 PRAGMA；前端还有另一套 plugin-sql 连接池，两边会争抢写锁。
- 方案：`core-db` 为每个库提供一个池（`cli-manager.db`、`providers.db`、history catalog）：
  - 1 个写连接 + N 个只读连接（WAL 模式下读不阻塞写）；
  - 连接初始化时统一设置 `journal_mode=WAL`、`synchronous=NORMAL`、`temp_store=MEMORY`、合理的 `cache_size` 与 `mmap_size`、`busy_timeout`；
  - 启用 sqlx 的预编译语句缓存；
  - 批量写入（导入、索引、定价同步）统一放进事务。
- 风险：要逐处替换连接获取方式；读写分离后需要确认没有“写后立刻在另一连接读”的一致性假设。

### P3 终端管线

- daemon 保留（见父 design §0.1）。`pty-client` 收到二进制帧后，payload 以 `bytes::Bytes` 切片零拷贝交给 term-engine；没有 JS 字符串转换、没有 base64。
- 新 capability `ws_ack_bytes_v1`：ACK 按字节计数，客户端不再做 UTF-16 换算；Tauri 版不声明则行为不变。
- 每个会话的 VT 解析放在后台任务，`Term` 由锁保护；主线程每帧（跟随 vsync）只读取 damage 区域快照，**解析与绘制解耦**，大量输出时 UI 不卡。
- 输出合并：保留 5 ms 合并窗口；同一帧内的多次 damage 只绘制一次。
- 所有分屏共享字形缓存（glyph atlas）与行 shaping 缓存；按行内容哈希缓存。
- 回滚缓冲区（scrollback）使用 alacritty 的紧凑网格存储；上限可配置，隐藏会话可选择压缩冷数据。

### P4 Git 状态增量化

- 本地仓库：启用 `core.untrackedCache` 与可用时的 fsmonitor；watcher 已经提供变化路径时，执行 `git status -- <paths>` 的增量查询，而不是全量状态。
- 用 git2 直接读取 HEAD/分支/ahead-behind 等轻量信息（已部分使用 git2，共 28 个文件），不再为它们启动进程。
- WSL 路径继续使用 CLI（`features/git/wsl.rs`），保持现有正确性。
- Diff 只为可见文件按需计算；语法高亮结果按 blob id 缓存。

### P5 历史与实时转录

- 共享一个 notify watcher（按目录聚合），事件分发到 tokio 任务，取代“每个文件一个线程 + sleep 循环”。
- 记录每个 JSONL 文件已读取的字节偏移，只解析新追加的部分（需核实 `scan_state.rs` 现有能力后在其基础上扩展）。
- 首次全量扫描用有界并发（如 `rayon`，并发数 ≤ CPU 核数的一半），避免抢占终端。
- JSON 解析热点可评估 `simd-json` / `sonic-rs`，需基准证明收益后再引入。

### P6 启动懒加载

- 字体：两处 `load_system_fonts()` 合并为一个全局懒加载缓存，首次用到字体列表时才加载；GPUI 自身的文字系统已经掌握系统字体，优先复用它。
- 首帧前只做：读偏好、打开主库、加载项目树。历史索引、定价同步、ccusage 缓存、WebDAV 自动同步、更新检查全部在首帧之后进行。
- i18n 只加载当前语言。

### P7 分配器与构建参数

- 全局分配器换成 `mimalloc`（Windows 默认堆在多线程下分配吞吐偏低），以 M0 测量结果决定是否启用。
- release profile 已核实：`src-tauri/Cargo.toml` 中已经是 `lto = "fat"`、`codegen-units = 1`、`strip = "symbols"`、`panic = "abort"`。迁到根 workspace 后原样沿用；PTY 已在 daemon 进程中隔离，UI 进程不需要 `catch_unwind`，因此保留 `panic = "abort"`。
- 可选：对 term-engine 做 PGO（cargo-pgo），视基准收益决定。

### P8 WebView2Loader 延迟加载

- 确保 `WebView2Loader.dll` 及 WebView 相关代码只在第一次打开预览时加载：使用 delay-load 链接，或通过 `webview2-com` 动态加载。
- 验收：不打开预览时，进程模块列表中没有 WebView2Loader.dll。

### P9 列表

- 历史、Git、请求日志、命令历史：Repository 提供基于游标的分页查询；GPUI 用 `uniform_list` 只渲染可见行。
- 数据变化时增量更新（插入/删除/修改单行），不再重新拉取整页。
- 共享字符串使用 `Arc<str>` / `SharedString`，避免大列表反复克隆。

### P10 后台任务能效

- 索引、同步、统计聚合等批处理线程设置为低优先级；Windows 上使用 EcoQoS（`SetThreadInformation` + `ThreadPowerThrottling`），macOS 上使用 QoS background。
- 前台终端解析与渲染线程保持正常优先级。

### P11 回放持久化

- 现状每 10 s 写一次完整快照。改为：会话输出追加写入（分段 + zstd 压缩），定期生成一次 ANSI checkpoint，旧分段滚动删除。
- 与 `ai_replay_*` 表配合：表中只存元数据与分段索引，内容放文件，避免 SQLite 膨胀。

### P12 性能观测

- 使用 `tracing` 埋点，开发模式下可导出 Chrome trace。
- 隐藏的性能 HUD（帧时间、每秒 PTY 字节数、队列深度、WebView 状态）。
- 为 term-engine 解析吞吐与历史扫描建立 criterion 基准，并作为 PR 检查项。

## 明确不做（会扩大范围或收益不确定）

- 不把 git CLI 全面替换为 gix/git2（WSL 与边缘行为风险高）。
- 不更换数据库引擎，也不重构 history 的数据格式。
- 不为预览以外的场景引入任何 WebView 缓存或预热。
