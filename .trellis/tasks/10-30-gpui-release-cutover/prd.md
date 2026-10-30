# 性能验收、双轨发布与 Tauri 下线
> 父任务：`.trellis/tasks/10-30-gpui-native-migration`（先读其 `prd.md`、`design.md`、`implement.md`）。
> 已确认约束：`gpui-pre 0.3`、GPU 原生渲染、界面单进程（保留 PTY daemon 与 web-daemon，见父 design §0.1）、仅预览（Markdown 文件 / HTML / PDF）按需嵌入系统 WebView。
> 详细设计见本目录 `design.md`，执行步骤见 `implement.md`。

## 目标
完成整体验收与发布切换。

## 依赖
`gpui-workspace-features`、`gpui-settings-panels`、`gpui-desktop-integration` 全部完成。

## 范围
- 性能验收报告（对照 `research/baseline.md`，满足父 prd 的性能目标表）。
- 场景矩阵（父 prd）全量回归记录。
- 数据往返测试：Tauri → GPUI → Tauri。
- 双轨发布：GPUI 通道 opt-in → 默认切换 → Tauri 下线；发布说明写明界面单进程、daemon 与 web-daemon 的保留理由，以及跨壳 attach 的行为。
- 下线清单：`src-tauri` 命令适配层、`src/` React 桌面代码、Tauri 配置与 capability 的移除步骤；daemon / web-daemon / codex-proxy 二进制保留（已由 `src-tauri/helpers` crate 构建，下线时整体迁到 `apps/helpers`）；签名器替换 `tauri signer` 且密钥不变；保留 `apps/web*` 与 `apps/server`。
- 更新 `README*`、`docs/功能清单.md`、`CHANGELOG.md`。

## 验收标准
- [ ] 性能目标表全部达标，基准脚本可复现。
- [ ] 场景矩阵每个维度都有通过记录。
- [ ] 至少一个正式版本的双轨期，GPUI 版的崩溃与问题反馈不高于 Tauri 版。
- [ ] 下线 PR 前，GitNexus `detect_changes --scope compare` 审查通过。

## 性能优化验收（P1–P8）
详见父任务 `research/perf-opportunities.md`。
- [ ] P1：GPUI 版空闲 10 分钟（窗口在前台但无操作 / 最小化到托盘两种情况）的 CPU 唤醒次数与 CPU 占用，对比 Tauri 基线并记录。
- [ ] P2–P8：逐项引用各子任务的验收记录，汇总进性能验收报告。
