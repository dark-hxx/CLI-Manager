# 实施计划（父任务）

> 后续阶段执行顺序以同目录 `implementation-plan-v2.md` 为准；本文件保留里程碑、门禁与子任务索引。

> 父任务只负责编排、跨子任务验收与最终集成评审，本身不改代码。每个子任务目录下都有 `prd.md` / `design.md` / `implement.md`，按各自 `implement.md` 执行。
> 已确认约束（见 design §0）：`gpui-pre 0.3`、GPU 原生渲染、界面单进程（保留 PTY daemon 与 web-daemon）、仅预览（Markdown 文件 / HTML / PDF）按需嵌入系统 WebView。
> 通用前置（每个子任务、每个提交批次都适用）：
> 1. 开工前执行只读的 Git 分支/上游同步检查（`git status -sb`、`git rev-list --left-right --count @{u}...HEAD`），不自动 fetch/pull/push；
> 2. 改任何现有函数前先跑 GitNexus `impact`（upstream），HIGH/CRITICAL 先报告；
> 3. 提交前跑 `detect_changes({scope: "all"})`，`partial`/`truncated` 时重跑；
> 4. 每次代码变更同步 `CHANGELOG.md` 与 `docs/功能清单.md`；
> 5. 修 bug 走 `fix-triage-guide.md`；新增需求按 §5 场景维度清单枚举。

## 里程碑与门禁

```
M0 PoC Go/No-Go ──► M1 根 workspace + Core 抽取（Tauri 版无回归）──► M2 GPUI 可启动 + 终端可用（内部 Alpha）
      ──► M3 主路径对齐（项目/终端/Git/历史/设置，内部 Beta）──► M4 全量对齐 + 双轨发布 ──► M5 Tauri 下线
```

| 里程碑 | 子任务 | 门禁（全部满足才能进入下一阶段） |
|---|---|---|
| M0 | poc-gates | gpui-pre 0.3 + gpui-component 能一起编译；许可证无 GPL-only；Windows 中文 IME 可用；8 分屏渲染 ≥ 60 fps；ANSI checkpoint 往返可行；原生编辑器满足文件编辑与冲突解决；预览 WebView 嵌入与 WebView2 缺失探测可行；Tauri 基线已记录 |
| M1 | core-extraction | `cargo test --workspace` 全绿；Tauri 版回归无差异（事件名/载荷/命令签名不变）；daemon 新 capability 与旧客户端共存测试通过；daemon/web-daemon/codex-proxy 不再链接 Tauri；`_sqlx_migrations` 一致性测试通过；打包产物路径不变 |
| M2 | shell-foundation、terminal-native | GPUI 版能在 PowerShell/WSL/Git Bash 中创建会话并正常交互；IME 可用；不打开预览时无 WebView 进程；转入后台/attach 可用 |
| M3 | rich-content-host、workspace-features、settings-panels | design §9 中项目/终端/Git/历史/设置五个域对齐；三类预览 × WebView 可用性 6 种状态手动验证通过 |
| M4 | desktop-integration、release-cutover | 性能目标全部达标；P1–P8 验收通过；场景矩阵全量回归；Tauri→GPUI→Tauri 数据往返无损；跨壳 attach 通过 |
| M5 | release-cutover | 至少一个正式版本的双轨期，崩溃率与问题反馈不高于 Tauri 版 |

## 子任务执行顺序与要点

| 顺序 | 子任务 | 详细计划 | 关键产物 |
|---|---|---|---|
| 0 | `gpui-poc-gates` | `../10-30-gpui-poc-gates/implement.md` | `spikes/gpui-poc`（不进主构建）、compat / license-audit / baseline / poc-results 四份报告 |
| 1 | `gpui-core-extraction` | `../10-30-gpui-core-extraction/implement.md` | 根 workspace、`crates/core`、`core-db`、`core-prefs`、daemon 协议扩展、`core-crate-contracts.md` |
| 2 | `gpui-shell-foundation` | `../10-30-gpui-shell-foundation/implement.md` | `apps/desktop-gpui` 骨架、`ui_kit`、i18n 导出脚本、状态模型、启动时序 |
| 3 | `gpui-terminal-native` | `../10-30-gpui-terminal-native/implement.md` | `crates/pty-client`、`crates/term-engine`、TerminalElement、分屏树、退出守卫 |
| 4 | `gpui-rich-content-host` | `../10-30-gpui-rich-content-host/implement.md` | `crates/preview`、原生 Markdown、原生编辑器、降级 UX |
| 5 | `gpui-workspace-features` | `../10-30-gpui-workspace-features/implement.md` | 项目、文件、Git、历史四个域 |
| 6 | `gpui-settings-panels` | `../10-30-gpui-settings-panels/implement.md` | 设置、扩展、Provider、同步、SSH、提示词、统计 |
| 7 | `gpui-desktop-integration` | `../10-30-gpui-desktop-integration/implement.md` | 托盘、单实例（与 Tauri 版互通）、通知、桌宠、Web 设备、更新器（复刻 updater 契约、`-gpui` manifest 键）、安装包；Windows / macOS aarch64 / Linux deb+AUR 四平台 |
| 8 | `gpui-release-cutover` | `../10-30-gpui-release-cutover/implement.md` | 性能报告、回归记录、双轨发布、下线清单 |

