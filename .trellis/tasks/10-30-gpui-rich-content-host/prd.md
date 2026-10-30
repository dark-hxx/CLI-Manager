# 预览按需嵌入系统 WebView（PreviewHost）+ 原生 Markdown / 编辑器

> 父任务：`.trellis/tasks/10-30-gpui-native-migration`（先读其 `prd.md`、`design.md`、`implement.md`）。
> 已确认约束：`gpui-pre 0.3`（Zed 2026-09 快照）、GPU 原生渲染、界面单进程（保留 PTY daemon 与 web-daemon，见父 design §0.1）、仅预览（Markdown 文件 / HTML / PDF）按需嵌入系统 WebView。
> 详细设计见本目录 `design.md`，执行步骤见 `implement.md`。

## 目标
1. 实现 `crates/preview`：**只为预览**（Markdown 文件预览、HTML / Live Server 预览、PDF 预览）按需创建系统 WebView，关闭或闲置后回收；WebView 缺失、过旧、失败或被禁用时降级为原生渲染，或给出提示与操作入口。
2. 提供两个原生组件作为非 WebView 路径：原生 Markdown 渲染器（历史转录、提示词、About，以及 Markdown 预览的降级路径）、原生代码编辑器（替代全部 Monaco 使用点）。

## 依赖
`gpui-shell-foundation`。可与 `gpui-terminal-native` 并行。

## 范围
父 design §6 全部内容。PDF 预览是新增能力。

## 约束
- 除三类预览外，任何场景都不得创建 WebView。
- 禁止静默下载或安装 WebView2。
- 不为 Markdown 预览/静态 HTML/PDF 启本地 HTTP 端口（Live Server 沿用现有本地服务）；自定义协议 + CSP + 消息白名单；本地资源按项目根白名单读取。
- Monaco 不再使用；原生编辑器不足时在 `ui_kit` 内补齐。

## 验收标准
- [ ] 6 种可用性状态（可用 / 未安装 / 过旧 / 创建失败 / 用户禁用 / 平台不支持）× 3 类预览的行为矩阵全部手动验证并记录截图：Markdown 降级为原生渲染（公式显示为源码块并提示）、HTML 显示源码并可外部打开、PDF 提供“用默认应用打开”。
- [ ] 不打开预览时进程树中没有 WebView 进程；首次打开预览 600 ms 内先显示原生内容；复用切换 ≤ 100 ms；关闭预览后 60 s 内 WebView 进程退出。
- [ ] DPI 100% / 150% / 200% 以及跨不同 DPI 显示器拖动时，预览边界与缩放正确。
- [ ] 打开菜单、弹窗、Toast 时 WebView 不遮挡 GPUI 浮层；最小化/托盘恢复后预览状态正确。
- [ ] 预览获得焦点时全局快捷键仍有效；Alt+Tab 返回后焦点正确。
- [ ] 外部链接一律用系统浏览器打开；预览内无法导航到外部 URL；无法读取项目根白名单之外的文件。
- [ ] 原生编辑器：1 MB 文件打开流畅，tree-sitter 高亮、撤销/重做、查找替换、中文 IME 可用；JSON 编辑有校验提示；冲突三栏视图可用。
- [ ] 原生 Markdown：GFM 表格、任务列表、代码块高亮、链接、本地图片在历史转录中正确显示。

## 性能优化（P8）
详见父任务 `research/perf-opportunities.md`。
- [ ] P8：`WebView2Loader.dll` 与 WebView 相关代码只在第一次打开预览时加载（delay-load 链接，或通过 `webview2-com` 动态加载）。
- [ ] P8：验收方式：不打开预览时，用 Process Explorer 或 `ListDLLs` 查看进程模块列表，其中没有 WebView2Loader.dll。
