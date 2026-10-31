# Windows 窗口隔离实验

## 范围与场景

新增 `poc-compat` 包下的 `poc-window` binary，workspace 保持七成员，不改生产代码。M0 implement 已豁免独立 PoC 的生产图 impact。

| 场景 | 实施与验证要求 |
|---|---|
| 主窗口 | 自绘标题栏、原生 Drag/Max/Min/Close 命中区，最小化/恢复、最大化/还原、关闭 |
| 副窗口 | 透明背景、置顶、无边框、toolwindow，点击/拖动；跨屏 DPI 留待验证 |
| 托盘 | 显示主窗口、隐藏主窗口、退出；正常退出删除图标，关闭副窗口不退出主窗口 |
| 单实例 | 独立 namespace 的命名 mutex 与 WM_COPYDATA；第二进程退出、首进程收参并恢复；并发初始化等待有界 |
| 边界 | 最小化/隐藏时转发、Unicode 参数、非法 payload、接收端退出、清理后重启 |
| 语言 | POC_LANG=zh-CN/en-US；所有 PoC 可见标签双语 |

## 发现与契约

- GPUI 0.3.10 `WindowControlArea` 经 Windows hit test 映射为 HTCAPTION/HTMAXBUTTON/HTMINBUTTON/HTCLOSE；Snap 菜单与系统鼠标交互必须另行实测，不能据映射声明验收。
- 生产锁定 tauri-plugin-single-instance 2.4.2，官方 crate SHA-256 与生产 Cargo.lock 一致：`5c8f29386f5e9fdc699182388a33ee80a56de436d91b67459e86afef426282af`。Windows 源码附件 `bench/results/single-instance-2.4.2-windows.rs` 哈希 `13c072e37deca1c69e56e9eaf5884bfc3a0fb9998633e10e12ad1d9d543542d8`。
- 其协议是 `<id>-sim` mutex、`<id>-sic` 类、`<id>-siw` 隐藏窗口，dwData=1542，UTF-8 `cwd|argv...\0`；参数中的 `|` 无转义。PoC 拒绝含该分隔符的参数，保留兼容边界，不修改生产协议。
- PoC 只接受 `com.cli-manager.gpui-poc.` 前缀的 namespace，不向 `com.cli-manager.app` 发送消息，不以隔离双进程实验代替真实 Tauri↔GPUI 互认。
- 窗口/托盘与单实例接收窗口同属 GPUI UI 线程；回调只入队，GPUI 定时取队列后恢复窗口或退出；原生资源由 RAII 清理。

## 结果

实施与验证进行中；macOS 暂缓。此实验不关闭 M0。
