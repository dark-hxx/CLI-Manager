# 设置 / 扩展 / Provider / 同步 / SSH / 提示词 / 统计

> 父任务：`.trellis/tasks/10-30-gpui-native-migration`（先读其 `prd.md`、`design.md`、`implement.md`）。
> 已确认约束：`gpui-pre 0.3`（Zed 2026-09 快照）、GPU 原生渲染、界面单进程（保留 PTY daemon 与 web-daemon，见父 design §0.1）、仅预览（Markdown 文件 / HTML / PDF）按需嵌入系统 WebView。
> 详细设计见本目录 `design.md`，执行步骤见 `implement.md`。

## 目标
在 GPUI 中对齐其余面板：设置各页（含“预览渲染”状态区）、扩展（MCP/Skills）、Provider/路由/快速切换、WebDAV 同步、SSH/远程、提示词/模板、统计（原生图表、请求日志、热力图）。

## 依赖
`gpui-shell-foundation`、`gpui-rich-content-host`（原生编辑器、原生 Markdown）。可与 `gpui-workspace-features` 并行。

## 范围
对应 `src/features/{settings,extensions,providers,sync,remote,prompts,stats,agents}`。表单类直接用 gpui-component；JSON/代码编辑用原生编辑器；图表原生自绘；二维码用 `qrcode` crate；统计截图导出用 GPUI 离屏渲染（PoC 不通过时隐藏该按钮）。

## 验收标准
- [ ] 每个面板对照父 design §9 逐项勾选对齐。
- [ ] 所有设置写回共用的偏好文件，Tauri 版读取结果一致（含未知字段保留）。
- [ ] Hook 安装/卸载、Provider 切换、同步冲突提示（不静默覆盖）行为与 Tauri 版一致。
- [ ] 统计页在 30 天数据量下渲染流畅。
- [ ] 文件对话框（rfd）、外部打开（opener）在 Windows/macOS 上可用。
- [ ] 所有面板均不创建 WebView。

## 性能优化（P1 面板侧）
详见父任务 `research/perf-opportunities.md`。
- [ ] P1：统计面板由 Hook 上报事件触发刷新（`TerminalStatsPanel.tsx:565` 的 5 s / 2 s 轮询只保留为兜底，且仅在面板可见时运行）。
- [ ] P1：请求日志由路由层写入事件驱动（删除 `App.tsx:748` 的 60 s 轮询）。
- [ ] P1：系统资源只在面板可见时采样，窗口不可见时暂停（`useSystemResources.ts:137`）。
- [ ] P1：Hook 状态、Provider 故障转移、Web 服务状态等设置页的轮询改为事件或手动刷新，仅在页面可见时运行。
