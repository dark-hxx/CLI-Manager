# Windows 隔离运行记录（2026-10-30）

范围：Windows x86_64 MSVC，锁定 workspace 的 release 构建；本机现有 daemon 报告版本 1.4.3。所有数字是单次诊断，未控制机器负载、缓存与电源状态，不能作为正式基线或跨平台结论。按用户要求，macOS 原生测试暂缓。

## 输入与编辑器

`poc-input` 实例化 gpui-component Input/Editor，并提供自绘 `EntityInputHandler` 接收器。中英文窗口、1 MB TS 和 10 MB 日志打开均已截图检查。1 MB 文件读取 0.801 ms、状态构造 1.239 ms；10 MB 读取 5.688 ms、构造 13.469 ms；均非首帧/可交互延迟。

组合文本逻辑的三项单元测试通过：marked 替换保留 suffix 且不重复提交、UTF-16 代理对边界、取消 marked。它们不能替代微软拼音/搜狗/日文系统输入法，候选窗位置、焦点切换、DPI 与真实终端输入仍待测。当前默认 feature 未启用 tree-sitter，语言标签不等于语法高亮验收。

新增 `--exercise` 通过组件真实状态执行查找替换，并沿窗口焦点路径派发 Undo/Redo、逐次核对全文，失败返回非零。release 构建通过，以下两组窗口实测均 exit 0，均恰好替换两处、替换后全文一致、撤销与重做全文一致，最后恢复原始文件内容：

| 窗口 / 输入 | read_ms | construct_ms | search_replace_ms |
|---|---:|---:|---:|
| zh-CN / 1,000,000-byte TS | 1.849 | 0.774 | 50.235 |
| en-US / 10,000,000-byte log | 7.894 | 7.828 | 423.540 |

已逐张检查 `research/poc-media/poc-input-zh-CN-source-1MB.png` 与 `poc-input-en-US-log-10MB.png`：标题中英文对应，编辑器显示中文、组合字符与 emoji，行号和软换行可见。日志同前缀 `.stdout.log` 保存断言。这些是程序化组件与焦点 action 路径证据，不是系统键盘、IME、首帧或滚动帧率验收。

## daemon 与终端

`poc-daemon` 读取现有 discovery，连接本机 daemon，完成 auth/create/resize/attach/binary UTF-8/UTF-16 ACK/write/close。每次仅创建并清理独立命名的临时会话；不停止 daemon、不接管用户会话、不输出 token。输入流按 20-byte binary header 校验。

`poc-term` 使用 alacritty 80×24 网格、4 KiB 解析、damage 行 shaping 缓存和 GPUI canvas。已支持单窗与 `--eight` 草图，但目前只有单色输出及光标，没有终端输入、选区和完整 SGR；帧 cols/rows 尚未动态应用。不能视作完整终端。

| 单次实验 | 输入 / 实际接收 | 结果 |
|---|---|---|
| 默认 1000 行窗口冒烟 | 接收 19,412 bytes | exit 0；解析 0.9791 ms，接收与解析跨度 4579.3907 ms |
| 100 MB 窗口输出 | 输入 100,000,000；接收 31,291,770 bytes | **exit 1，120 秒 marker 超时**；解析 259.4823 ms，接收与解析跨度 120,469.267 ms |
| 1 MB 无绘制，默认 TCP_NODELAY=false | 输入 1,000,000；接收 1,011,225 bytes，87 frames | exit 0；receive 4700.0888 ms，total 4718.0772 ms |
| 相同 1 MB，TCP_NODELAY=true | 接收 1,011,225 bytes，102 frames | exit 0；receive 4682.5043 ms，total 4700.1628 ms |
| 100 MB 无绘制，默认 TCP_NODELAY=false | 接收 35,221,464 bytes，2429 frames | **exit 1，120 秒 marker 超时**；receive 120368.983 ms，total 120388.1794 ms |
| 100 MB 无绘制，增加有界诊断 | 接收 35,304,186 bytes，2422 frames | **exit 1，120 秒 marker 超时**；receive 120363.8388 ms，total 120382.0169 ms |
| 100 MB 纯文件读取/解析 | 100,000,000 bytes | exit 0；parse 578.0493 ms，read+parse 678.3313 ms |
| 200 MB 纯文件读取/解析 | 200,000,000 bytes | exit 0；parse 1246.5125 ms，read+parse 1452.0476 ms |

