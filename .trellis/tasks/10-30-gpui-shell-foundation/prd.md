# GPUI 桌面壳骨架

> 父任务：`.trellis/tasks/10-30-gpui-native-migration`（先读其 `prd.md`、`design.md`、`implement.md`）。
> 已确认约束：`gpui-pre 0.3`（Zed 2026-09 快照）、GPU 原生渲染、界面单进程（保留 PTY daemon 与 web-daemon，见父 design §0.1）、仅预览（Markdown 文件 / HTML / PDF）按需嵌入系统 WebView。
> 详细设计见本目录 `design.md`，执行步骤见 `implement.md`。

## 目标
建立可启动的 `apps/desktop-gpui`：主窗口、自绘标题栏、主题、i18n、图标、Keymap、命令面板、状态模型、启动时序、进程内长期服务装配、daemon 连接与关闭行为的 UI 部分。

## 依赖
`gpui-core-extraction` 完成。

## 范围
父 design §4、父 implement §2。依赖 `gpui = { package = "gpui-pre", version = "=0.3.x" }`；`ui_kit` 薄封装层隔离 gpui-component API；i18n 字典导出脚本（React 与 GPUI 共用同一源字典）。

## 验收标准
- [ ] `cargo run -p cli-manager-desktop-gpui` 能启动，显示侧栏、空工作区与标题栏；Windows 支持 Snap Layouts、拖动、双击最大化。
- [ ] 切换主题、语言（简体/繁体/英文）即时生效，写回共用的 `settings.json`，不丢失未知字段。
- [ ] 命令面板与快捷键可用，快捷键配置与 Tauri 版共用。
- [ ] 不打开预览时，进程树中只有 `cli-manager-gpui`、`cli-manager-daemon`（首帧后后台连接或拉起）及其 shell 子进程，启用 Web 服务时另有 web-daemon；没有 msedgewebview2。
- [ ] daemon 连接在首帧之后的后台任务中完成，失败不阻塞 UI，只让终端创建明确失败并提示；Hook 通知经 DaemonClient 转发到 GPUI。
- [ ] 文件/Git watcher、历史索引、自动同步在进程内启动，首帧之后才执行延迟任务。
- [ ] 冷启动与空闲内存首测数据记录在父任务 `research/` 中，并与基线对比。

## 性能优化（P1 低功耗模式、P6、P7）
详见父任务 `research/perf-opportunities.md`。
- [ ] P1：窗口失焦、最小化或隐藏到托盘时进入低功耗模式：停止光标闪烁与动画、暂停系统资源采样与 statusline 刷新、合并重绘；恢复后立即刷新一次。
- [ ] P6：首帧前只做三件事：读偏好、打开主库、加载项目树。daemon 连接、历史索引、定价同步、ccusage 缓存、WebDAV 自动同步、更新检查都在首帧之后进行。
- [ ] P6：`statusline/mod.rs` 与 `system/fonts.rs` 的 `load_system_fonts()` 合并为全局懒加载缓存（优先复用 GPUI 文字系统的字体信息）；启动路径上不触发字体全量枚举。
- [ ] P6：i18n 只加载当前语言。
- [ ] P7：全局分配器使用 `mimalloc`（以 poc-gates 测量结果为准）；release profile 沿用现有 `lto = "fat"`、`codegen-units = 1`、`strip = "symbols"`、`panic = "abort"`（已在 src-tauri 中配置，迁到根 workspace 统一管理）。
