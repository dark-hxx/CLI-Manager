# Windows WebView 冒烟证据（2026-10-31）

运行入口：

```powershell
spikes/gpui-poc/target/release/poc-preview.exe --smoke
```

结果：进程退出码为 0。独立 GPUI 窗口中成功创建 child WebView，创建耗时约 399.804ms；窗口物理 bounds 记录为 `1095 × 775`，对应逻辑 bounds `876 × 620`。

三路 fixture 均收到完成加载事件：

- `http://climgr-preview.localhost/markdown`
- `http://climgr-preview.localhost/html`
- `http://climgr-preview.localhost/sample.pdf`

冒烟流程同时完成了 WebView 隐藏、HTML 导航、恢复显示和 PDF 导航，并生成 Markdown、HTML、PDF 三张窗口截图。截图人工检查确认 Markdown 标题、HTML 中文/英文输入框以及 PDF.js 页面和 PDF 标题均可见。

这项证据覆盖独立 PoC 的真实 Windows WebView 创建、协议路由、隐藏/恢复、bounds 更新、PDF 页面可见性和窗口截图。它不等同于产品 GPUI 窗口验收，仍未覆盖产品壳中的焦点回收、中文 IME、DPI 跨显示器、Airspace 浮层相交、WebView 后代进程回收以及完整六状态矩阵。

首次从源码重建 release PoC 时，`rustc` 在 `schemars` 编译阶段出现 `STATUS_ACCESS_VIOLATION`；随后使用已有 release 产物完成上述运行验证。该编译器异常不作为运行期失败结论。
