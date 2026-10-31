# M0 测量操作说明

所有命令从仓库根目录执行。工具提供固定输入、窗口冒烟、组件动作核对、checkpoint 比较、传输/解析诊断和进程树采样，未完成正式性能基线。原始结果写入被忽略的 `bench/results/`，窗口证据写入被忽略的 `research/poc-media/`；正式报告保存机器、版本、配置、输入哈希、原始附件位置和未测项。

## 分层诊断与正确性实验

先构建 workspace 的 release 二进制；固定输入已存在时直接复用，生成器拒绝覆盖。

```powershell
# 实际组件替换两处、Undo/Redo 后核对全文；不代表系统键盘或 IME。
powershell -NoProfile -File spikes/gpui-poc/bench/Invoke-WindowSmoke.ps1 -Binary poc-input -Language zh-CN -Exercise -FixturePath spikes/gpui-poc/bench/results/editor-fixtures/source-1MB.ts -CaptureDelaySeconds 2
powershell -NoProfile -File spikes/gpui-poc/bench/Invoke-WindowSmoke.ps1 -Binary poc-input -Language en-US -Exercise -FixturePath spikes/gpui-poc/bench/results/editor-fixtures/log-10MB.log -CaptureDelaySeconds 2
# 无绘制传输，只创建并关闭自己的临时会话；需已有可用 daemon。
spikes/gpui-poc/target/release/poc-daemon.exe --smoke --fixture spikes/gpui-poc/bench/results/transport-v1/plain-1MB.txt
# 可追加 --nodelay 对照；不改变 daemon，不能据单次时长认定根因。
# 纯读取/解析，不经过 PTY、WebSocket、ACK、shaping 或 GPU。
spikes/gpui-poc/target/release/poc-term.exe --parse-fixture spikes/gpui-poc/bench/results/fixture-v1/plain-100MB.txt
node spikes/gpui-poc/bench/Check-Checkpoint.mjs
# 仅操作自身预览 HWND，缩放、最小化、恢复；退出后核对已观察的后代身份。
powershell -NoProfile -File spikes/gpui-poc/bench/Invoke-WindowSmoke.ps1 -Binary poc-preview -Language zh-CN -PreviewLifecycle
powershell -NoProfile -File spikes/gpui-poc/bench/Invoke-WindowSmoke.ps1 -Binary poc-preview -Language en-US -PreviewLifecycle
# 独立动态加载 P8：外部枚举自身探测进程的加载前、加载中、卸载后三阶段模块。
powershell -NoProfile -File spikes/gpui-poc/bench/Check-WebViewProbe.ps1 -LoaderPath <绝对WebView2Loader.dll路径>
```

预览 bounds 同时记录调用者坐标、GPUI logical 和 physical 坐标；DPI 虚拟化和取整会导致口径不同，不能直接混比。后代按 PID、创建时间及名称核对，正常退出的观察结果不代表普适泄漏证明；焦点、Airspace、跨屏 DPI 和托盘恢复仍待测。探测器的有界 hold 只用于外部采样，不是首次创建耗时；P8 独立程序通过不代表当前静态 Loader 的预览宿主已完成集成。缺失、低版本及企业策略 VM 仍待测。

daemon 诊断仅汇总有界接收间隔直方图、帧/ACK 数及本地发送耗时，不记录 payload、token 或完整命令行。100 MB 无绘制传输同样超时，不能将其归因于 GPU；本地 ACK send 计时不含远端处理。

`--exercise` 任一全文断言失败返回非零。checkpoint 比较遇到差异也返回非零，当前八场景已有失败，不将该退出码改写为通过。终端 marker 超时会尝试清理自己的会话并返回非零；保留已接收字节数，不能把部分输出称为完成。解析计时、传输跨度与 render callback 间隔各有独立口径，最后一项不等于 GPU 呈现帧率。

checkpoint 的 `diagnosticVersion=2` 分开记录 xterm 自序列化、原始/序列化 ANSI 的 alacritty 续写、直接反向编码续写，比较 OSC 8 ID/URI 并列出首批单元格差异及原始光标位置。链接及光标隐藏诊断使用锁定 xterm 版本的私有接口，接口缺失直接报错；不能将诊断实现带入生产兼容层。详见 M0 `research/checkpoint.md`。

## 窗口隔离实验

从仓库根目录执行：

```powershell
cargo build --release --offline --locked --manifest-path spikes/gpui-poc/Cargo.toml -p poc-compat --bin poc-window
./spikes/gpui-poc/bench/Invoke-WindowExercise.ps1 -Language zh-CN
./spikes/gpui-poc/bench/Invoke-WindowExercise.ps1 -Language en-US
./spikes/gpui-poc/bench/Invoke-WindowInterop.ps1
./spikes/gpui-poc/bench/Invoke-WindowSmoke.ps1 -Binary poc-window -Language zh-CN
./spikes/gpui-poc/bench/Invoke-WindowSmoke.ps1 -Binary poc-window -Language en-US
```

