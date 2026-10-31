# GPUI M0 PoC

独立 workspace，不参与产品构建，不修改生产代码。按
`.trellis/tasks/10-30-gpui-poc-gates/implement.md` 执行。

```powershell
cargo build --release --offline --locked --jobs 2 --workspace --manifest-path spikes/gpui-poc/Cargo.toml
python spikes/gpui-poc/export-licenses.py
cd spikes/gpui-poc
cargo deny --format json check licenses bans 2> research/deny-results.jsonl
python audit-license-evidence.py
python export-upstream-licenses.py
python export-shader-source-review.py
```

当前 workspace 有七个成员；窗口程序默认只打印用法，运行实验需显式传参；独立探测器默认输出 NotProbed，不加载 WebView2Loader。
通过 `POC_LANG=zh-CN|en-US` 选择 PoC 文案。

| 成员 | 实验入口与范围 |
|---|---|
| `poc-compat` | `--window` / `--smoke`：依赖兼容与平台窗口，smoke 5 秒退出 |
| `poc-input` | `--smoke [--fixture PATH] [--exercise]`：Input、Editor、自绘组合输入接收器；exercise 核对替换、撤销与重做 |
| `poc-daemon` | `--smoke [--fixture PATH] [--nodelay]`：连接现有 daemon，仅创建和清理自己的临时会话，无解析或绘制 |
| `poc-term` | `--smoke [--eight] [--fixture PATH]`：daemon 输出到 alacritty 与单色 GPUI 网格；`--parse-fixture PATH` 只读文件并解析 |
| `poc-checkpoint` | 从 stdin 接收 fixture JSON，输出网格和可见屏 ANSI 草稿；由 `bench/Check-Checkpoint.mjs` 编排往返与继续输出比较 |
| `poc-preview` | `--probe` 探测 runtime，`--smoke` / `--window` 打开离线 WebView fixture；smoke 校验三路导航与 Windows surface 截图完成 |
| `poc-webview-probe` | `--probe --loader <绝对路径>`：显式动态加载、版本候选分类和注册表证据；无参数不探测，独立验证 P8 |

Windows 已有编辑器实际动作、daemon 临时会话、终端解析和 WebView 像素证据；
checkpoint 继续输出有差异，100 MB 窗口与无绘制传输实验均超时。预览缩放、最小化恢复与已观察后代回收通过；独立动态探测 P8 通过，尚未集成真实 PreviewHost。窗口截图及自动化动作不代表
系统 IME、完整终端或性能门禁通过。报告位于
`.trellis/tasks/10-30-gpui-poc-gates/research/`，其中 `windows-runtime.md` 与
`checkpoint.md` 记录范围、原始附件及失败项。M0 保持进行中。
`research/dependency-licenses.md` 是全量解析依赖的声明清单，包含其他平台依赖；
不能替代源码及资源授权复核。deny 的 AGPL 例外仅适用于本项目 PoC 包。
`audit-license-evidence.py` 同时导出来源匹配、资源候选哈希和默认解析 feature；
`export-upstream-licenses.py` 联网保存六份上游许可/声明快照与来源哈希：五份固定 commit（含组件文档声明），
Oklab 为作者站点快照，单独标注获取时间及非固定 revision。
`export-shader-source-review.py` 联网读取 Stack Exchange 官方答案与修订 API，保存
作者、许可、revision、哈希及五项表达的归一化对照，不转载答案散文；相似性不证明
实际复制关系或授权兼容性，CC BY-SA 来源处置仍未完成。
候选文件不等于实际链接或发布内容，上游快照也不等于完整发布 NOTICE。

```powershell
# 在仓库根目录；仅启动待测 PoC 窗口，自动关闭，PrintWindow 只捕获该窗口。
powershell -NoProfile -File spikes/gpui-poc/bench/Invoke-WindowSmoke.ps1 -Language zh-CN
powershell -NoProfile -File spikes/gpui-poc/bench/Invoke-WindowSmoke.ps1 -Language en-US
# 预览窗口生命周期；同样支持 en-US。
powershell -NoProfile -File spikes/gpui-poc/bench/Invoke-WindowSmoke.ps1 -Binary poc-preview -Language zh-CN -PreviewLifecycle
# 显式指定本地 SDK 构建产物；不自动下载、安装或分发 Loader。
powershell -NoProfile -File spikes/gpui-poc/bench/Check-WebViewProbe.ps1 -LoaderPath <绝对WebView2Loader.dll路径>
# 显式传入当前 GUI PID；额外 daemon 根按需传入。不会改变用户会话。
powershell -NoProfile -File spikes/gpui-poc/bench/Measure-ProcessTree.ps1 `
  -RootProcessId <GUI_PID> -Samples 3 `
  -OutputPath spikes/gpui-poc/bench/results/sampler-smoke.json
```

截图/日志与原始采样忽略入库。采样器测 Private Working Set，包含整个后代树；
活跃终端和构建负载下的数据不能充作空闲基线。按用户要求，macOS 编译和系统测试
暂缓，不计为通过，也不阻塞 Windows 隔离实验；未放行 M1、生产迁移或发布。

固定终端输入生成与各指标的测量步骤见 `bench/README.md`。生成器输出精确
100,000,000 bytes 的文本和 SHA-256 旁车，拒绝覆盖已有文件；已有分层诊断不替代正式吞吐与帧呈现测量。

P7 在 `poc-term` 中通过 `--features allocator-mimalloc` 显式启用；默认仍为系统分配器。配对解析、观察内存峰值和 exe 体积的结果及复现见任务 `research/allocator.md`。可选 feature 的声明另导出为 `research/dependency-licenses-p7.md`，不与默认图混用。
