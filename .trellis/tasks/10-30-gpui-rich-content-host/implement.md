# 实施步骤：PreviewHost + 原生 Markdown / 编辑器

> 先读：本目录 `prd.md`、`design.md`；父 `design.md` §6；poc-gates 的预览/探测/编辑器结论；`src/shared/ui/MarkdownContent.tsx`、`src/features/files/*`（预览入口与 Live Server）、`src/features/projects/components/conflicts/*`。
> 前置：只读 Git 同步检查；对 core 中 `live_server`、文件读取函数的改动先 `impact`。

## 步骤

| # | 步骤 | 验证 | 估时 |
|---|---|---|---|
| 1 | 原生 Markdown：解析层（后台线程）+ 块渲染 + 虚拟化 + 代码高亮 + 图片白名单 + 链接/锚点 | 单测（解析快照）；用 20 份真实转录做视觉对比 | 2 周 |
| 2 | tree-sitter 语言注册表与主题（编辑器/Markdown/Diff 共用），语言集合与 `refractor`/Monaco 现用语言对齐 | 单测 | 3 d |
| 3 | 原生编辑器封装 `ui_kit::CodeEditor`（M0 缺口补齐、编码/换行保留、大文件策略、JSON 校验） | 1 MB/10 MB 文件手测；单测：编码往返 | 2 周 |
| 4 | 冲突三栏视图 | 构造冲突仓库手测；单测：冲突标记解析/合并 | 1 周 |
| 5 | `crates/preview`：probe（动态加载 WebView2Loader）+ 熔断 + 缓存 | 无 WebView2 虚拟机、低版本、策略禁用三种环境 | 3 d |
| 6 | 宿主状态机 + Windows 平台实现（wry 子 WebView）+ macOS 实现 | 单测（状态机）；手测创建/复用/回收/超时 | 1 周 |
| 7 | 自定义协议：路由、根目录 token、路径规范化与逃逸防护、Range、denylist | 单测：`..`、符号链接、UNC、大小写、`.env` | 4 d |
| 8 | Markdown 预览页 bundle（`assets/markdown-preview`，构建脚本 `scripts/build-preview-assets.mjs`，产物入库）+ 桥接消息 + CSP | 手测公式/图片/锚点/主题切换 | 4 d |
| 9 | PreviewSlot：bounds/DPI 同步、OverlayRegistry 接入、截图占位、拖拽/缩放期间隐藏、最小化/托盘 | DPI 100/150/200 + 跨屏拖动；打开各类浮层 | 1 周 |
| 10 | 焦点与快捷键回传、Alt+Tab 焦点恢复 | 手测 | 2 d |
| 11 | 三类预览接入：Markdown、静态 HTML、Live Server、PDF；降级视图（HTML 源码、PDF 信息卡） | prd 6×3 矩阵 | 1 周 |
| 12 | 降级提示条、安装引导、设置数据接口（供 settings-panels） | 手测各状态文案 | 3 d |
| 13 | （按 M0 结论）独立子窗口宿主模式 | 手测 | 3 d |
| 14 | P8 验证与指标测量（design §9） | ListDLLs、日志 | 1 d |
| 15 | spec：`.trellis/spec/frontend/gpui-preview-contracts.md`（使用范围红线、降级矩阵、Airspace 规则、协议白名单、消息协议） | — | 1 d |

总估时约 10–11 人周（1–4 与 5–13 可两人并行）。

## 验证命令

```bash
cargo test -p cli-manager-preview
cargo test --workspace
cargo run -p cli-manager-desktop-gpui
node scripts/build-preview-assets.mjs --check
```

## 安全检查清单（提交前逐项确认）
- [ ] 协议处理器无法读出根目录外文件（含 `..`、`%2e%2e`、符号链接、硬链接、UNC、8.3 短名）。
- [ ] 外部 URL 无法在预览内导航；`window.open` 被外部打开。
- [ ] 消息协议拒绝未知 type 与超大 payload。
- [ ] release 构建无 DevTools。
- [ ] 不存在静默下载/安装 WebView2 的代码路径。

## 完成标准
prd 全部验收项勾选（含 6×3 矩阵截图记录）；CHANGELOG 与 `docs/功能清单.md`（PDF 预览为新增能力）更新。

## 回退
PreviewHost 失败时可整体走降级路径（配置强制 `DisabledByUser`），不阻塞其他子任务；原生 Markdown/编辑器是其他子任务的依赖，优先交付。
