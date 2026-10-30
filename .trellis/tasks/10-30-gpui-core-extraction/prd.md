# M1：根 workspace + 去 Tauri 化的 Rust 核心 crate

> 父任务：`.trellis/tasks/10-30-gpui-native-migration`（先读其 `prd.md`、`design.md`、`implement.md`）。
> 已确认约束：`gpui-pre 0.3`（Zed 2026-09 快照）、GPU 原生渲染、界面单进程（保留 PTY daemon 与 web-daemon，见父 design §0.1）、仅预览（Markdown 文件 / HTML / PDF）按需嵌入系统 WebView。
> 详细设计见本目录 `design.md`，执行步骤见 `implement.md`。

## 目标
建立仓库根 Cargo workspace，把 `src-tauri` 中的业务逻辑抽成 `crates/core`、`crates/core-db`、`crates/core-prefs`，Tauri 版与 GPUI 版共用；为 GPUI 原生客户端扩展 daemon 协议。**Tauri 版行为必须零变化。**

## 依赖
`gpui-poc-gates` 结论为 Go（即便最终 No-Go，本子任务对 Tauri 版也有独立收益，可单独评估是否继续）。

## 范围
- 根虚拟 workspace + `.cargo/config.toml` 固定 target-dir；打包脚本与 CI 产物路径保持不变。
- `EventSink` / `AppPaths` / `UiServices` / `AppContext` 抽象（父 design §3.1）。
- `DaemonClient`/`DaemonBridge`、daemon 服务端（PTY、Hook 接收、路由代理、SSH Agent 桥）、`infrastructure/pty` 迁入 core，去掉 `AppHandle` 依赖。
- daemon 协议向后兼容扩展：`ws_ack_bytes_v1`、原生客户端（无 Origin）鉴权、`checkpoint_ansi_v1`。
- web-daemon 的设备连接与主进程 Operation 分发整理为 core 模块（进程边界不变）。
- features 与 infrastructure 分批迁移。
- 迁移定义中立化 + `_sqlx_migrations` 一致性测试；前端 20 张表的 Repository。
- 偏好 JSON：原子写、文件锁、未知字段保留。
- daemon / web-daemon / codex-proxy 二进制不再链接 Tauri。

## 非目标
不改任何事件名、事件载荷、命令名、命令入参出参形状；不改 React 代码；不改变 daemon 对 Tauri 客户端的任何行为。

## 验收标准
- [ ] 仓库根执行 `cargo check --workspace`、`cargo test --workspace` 全绿；`cd src-tauri && cargo test` 仍可用。
- [ ] `npm run tauri build` 与 `scripts/package-portable.ps1` 的产物路径不变；`release.yml` 无需修改或已同步修改。
- [ ] 新增测试：迁移一致性、偏好未知字段往返、EventSink 事件名映射快照、DaemonClient 在 `EventSink` 下的事件转发、daemon capability 协商（声明/未声明 `ws_ack_bytes_v1` 两种客户端并存）。
- [ ] `cargo tree -p cli-manager-daemon`、`-p cli-manager-web-daemon`、`-p cli-manager-codex-proxy` 中不含 `tauri`。
- [ ] `npm run tauri dev` 冒烟通过：终端创建/输入/分屏、转入后台后重开 attach、Git 面板、历史浏览、设置保存、WebDAV 同步、Hook 通知、本地路由、SSH Agent、Web 设备、托盘退出。
- [ ] `pty-daemon-contracts.md` 更新新增 capability 与原生客户端条款；新增 `.trellis/spec/backend/core-crate-contracts.md`。
- [ ] GitNexus `detect_changes` 无意外受影响流程。

## 性能优化（P1 核心侧、P2、P3 协议侧）
详见父任务 `research/perf-opportunities.md`。
- [ ] P2：`core-db` 为 `cli-manager.db`、`providers.db`、history catalog 各提供一个连接池（1 写 + N 读）。连接初始化统一设置 `journal_mode=WAL`、`synchronous=NORMAL`、`temp_store=MEMORY`、`cache_size`、`mmap_size`、`busy_timeout`，并开启预编译语句缓存。
- [ ] P2：替换 features 中各自的 `open_database()` / `SqliteConnection::connect` 临时连接（非测试代码约 135 处）。剩余例外（如只读打开外部 cc-switch.db、修复工具）逐条列出理由。
- [ ] P2：导入、索引、定价同步等批量写入统一放进事务；补测试：并发读写下没有 `database is locked`。
- [ ] P1：为下列状态变化补齐 `CoreEvent`，供 GPUI 取代轮询：daemon 会话增减/状态变化（daemon 推送 `session_status` 帧）、请求日志写入、统计数据更新（由 Hook 上报触发）、子代理目录变化。Tauri 版的事件映射保持不变。
- [ ] P3：daemon 支持 `ws_ack_bytes_v1`（按字节 ACK）；未声明的客户端仍按 UTF-16 计数。