1 MB 两次无明显差异，不能认定 Nagle 为根因；总时间包含 Shell 启动，不能当持续吞吐。默认 probe 保持 nodelay=false。纯解析不含 PTY、ACK、shaping、GPU，与窗口实验配置不同，不能直接算加速倍数。当前需继续分离 ConPTY、旧 daemon、ACK/流控与 UI 消费路径。

有界诊断不保存 payload、token 或 sessionId。100 MB 的 marker 阶段记录 35,222,319 bytes / 2415 输出帧、2417 控制帧、2416 次 ACK；本地 ACK 发送累计 238.3691 ms、最大 0.2913 ms，消费回调累计 0.4632 ms，序号空洞和非递增均为 0。接收间隔桶上界为 `[1,5,10,25,50,100,1000]` ms，另有溢出桶，计数为 `[0,38,988,3,0,1301,83,1]`。大量间隔落在 50–100 ms，但发送耗时不包含远端 ACK 处理，不能据此定位 daemon 内部根因。marker 与全流程统计范围不同，清理阶段还会接收输出与发送 ACK，计数不可逐项混用。

1 MB 诊断的 marker 阶段为 1,011,068 bytes / 85 输出帧、86 控制帧、85 次 ACK；发送累计 7.3299 ms、最大 0.1708 ms，消费累计 0.008 ms，序号空洞和非递增均为 0；全流程为 1,011,225 bytes / 88 frames，receive 4599.0693 ms，exit 0。无绘制的 100 MB 仍超时，证明问题不只出现在绘制路径；不将性能问题归因 GPU，也不修改生产 daemon 来绕过失败。

100 MB 窗口实验记录 8929 次 render callback，平均间隔 13.5028945 ms、最大 44.1293 ms；它不是 GPU 呈现帧率，不能据此宣称 60 fps。5 秒窗口截图出现 fixture 第 11524–11533 行，仅证明部分输出被画出；3 秒默认截图为空网格，不作为输出证据。8×200 MB、键入到呈现 p95、完整性能门禁尚未执行。

本地附件：`spikes/gpui-poc/bench/results/{transport-default-1MB,transport-nodelay-1MB,transport-default-100MB,transport-detail-1MB,transport-detail-100MB,parser-100MB,parser-200MB}.log`；窗口原始记录在 `research/poc-media/poc-term-zh-CN-plain-100MB.{stdout,stderr}.log`。

固定输入与 SHA-256：

| 文件（相对 bench/results） | bytes | SHA-256 |
|---|---|---|
| fixture-v1/plain-100MB.txt | 100,000,000 | `81f24aeb0901804ebdb3e8e383158d21cd0874bd29a70583faca87c0ebf55193` |
| fixture-v1/plain-200MB.txt | 200,000,000 | `a2533d9ef93b13cb3679c6dd1fd44c97f71d5d233ce7e1e3ecfcea7eab4b8136` |
| transport-v1/plain-1MB.txt | 1,000,000 | `bec45c20e0ba5ce6cc70a313b4fe0836c418d2a6d08d243f438b6bef5b6e7f19` |

## WebView 像素证据

`poc-preview` 使用 wry child WebView、自有 profile 和保活 WebContext，自定义协议只开放三个内置 fixture 路由，其余 404，CSP 离线。Windows 显式使用 `http://climgr-preview.localhost/{path}`：初始 URL 自动改写不代表 `load_url` 会做相同改写。

CapturePreview 回调参数已经是 `Result<(), windows::core::Error>`；成功后 Commit stream 并记录完成路径，smoke 退出要求三张截图全部完成且无错误。异步发起成功或 page-load 事件均不能代替截图完成。