- 3 与 4 并行；5 与 6 并行；7 在 3 完成后即可开始。
- 回退点：任一硬门槛失败 → 父任务 No-Go，提交结论文档后停止；M1 之后任何阶段失败，Tauri 版仍是发布主线。
- 父任务在每个里程碑结束时做一次集成评审：核对子任务验收记录、`detect_changes --scope compare --base-ref master`、spec 是否已同步。

## 跨子任务的契约与共享产物

| 产物 | 提供方 | 使用方 |
|---|---|---|
| `CoreEvent` 枚举与 `EventSink` | core-extraction | 全部 GPUI 子任务 |
| Repository（20 张表） | core-extraction | shell-foundation、workspace-features、settings-panels |
| daemon capability：`ws_ack_bytes_v1`、原生鉴权、`checkpoint_ansi_v1`、`session_status` 推送 | core-extraction | terminal-native、desktop-integration |
| `ui_kit`、`Services` global、Keymap/Action 注册表 | shell-foundation | 全部 UI 子任务 |
| 原生 Markdown、原生编辑器、`PreviewHost` | rich-content-host | workspace-features、settings-panels |
| `TerminalModel`/`PaneTree`、`open_terminal` 入口 | terminal-native | workspace-features、desktop-integration |
| 退出守卫与 `ExitCoordinator` | terminal-native | desktop-integration（托盘/更新）、shell-foundation（关窗） |
| 基准脚本与 baseline | poc-gates | release-cutover |
| helpers crate（daemon/web-daemon/codex-proxy）改依赖 core、不链接 Tauri | core-extraction | desktop-integration（打包）、release-cutover（迁到 `apps/helpers`） |
| 更新 manifest `-gpui` 键、签名器（minisign，密钥不变） | desktop-integration | release-cutover |

## 性能优化 P1–P8 归属（已确认纳入）

| 项 | 子任务 |
|---|---|
| P1 轮询改事件驱动 + 低功耗模式 | core-extraction（事件源与 daemon 推送）、shell-foundation（低功耗）、terminal-native、workspace-features、settings-panels |
| P2 统一 SQLite 连接池 | core-extraction |
| P3 终端零拷贝管线 | core-extraction（`ws_ack_bytes_v1`）、terminal-native |
| P4 Git 增量刷新 | workspace-features |
| P5 共享 watcher + 增量尾读 | poc-gates（核实现状）、workspace-features |
| P6 启动懒加载 | shell-foundation |
| P7 mimalloc（release profile 已优化，沿用） | poc-gates（测量）、shell-foundation |
| P8 WebView2Loader 延迟加载 | rich-content-host |

P9–P12 暂缓。

## 验证命令汇总

```bash
cargo check --workspace
cargo test --workspace
cargo deny check licenses bans            # 子任务 0 引入配置，子任务 1 并入根 workspace
npx tsc --noEmit                          # Tauri 版仍在时必跑
cd src-tauri && cargo test                # Tauri 适配层回归
npm run tauri dev                         # Tauri 版冒烟
cargo run -p cli-manager-desktop-gpui     # GPUI 版启动（子任务 2 起）
node scripts/bench/run-baseline.mjs       # 性能基准（子任务 0 建立）
```

## 文档与规约产出（各子任务收尾时写入 spec）

- `.trellis/spec/backend/core-crate-contracts.md`：EventSink/AppPaths/UiServices/AppContext、事件映射表、Repository 约定、连接池规则。
- `.trellis/spec/backend/pty-daemon-contracts.md`：新增 `ws_ack_bytes_v1`、原生客户端鉴权、`checkpoint_ansi_v1`、`session_status` 推送条款。
- `.trellis/spec/frontend/` 新增 `gpui-*` 规约：状态模型与线程规则、启动时序、退出守卫（引用 background-task-continuation-contracts）、PreviewHost 降级矩阵与 Airspace、IME、ui_kit 使用约定。
- `.trellis/spec/guides/fix-triage-guide.md` §5：加入“WebView 可用性 / 预览类型 / DPI / 输入法 / 双壳共存 / GPU”维度。
- 项目根 `CLAUDE.md` / `AGENTS.md`：在 core 抽取与 GPUI 壳落地后更新架构描述（目前描述的 Hook server 位置已过时：Hook 端口实际由 daemon 绑定）。
