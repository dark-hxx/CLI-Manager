# Windows WebView 生命周期证据（2026-10-31）

运行入口：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File spikes/gpui-poc/bench/Invoke-WindowSmoke.ps1 `
  -Binary poc-preview -Language zh-CN -PreviewLifecycle
```

结果：窗口冒烟退出码为 0。窗口从初始尺寸缩放到 `983 × 822`，恢复后实测仍为 `983 × 822`；最小化和恢复均成功。

生命周期脚本观察到 9 个 WebView2/conhost 后代进程。GUI 进程退出后，所有观察到的后代进程在 253ms 内退出，10 秒回收窗口内无残留。

原始记录：`spikes/gpui-poc/research/poc-media/poc-preview-zh-CN-lifecycle.lifecycle.json`。

本证据覆盖独立 PoC 的窗口尺寸同步、最小化/恢复和 GUI 退出后的 WebView2 后代进程回收。`dpiChanged=false` 与 `focusVerified=false` 表示跨显示器 DPI 和焦点仍未完成验证；该证据也不替代产品 GPUI 窗口的完整六状态矩阵。