- zh-CN 与 en-US smoke 均 exit 0，三路导航和三次 surface capture 各自完成。
- **人工逐张检查六张 surface PNG**：Markdown 预渲染页面、HTML 和 PDF 都有实际内容；PDF 显示“CLI-Manager isolated PDF probe”正文及内置 PDF 工具栏。
- 本轮 WebView 创建耗时：zh-CN 704.958 ms，en-US 294.815 ms。单次非冷启动，不能据两次不同数字认定语言影响性能。
- 正常机器 runtime 探测值：156.0.4314.50。独立动态加载/P8 模块实验见 [webview-probe.md](webview-probe.md)，不把当前 MSVC 静态 Loader 的 preview 当作动态加载证据。
- Markdown 是内置预渲染 HTML，尚未测试真实 Markdown 解析；HTML 是内置 fixture，尚非项目文件根白名单实现。
- 待测：Airspace 实际浮层、焦点往返、DPI 切换/跨屏、分屏拖动、托盘恢复、owned 窗口对照；缩小、最小化/恢复和已观察后代退出的新增证据见下文。

本地 surface 证据（相对 `spikes/gpui-poc/bench/results/`）：`preview-62468-zh-CN-{markdown,html,sample-pdf}.png`、`preview-21540-en-US-{markdown,html,sample-pdf}.png`。顶层 PrintWindow 不包含 child WebView，不将其背景截图判成 PDF 空白。

## WebView 生命周期增量实验

`Invoke-WindowSmoke.ps1 -Binary poc-preview -PreviewLifecycle` 仅操作自己 GUI 的 HWND：缩小、最小化、恢复，校验 Win32 rect、IsIconic 和可见性；恢复后仍保持缩小尺寸。它记录自己进程的已观察后代 PID、启动时间和进程名，按 PID + 启动时间防止误认复用 PID，正常退出后最多等待 10 秒。没有停止其他实例或输出进程命令行。

| 窗口 | GUI PID | 创建 ms | 缩小/恢复尺寸（Win32 调用者坐标） | 已观察后代 | GUI 退出后等待 ms | 剩余 |
|---|---:|---:|---|---:|---:|---:|
| zh-CN | 5392 | 309.411 | 914×738 → 754×638 → 754×638 | 9 | 222 | 0 |
| en-US | 63304 | 351.792 | 914×738 → 754×638 → 754×638 | 9 | 292 | 0 |

两次均 exit 0。应用处于 125% DPI；WebView logical bounds 从 876×620 变成约 716×520.8，API 回读物理尺寸从 1095×775 变成 895×651；surface PNG 为 895×652，存在 1 像素取整差异。脚本调用者坐标受 DPI 虚拟化影响，不能直接与物理截图比较，也不能据此声称完成 DPI 切换测试。

**已人工逐张检查本次六张缩小后的 surface PNG**：`preview-5392-zh-CN-{markdown,html,sample-pdf}.png`、`preview-63304-en-US-{markdown,html,sample-pdf}.png`；中英文标题、HTML 输入和 PDF 正文/工具栏可见。脚本日志与断言为 `research/poc-media/poc-preview-{zh-CN,en-US}-lifecycle.{stdout.log,stderr.log,lifecycle.json}`。该实验只证明已观察到的后代在本次正常退出后消失，不是所有启动/崩溃场景的泄漏证明或正式回收性能指标。

## 编译与检查补充

六成员的 workspace release 构建已通过；加入独立探测后按七成员再次复核，最终结果见 compat.md。`poc-input` 三项和 `poc-daemon` 一项测试以 `--jobs 2 --offline --locked` 通过。首次默认并发编译 winreg 时 rustc 返回 `0xc0000096`，降低并发后测试通过；重试日志出现过 R6016 线程数据提示，未将首次编译异常隐去或计为功能失败。独立探测另有四项分类测试和五组 release CLI 检查，见 webview-probe.md。

## 场景与触点边界

新增实现只在 `spikes/gpui-poc`。输入涉及组件状态、焦点派发与自绘组合接收器；终端涉及 discovery/鉴权、独立临时会话、解码/ACK、解析和绘制；预览涉及路由、导航、profile、异步截图及窗口退出。生产命令、数据持久化和产品语言入口均未修改。隔离 PoC 使用 `POC_LANG=zh-CN|en-US` 覆盖窗口文案，系统 IME 和产品设置切换验证仍分别保留。
