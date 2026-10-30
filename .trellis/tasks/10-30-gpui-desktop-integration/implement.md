# 实施步骤：桌面集成

> 先读：本目录 `prd.md`、`design.md`；`src-tauri/src/lib.rs`（单实例、托盘、setup）、`features/open_terminal.rs`、`features/notifications/`、`features/desktop-pet/`、`installer/{hooks.nsh,cleanup.ps1}`、`scripts/{prepare-bundle-binaries,prepare-helper-binaries,package-portable}.*`、`src/features/settings/api/updateStore.ts`。
> 前置：只读 Git 同步检查；改 core 中被 Tauri 版共用的函数（open_terminal、notifications、web operations、logging）前跑 GitNexus `impact`，Tauri 版回归。

## 步骤

| # | 步骤 | 验证 | 估时 |
|---|---|---|---|
| 1 | 调研记录：`research/single-instance-protocol.md`（插件 Windows 实现逐字段）、`research/installer-choice.md`（cargo-packager vs 自维护 nsi，对 hooks.nsh 兼容性） | 评审 | 2 d |
| 2 | 单实例：`platform/single_instance.rs` + 参数处理复用 core `open_terminal` | Tauri↔GPUI 双向转发；菜单入口；单测迁移 | 4 d |
| 3 | 托盘 + 关闭行为，对接 ExitCoordinator 与 LowPowerController | 三种 closeBehavior × 任务矩阵 | 3 d |
| 4 | 系统通知：核对 core 实现，必要时抽 `NotificationSink`；AUMID；动作按钮冷启动链路 | 场景表 | 4 d |
| 5 | 桌宠窗口：窗口样式、精灵渲染、拖拽/菜单/状态；迁移 `desktopPet*.test.mjs` 用例为 Rust 单测 | 多 DPI、多显示器 | 1.5 周 |
| 6 | Web 服务：WebDaemonManager 接入；Operation 执行走 core dispatch；UiCommand 通道 | 设备端实测；主窗口隐藏时执行 | 1 周 |
| 7 | 其他桌面能力：剪贴板图片、文件对话框、外部打开、拖放、自启、日志初始化、崩溃报告 | 逐项手测 | 3 d |
| 8 | 更新器：core `update`（manifest、minisign、下载、启动安装器）；会话确认框；distribution 判定 | 镜像失败回落；签名篡改拒绝；有会话确认 | 1 周 |
| 9 | 打包：`scripts/package-gpui.mjs`（staging、helpers、web dist、conpty、ssh-agent、许可证、NSIS、.sig、latest.json 片段） | 产物清单与 Tauri 版对比 | 1 周 |
| 10 | 安装器：hooks.nsh 参数化主程序名；cleanup.ps1 新增 `cli-manager-gpui.exe`；预览版独立产品配置 | 安装/覆盖/卸载/从 Tauri 升级/回退 | 4 d |
| 11 | 共享 daemon 规则：版本/capabilities 校验、旧 daemon 替换策略（无会话才替换） | Tauri 版 daemon 运行中启动 GPUI；反之 | 2 d |
| 12 | CI：release workflow 增加 GPUI 构建与签名产物（双轨期不进入默认 latest 键） | 草稿 Release 实测 | 3 d |
| 12b | macOS / Linux：单实例、托盘、通知、桌宠、更新、打包（design §11），CI 矩阵四平台产出 GPUI 预览包 | 各平台手测清单 | 2 周 |
| 13 | spec：`.trellis/spec/backend/desktop-integration-contracts.md`（单实例协议、参数、更新 manifest 键、安装器路径清单、共享 daemon 规则）；CHANGELOG | — | 1 d |

总估时约 10–11 人周（含 macOS/Linux 约 2 周）。

## 验证命令

```bash
cargo test --workspace
cd src-tauri && cargo test
node --test scripts/*.test.mjs        # 安装/打包相关脚本测试（含 prepare-helper-binaries 若有）
node scripts/package-gpui.mjs --dry-run
cargo run -p cli-manager-desktop-gpui -- --open-terminal "C:\\work"
```

## 手动验收清单（Windows 11 / Windows 10 各一轮；macOS 14+ 与 Ubuntu 22.04 X11/Wayland 按 design §11 另列）
- [ ] 全新安装 GPUI 预览版，非管理员，安装目录含中文与空格。
- [ ] 已安装 Tauri 版运行中 → 安装 GPUI 预览版：安装器只停本目录进程；两版本不能同时成为主实例。
- [ ] 资源管理器“在此打开”→ 已运行实例新开终端。
- [ ] Toast 动作按钮在应用退出后点击 → 冷启动并执行动作。
- [ ] 托盘退出有运行任务 → 退出守卫提示。
- [ ] 更新：有后台会话时确认框；签名错误拒绝；安装完成后新 daemon 版本生效。
- [ ] 卸载后无残留进程、注册表菜单已删除、用户数据保留。

## 回退
各步骤独立提交；打包/安装器变更只影响 GPUI 预览产物，Tauri 发布链路不改（cleanup.ps1 的新增路径对 Tauri 版无副作用，单独提交并在 Tauri 安装包上回归）。
