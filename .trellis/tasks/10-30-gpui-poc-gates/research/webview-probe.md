# 独立 WebView2 探测与 P8（2026-10-30）

结论：Windows x64 隔离程序的动态 Loader 方案及外部模块三阶段观测通过，正常机器 API/注册表版本一致。缺失、低版本、策略禁用 VM 未测试，生产宿主尚未集成；M0 不据此放行。

## 实现与场景

`poc-webview-probe` 只依赖锁文件已有的 serde_json、windows-sys、winreg，不依赖 wry、webview2-com 或 GPUI。默认返回 NotProbed，不加载 DLL、不建 WebView。显式 `--probe --loader <绝对路径>` 才调用 LoadLibraryExW；搜索范围限制为 DLL 目录和 System32，GetProcAddress 解析版本 API，字符串由 CoTaskMemFree 释放，模块由 RAII 释放。加载器缺失、加载失败、导出缺失与 runtime 缺失分开记录。JSON 是诊断协议，非产品界面文案。

三处注册表读取为 `HKCU\Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}` 的 pv，以及同路径 HKLM 的 32/64 位视图。官方 64 位 Windows 的机器安装位置是 32 位视图，64 位视图为额外证据。注册表值不覆盖 API 失败。API 的预览通道字符串允许 beta/dev/canary；调用成功只标 AvailableCandidate，不承诺环境创建或策略允许。

默认 minimumMajor=1 只排除零版本，不代表产品最低版本要求。`--minimum-major` 是显式实验阈值；以超高阈值获得 OutdatedCandidate 仅验证分类，不能冒充旧 runtime 环境。读取用户/机器配置但不修改注册表、安装 runtime、创建浏览器或触发产品单实例。

场景：未请求探测、正常安装、加载器缺失/路径错误、API runtime 缺失或失败、版本阈值、注册表残留、预览通道、释放后模块、Windows 与不支持的平台。实际 VM 的缺失/旧版/企业策略仍待测；GUI 焦点、分屏、IME、Worktree、hook 与本命令行探测无关，未改其代码。

## 本机结果

- release 二进制 207,872 bytes，仅供隔离实验，未分发。完整独立运行还需匹配架构的 Loader DLL。
- 外部采样 PID 50504：191 ms 时模块未加载，2100 ms 时模块已加载，4109 ms 时模块已卸载；内部 GetModuleHandleW 同样为 false → true → false，脚本 exit 0。
- API HRESULT `0x00000000`，版本 `156.0.4314.50`，AvailableCandidate；HKLM32 pv 同值，HKCU/HKLM64 返回 Win32 error 2。
- DLL 来源：锁定 webview2-com-sys 0.39.1 构建输出 `target/release/build/webview2-com-sys-74ca91b493730f2e/out/x64/WebView2Loader.dll`，SHA-256 `86545b66cdb0603bc26b626fb9ad610cb6e71f28d468f5ea66df23b03dda96d5`。DLL 为本机实验输入，不加入 Git，也不据自动包许可检查认定其发布授权完成。
- 四项单测通过：成功仍只给候选；runtime 缺失与拒绝访问分开；显式阈值；null/零/坏版本与预览通道。五组 release CLI 检查通过：默认不探测、缺少参数、相对路径拒绝、加载器缺失、模拟阈值；成功诊断路径结束时模块均未加载。诊断结果失败仍可 exit 0，参数错误 exit 2，消费方必须检查 JSON availability/reason。

当前 `poc-preview` 的 webview2-com-sys 在 MSVC 下链接 WebView2LoaderStatic；它没有 Loader DLL 不能证明 P8 动态加载。上述 P8 证据仅针对新独立程序，后续 PreviewHost 集成需要重新验证未开预览的真实宿主进程。

本地附件：`bench/results/webview-probe-p8.{json,stdout.jsonl,stderr.log}` 和 `webview-probe-cases.json`。观察脚本只检查自己启动的 PID，记录模块路径和文件哈希；采样的固定 hold 会影响耗时，不能作为启动性能。

## 复现

```powershell
cargo build --release --offline --locked --manifest-path spikes/gpui-poc/Cargo.toml -p poc-webview-probe
spikes/gpui-poc/target/release/poc-webview-probe.exe
# 使用本机已经存在、经过来源核对且匹配 x64 的 DLL 绝对路径。
powershell -NoProfile -File spikes/gpui-poc/bench/Check-WebViewProbe.ps1 -LoaderPath <absolute-path-to-WebView2Loader.dll>
```

依据：Microsoft Learn `WebView2 distribution`（concepts/distribution）及 Win32 `GetAvailableCoreWebView2BrowserVersionString`（reference/win32/webview2-idl）；通过 Context7 的 Microsoft Learn 文档索引核对注册表 GUID、返回码、通道名及 CoTaskMemFree。ABI 另与锁定 webview2-com-sys 0.39.1 bindings.rs、windows-sys 0.61.2 的 LibraryLoader/Com 声明核对。官方文档说明 API 可以选择非稳定 Edge 通道，因此版本存在并不等同可创建目标 WebView 环境。