自动实验只操作自身 PID 的 HWND，使用合成窗口消息，不移动系统鼠标或截取桌面；独立 Python ctypes 接收端仅验证锁定插件的 wire 格式，不是实际 Tauri 互认。脚本生成唯一 namespace；手工实验使用 `poc-window --window [--namespace com.cli-manager.gpui-poc.TOKEN]`，`--smoke` 八秒退出。窗口报告见 M0 `research/window.md`。默认 `cargo run -p poc-compat` 仍运行原兼容实验。

## 固定输入

P7 的 Windows 配对工具 `Compare-Allocator.py` 需要 Python 3.11+，仅启动显式传入的两个二进制，交替顺序核对身份和完整字节数；约 2 ms 读取自身子进程内存 high-water counters。它测解析、读取+解析、整进程时长和观察峰值，不测冷启动或 GPU。构建、快照命令与完整复现见 `.trellis/tasks/10-30-gpui-poc-gates/research/allocator.md`；同名 `poc-term.exe` 会被不同 feature 构建覆盖，必须先保存各自快照。

```powershell
node spikes/gpui-poc/bench/New-TerminalFixture.mjs --output spikes/gpui-poc/bench/results/fixture-v1/plain-100MB.txt
node spikes/gpui-poc/bench/New-TerminalFixture.mjs --output spikes/gpui-poc/bench/results/fixture-v1/plain-200MB.txt --bytes 200000000
```

默认输入为十进制 100 MB（100,000,000 bytes），不是 100 MiB。每行 128 bytes，ASCII（UTF-8 子集）、LF、无 ANSI；序号从 0 开始。自定义长度的末行可不足 128 bytes，仍以 LF 结束。生成器独占创建数据文件和同名 `.json`，任一已存在就拒绝覆盖。旁车记录字节数、行数和 SHA-256；生成耗时不是终端吞吐。

默认文件共 781,250 行，SHA-256：
`81f24aeb0901804ebdb3e8e383158d21cd0874bd29a70583faca87c0ebf55193`。
双壳复用同一文件并核对旁车与实际文件哈希。

在**待测终端内**手动输出；替换为实际绝对路径：

```powershell
cmd /d /c type "F:\path\plain-100MB.txt"
```

WSL 使用 `cat /mnt/f/path/plain-100MB.txt`。同一次对比固定 shell、PTY、终端行列数、scrollback、换行模式、DPI、GPU、窗口焦点、项目/会话与预览状态；PowerShell `Get-Content` 管道增加逐行处理，不作为 raw 输出负载。文件字节数与 ConPTY 换行转换后的传输字节数可能不同，报告须分开记录。该纯文本负载不能代替 ANSI、宽字符或 checkpoint 正确性验证。

## 采样与计时

| 指标 | 受控步骤与记录 |
|---|---|
| 内存/进程数 | 手动识别 GUI PID 和脱离父树的 daemon PID，调用 `Measure-ProcessTree.ps1`；合计私有工作集，记录各类进程、完整样本和配置。活跃会话采样不称为空闲基线。 |
| 冷启动 | 在专用环境确认待测实例已退出，再启动；记录磁盘/缓存状态、重复次数，以录像帧和日志时间戳交叉核对首个可交互帧。普通重复启动不能称作冷启动。 |
| 100 MB 吞吐 | 分别记录输出进程结束、PTY 接收结束、解析结束与最后一帧提交/呈现；吞吐分母必须标明覆盖区间。仅 `type`/`cat` 返回不代表 UI 已处理完成，缺少解析/绘制观测时保留未测。 |
| 输入延迟 p95 | 在相同空闲/输出负载下，从按键事件量到对应字形首次呈现；保留原始时间序列、样本数与分位方法。例如 nearest-rank 使用排序后第 `ceil(0.95*n)` 个样本。仅日志接收时间不足以代表显示延迟。 |
| 8 分屏 | 八个终端使用相同的 200,000,000-byte 文件同时输出，记录各自开始时刻、重叠区间、帧时间序列及最长卡顿；固定刷新率、DPI、适配器与电源状态。它是可复现的替代负载，不能直接与设计中的 `yes` 重复行负载混作同一组结果。 |
| 空闲 CPU 唤醒 | 专用环境静置 10 分钟，以 ETW 或 energy 报告保存原始证据，记录焦点/最小化/托盘状态和采集器开销；CPU 占用率不能代替唤醒次数。 |

按设计分别在独显与核显两台 Windows 机器执行，同一机器枚举出两块 GPU 不满足两台机器要求。刷新率低于 60 Hz 或没有可靠帧呈现证据时，不能据此判定 60 fps 门禁通过。

采样器用法见上级 README；它始终输出 `formalBaseline=false`，不能只改标志充作验收。不自动关闭用户会话，也不启动第二个产品实例触发单实例转发。需要受控产品实例的项目仍待专用测量环境；按 2026-10-30 用户调整，macOS 暂缓不阻塞 Windows 隔离运行时实验；未决许可仍不放行 M1 或发布。
