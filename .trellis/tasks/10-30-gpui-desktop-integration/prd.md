# 托盘 / 单实例 / 更新 / 通知 / 桌宠 / Web 设备 / 打包

> 父任务：`.trellis/tasks/10-30-gpui-native-migration`（先读其 `prd.md`、`design.md`、`implement.md`）。
> 已确认约束：`gpui-pre 0.3`（Zed 2026-09 快照）、GPU 原生渲染、界面单进程（保留 PTY daemon 与 web-daemon，见父 design §0.1）、仅预览（Markdown 文件 / HTML / PDF）按需嵌入系统 WebView。
> 详细设计见本目录 `design.md`，执行步骤见 `implement.md`。

## 目标
补齐 GPUI 版的系统集成与发布能力。

## 依赖
`gpui-shell-foundation`、`gpui-terminal-native`（退出守卫、open-terminal）。

## 范围
父 design §4.3、§7、§8：
- 托盘与退出守卫。
- 单实例与参数转发：与 Tauri 版共用同一互斥，两个壳不同时运行；共用同一 daemon，后台会话可跨壳 attach。
- 通知与通知动作。
- 桌宠：同进程内第二个窗口（透明/置顶/不进任务栏）。
- Web 服务与 Web 设备：web-daemon 进程保留（权限隔离）；GPUI 主进程通过 loopback NDJSON 与其通信，设备 Operation 在主进程内直接调用 core 执行（取代 `useWebDeviceBridge.ts`）。
- 更新器：minisign + `latest.json` 通道；有运行中会话时沿用 Tauri 版规则（转入后台后更新 / 结束会话后更新 / 取消），daemon 二进制只在空闲时替换。
- NSIS 打包：GPUI 主程序、daemon、web-daemon、codex-proxy、Hook 上报端、conpty sideload；Explorer 右键。

## 验收标准
- [ ] 托盘：显示/退出；最小化到托盘后，从托盘或再次启动 exe 都能恢复窗口。
- [ ] Explorer 右键“在 CLI-Manager 中打开”：应用未运行、已运行、已最小化到托盘三种情况都能打开终端。
- [ ] Tauri 版与 GPUI 版同时安装时，不会出现两个壳同时运行；一方转入后台的会话可在另一方的后台任务列表中 attach。
- [ ] 通知点击能跳转到对应会话（窗口未聚焦 / 最小化 / 托盘三种状态）。
- [ ] 更新：minisign 校验失败时拒绝安装；有运行中会话时先询问，选择“转入后台后更新”时会话在更新后仍可 attach；签名正确时可以升级并重启。
- [ ] Web 设备的各类 Operation 在 GPUI 版中执行结果与 Tauri 版一致；web-daemon 的权限边界不变（不获得文件系统操作能力）；Web 服务关闭时不运行 web-daemon。
- [ ] 桌宠在 Windows 上透明、置顶、可拖动；平台不支持时降级说明写入文档。
