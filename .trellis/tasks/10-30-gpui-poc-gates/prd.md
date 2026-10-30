# M0：许可证审查与关键 PoC 门禁

> 父任务：`.trellis/tasks/10-30-gpui-native-migration`（先读其 `prd.md`、`design.md`、`implement.md`）。
> 已确认约束：`gpui-pre 0.3`（Zed 2026-09 快照）、GPU 原生渲染、界面单进程（保留 PTY daemon 与 web-daemon，见父 design §0.1）、仅预览（Markdown 文件 / HTML / PDF）按需嵌入系统 WebView。
> 详细设计见本目录 `design.md`，执行步骤见 `implement.md`。

## 目标
在投入大规模迁移之前，用最小代价验证会决定成败的硬门槛，并给出 Go/No-Go 结论。

## 依赖
无，必须第一个执行。

## 范围
独立的 `spikes/gpui-poc` workspace（不并入主构建与根 workspace，结论产出后归档），完成本目录 `implement.md` 的全部条目。

## 验收标准
- [ ] `research/compat.md`：`gpui-pre 0.3` 与 gpui-component、wry、alacritty_terminal、tokio-tungstenite 能否一起编译；所需 `[patch]` 或 fork 清单。
- [ ] `research/license-audit.md`：完整传递依赖许可证清单，以及是否存在 GPL-only 依赖的结论。
- [ ] `research/baseline.md`：Tauri 版冷启动、空闲内存（含 WebView2 子进程与 daemon）、常驻进程数、`cat` 100 MB 吞吐、键入延迟 p95、8 分屏帧率；写明测量方法与机器配置。
- [ ] `research/poc-results.md`：IME、daemon 客户端终端渲染、ANSI checkpoint 往返、原生代码编辑器、预览 WebView（Markdown/HTML/PDF，含 Airspace/焦点/DPI/最小化/回收）、WebView2 缺失探测、透明置顶窗口与托盘、自绘标题栏、单实例互斥互认，逐项给出 通过/有条件通过/失败。
- [ ] 若有失败项，给出对父 design.md 的修订建议或 No-Go 结论。
- [ ] 不修改 `src/`、`src-tauri/` 的任何生产代码（PoC 用 daemon 二进制只读复用；协议扩展只在 PoC 中以本地补丁验证，不提交）。

## 硬门槛（任一失败即 No-Go）
gpui-pre 0.3 与必要组件无法编译且无可行补丁；存在 GPL-only 依赖且无替代；Windows 中文 IME 无法组合上屏；8 分屏滚动 < 60 fps 且没有明确的优化路径。

## 性能优化前置验证（P5、P7）
详见父任务 `research/perf-opportunities.md`。
- [ ] P7：在 PoC 中对比系统默认分配器与 `mimalloc`（终端吞吐、启动时间、内存峰值、二进制体积），结果写入 `research/poc-results.md`。现有 release profile 已是 `lto="fat"` + `codegen-units=1` + `strip` + `panic="abort"`，不再重复对比。
- [ ] P5：核实 `src-tauri/src/features/history/scan_state.rs` 是否已记录各 JSONL 文件的读取偏移；写明增量尾读需要补哪些能力。
