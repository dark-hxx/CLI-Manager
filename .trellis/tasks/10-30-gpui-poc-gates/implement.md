# 实施步骤：M0 PoC 门禁

> 先读：本目录 `prd.md`、`design.md`；父任务 `design.md`、`research/*`。
> 前置：只读 Git 同步检查；本任务不改生产代码，无需 GitNexus impact，但提交前仍跑 `detect_changes` 确认未触及生产代码。

## 步骤

| # | 步骤 | 产出 | 估时 |
|---|---|---|---|
| 1 | 建立 `spikes/gpui-poc` 独立 workspace、`deny.toml`；在根目录 `.gitignore` 中忽略其 `target/` | 工程骨架 | 0.5 d |
| 2 | poc-compat：逐步加入 gpui-pre、gpui-component（patch/fork）、wry、alacritty_terminal、tokio-tungstenite，Windows + macOS 编译 | `research/compat.md` | 1–3 d |
| 3 | 许可证审查：`cargo deny check licenses bans`，脚本导出全量许可证表，人工复核 Zed 内部 crate | `research/license-audit.md` | 1 d |
| 4 | **硬门槛检查点 A**：步骤 2、3 任一失败 → 写 No-Go 结论并停止 | — | — |
| 5 | Tauri 基线测量（与步骤 6 起并行） | `research/baseline.md`、`bench/*` | 2 d |
| 6 | poc-ime | poc-results §IME | 2 d |
| 7 | poc-term：daemon 客户端最小实现 + TerminalElement + 测量 | poc-results §终端 | 4 d |
| 8 | **硬门槛检查点 B**：IME 或 8 分屏帧率失败且无优化路径 → No-Go | — | — |
| 9 | poc-checkpoint：xterm fixture 生成脚本 + alacritty 往返 | poc-results §checkpoint | 2 d |
| 10 | poc-editor | poc-results §编辑器 | 2 d |
| 11 | poc-preview（嵌入 vs 子窗口对比） | poc-results §预览 | 3 d |
| 12 | poc-webview-probe（含无 WebView2 虚拟机） | poc-results §探测 | 1 d |
| 13 | poc-window（标题栏、托盘、桌宠窗口、单实例互认） | poc-results §窗口 | 2 d |
| 14 | P7：同一 poc-term 分别用系统分配器与 mimalloc 构建，测吞吐/启动/内存峰值/体积 | poc-results §P7 | 0.5 d |
| 15 | P5：核实 history 扫描现状 | poc-results §P5 | 0.5 d |
| 16 | 汇总 Go/No-Go，更新父 design §11 风险表与 [PoC] 标注的结论 | `research/poc-results.md`、父 design 修订 | 1 d |

总估时约 4–5 人周（可两人并行压缩到约 3 周）。

## 验证

- `cd spikes/gpui-poc && cargo build --release`（Windows、macOS）。
- 每项 PoC 附运行截图或录屏路径（存放于 `research/poc-media/`，大文件不入库，只记录本地路径与关键帧）。
- `git status` 确认 `src/`、`src-tauri/` 无改动。

## 完成标准

- prd 中全部验收项勾选；`research/poc-results.md` 含 Go/No-Go 结论。
- 若 Go：父任务把 M0 标为完成，`gpui-core-extraction` 可以 `task.py start`。
- 若 No-Go：父任务与全部子任务标记为暂停，结论文档提交后停止。

## 回退

PoC 不影响产品代码，失败只需归档结论。
