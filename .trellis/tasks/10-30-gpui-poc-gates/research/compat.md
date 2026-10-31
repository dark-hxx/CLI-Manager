# 编译兼容性进度（2026-10-30）

结论：Windows MSVC release 编译通过，平台窗口创建与自动退出通过；macOS 没有可用环境，尚未验证。M0 检查点 A 未关闭，不放行 M1。

## 固定输入

| 包 | 锁定版本 | 用途 |
|---|---|---|
| gpui-pre | 0.3.10 | GPUI 核心 |
| gpui-pre-platform | 0.3.10 | 真实平台实现；启用 font-kit / wayland / x11 |
| gpui-component | 0.8.1 | 原生组件 |
| wry | 0.57.1 | 预览宿主 |
| alacritty_terminal | 0.26.0 | 终端内核 |
| tokio-tungstenite | 0.30.0 | daemon 客户端 |
| mimalloc / libmimalloc-sys | 0.1.52 / 0.1.49 | 仅 poc-term 的 P7 可选 feature，默认不启用 |

工程：`spikes/gpui-poc` 独立 workspace，锁文件不影响产品。
发布包元数据中的 GPUI 快照 rev 为 `08cbb88a152c3751a43e853425a70e9f631a5918`。
本机 rustc 1.99.0（b940084d7，2026-09-28），Windows x86_64 MSVC，LLVM 23.1.1。

## 实测与边界

- 初始五库 release 构建通过，Cargo 报告 3m15s；该入口为空，不作为窗口或完整链接证据。
- 加入 `gpui-pre-platform` 后 release 构建通过，Cargo 报告 2m03s。
- 加入实际平台入口及 Render 后 release 构建通过，Cargo 报告 1m07s；增量构建时间不能作为冷构建基准。
- `poc-compat --smoke` 创建窗口后 5 秒触发退出，stdout 有 `window opened`、`smoke timer completed`，进程退出码 0。使用正常窗口启动后，中英文均取得窗口截图并人工核对文本与背景；原始关键帧位于 `spikes/gpui-poc/research/poc-media/window-zh-CN.png`、`window-en-US.png`（本地附件）。
- 工具根因记录：隐藏启动继承了 Windows 的隐藏显示状态，导致 GPUI 已创建窗口但无法取得可见窗口；`App::activate` 在 Windows 平台为空实现，不能靠它恢复。截图脚本对这个交互式待测窗口使用正常启动，并按 PID 枚举 HWND；后台辅助仍保持隐藏。Windows PowerShell 另需预先保持 Process.Handle，才能可靠取得进程退出码。
- macOS：用户确认目前没有主机或 runner，未执行编译。Windows 交叉检查不能代替 macOS SDK 链接和 Metal 运行验证。
- 仓库 `.github/workflows/release.yml` 虽声明 `macos-14` / `aarch64-apple-darwin`，但它是产品发布流程，不构建隔离 PoC；配置存在不能证明当前有可用的 PoC runner 或本锁文件编译证据。本次未触发发布、推送代码或把 PoC 接入产品 CI。恢复时需要实际 macOS 主机，或经授权的独立 PoC CI 执行环境。
- 七成员 workspace 已执行 `cargo build --release --offline --locked --jobs 2 --workspace`，退出 0（4m10s，非冷构建）；Input/Editor、daemon 原生客户端、alacritty 单色终端和 wry child WebView 已实际实例化。运行时边界及失败见 windows-runtime.md / checkpoint.md；实例化不等于完整功能验收。

## 对原设计的修正

`gpui-component 0.8.1` 已直接依赖 `gpui-pre 0.3.10`，当前无需 `[patch]`、fork 或适配代码。实际修改行数 0。父任务 D5 应按锁定版本记录，后续升级重新验证。

GPUI 0.3.10 的平台实现已拆包，仅依赖核心与组件不足以验证 Windows renderer。实际入口是 `gpui_platform::application()`。macOS 使用 font-kit 文字系统，必须保留该 feature；Linux 的 x11 / wayland 只是为后续可移植性保留，本次不声称测试通过。

## 重复依赖

Windows 目标的反向依赖树确认：GPUI、gpui-component、gpui-pre-windows 与 wry 解析到同一个 `raw-window-handle 0.6.2`。这解决版本口径核查，不代表 WebView 的父子窗口、焦点或 DPI 行为已通过。

Windows 重复版本包含 `windows 0.58.0`（gpui-base/component）与 `0.62.2`（gpui-pre/windows、accesskit、wry/webview2-com）、resvg/usvg 0.45.1 与 0.46.0、png 0.17/0.18、rand 0.8/0.9/0.10、syn 2/3。当前可编译共存，未强制 patch 合并；树输出也可能重复显示同版本的 host/target feature 单元，条目数不等于冲突数。复现：

```powershell
cargo tree --locked --manifest-path spikes/gpui-poc/Cargo.toml --target x86_64-pc-windows-msvc --invert raw-window-handle
cargo tree --locked --manifest-path spikes/gpui-poc/Cargo.toml --target x86_64-pc-windows-msvc --duplicates --depth 1
```

`cargo deny check licenses bans` 退出 0，bans 有 75 项重复依赖警告（非 75 个错误），没有强行通过 patch 合并不同主版本。完整锁定声明含 897 包，其中 890 个外部包及 7 个本地成员（加入 P7 可选分配器前的检查快照）；包含非当前平台的解析依赖。紧凑检查结果见 `spikes/gpui-poc/research/deny-summary.json`。

## 复现

加入 P7 后，`poc-term` 的默认与 `allocator-mimalloc` 两种 release 构建均通过，详见 allocator.md。默认声明图仍为 897 包；显式分配器 feature 为 899 包，独立 deny 检查通过，不将默认图审核冒充可选 feature 结论。

```powershell
cargo build --release --offline --locked --jobs 2 --workspace --manifest-path spikes/gpui-poc/Cargo.toml
spikes/gpui-poc/target/release/poc-compat.exe --smoke
# 默认只打印用法；--window 保持窗口，关闭最后窗口退出。
$env:POC_LANG = 'en-US'
spikes/gpui-poc/target/release/poc-compat.exe --smoke
```

待补：macOS 同锁文件构建和原生窗口截图（用户暂缓，不阻塞 Windows）；组件、终端、WebView 的剩余行为场景，详见 windows-runtime.md。中英文静态文字显示不替代 IME 与性能门禁。
