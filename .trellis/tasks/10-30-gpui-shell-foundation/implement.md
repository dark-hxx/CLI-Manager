# 实施步骤：GPUI 桌面壳骨架

> 先读：本目录 `prd.md`、`design.md`；父 `design.md` §4；core-extraction 的 `core-crate-contracts.md`；poc-gates 的 `research/poc-results.md`（gpui-component patch 方案、标题栏、mimalloc 结论）。
> 前置：只读 Git 同步检查；修改根 `Cargo.toml` members 前跑 `detect_changes` 基线。新增代码为主，对 core 的改动需先 `impact`。

## 步骤

| # | 步骤 | 验证 | 估时 |
|---|---|---|---|
| 1 | 创建 `apps/desktop-gpui`，加入根 workspace；按 M0 结论配置 gpui-pre 与 gpui-component patch；`main.rs` 打开空窗口 | `cargo run -p cli-manager-desktop-gpui` | 1 d |
| 2 | tokio runtime、`AppContext` 装配（NativePaths、GpuiEventSink、GpuiUiServices：rfd 对话框、arboard 剪贴板、opener） | 单测：事件通道路由；手动：对话框 | 2 d |
| 3 | `Services` global、`run_io` 封装、主线程耗时告警 | 单测 | 1 d |
| 4 | `ui_kit` 第一批组件（Button/Input/Select/Dialog/Menu/Toast/Tooltip/Tabs/Resizable/ScrollArea/VirtualList/Tree）+ 禁止直接 use gpui-component 的检查 | 组件 gallery 视图（debug 构建菜单打开） | 4 d |
| 5 | 主题：`scripts/export-theme-tokens.mjs` → `theme/tokens.rs`；明暗/跟随系统/强调色 | 与 Tauri 版截图对比 | 2 d |
| 6 | i18n：`scripts/export-i18n.mjs`、`t!` 宏、简繁转换选型与对照测试、CI 同步检查 | 单测 + 切换语言手测 | 2 d |
| 7 | 图标：lucide/lobehub SVG 导出脚本与 `Icon` 组件 | gallery | 1 d |
| 8 | 窗口与自绘标题栏（拖动、双击、Snap Layouts、窗口状态记忆）、build.rs 资源与 manifest | Win10/Win11、DPI 100/150/200 | 2 d |
| 9 | SettingsModel / UiModel / ProjectModel（只读树）+ 其余模型骨架与事件路由占位 | 单测：偏好未知字段往返 | 3 d |
| 10 | 启动时序（design §3），首帧前耗时埋点；daemon 后台连接与状态栏提示 | 冷启动测量；杀掉 daemon 可执行文件验证降级提示 | 2 d |
| 11 | Keymap：动作清单导出、快捷键格式双向转换、命令面板 | 与 Tauri 版快捷键配置互读 | 3 d |
| 12 | CloseCoordinator UI（closeBehavior：托盘/询问/退出；退出调用 ExitCoordinator 占位） | 手测 | 1 d |
| 13 | LowPowerController 与订阅接口 | 最小化后用 Process Explorer 观察 CPU/唤醒 | 1 d |
| 14 | P6：FontCatalog 懒加载，替换 core 中 `statusline`/`system::fonts` 的两处 `load_system_fonts()`（Tauri 版也受益，需 impact） | 启动路径无字体枚举（日志验证） | 1 d |
| 15 | P7：mimalloc（按 M0 结论）；确认根 workspace release profile 生效 | 体积/启动对比记录 | 0.5 d |
| 16 | 日志与 panic hook、异常退出提示 | 人为 panic 验证 crash 日志与重启提示 | 1 d |
| 17 | 测量冷启动、空闲内存、进程树，写入父 `research/gpui-shell-metrics.md` | 与 baseline 对比 | 1 d |

总估时约 6 人周。

## 验证命令

```bash
cargo check --workspace && cargo test --workspace
cargo run -p cli-manager-desktop-gpui
node scripts/export-i18n.mjs --check && node scripts/export-theme-tokens.mjs --check
npx tsc --noEmit            # 确认未影响前端
cd src-tauri && cargo test  # 字体缓存改动影响 Tauri 版
```

## 完成标准

- prd 全部验收项勾选；spec 新增 `.trellis/spec/frontend/gpui-shell-contracts.md`（线程规则、run_io、事件路由、启动时序、ui_kit 约定、低功耗订阅接口）。
- CHANGELOG 记录（内部预览，不对用户发布）。

## 回退

GPUI 壳是新增 crate，不影响 Tauri 版；唯一共享改动是 FontCatalog（第 14 步），单独提交，可单独 revert。
