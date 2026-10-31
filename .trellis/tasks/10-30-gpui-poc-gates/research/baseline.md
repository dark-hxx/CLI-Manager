# Tauri 性能基线进度（2026-10-30）

状态：采样器已实测，正式基线未完成。当前开发环境有活跃终端、工具和编译负载；采样仅验证工具工作，不能据此计算迁移收益。

## 机器

Windows 11 专业版 10.0.22631；AMD Ryzen 9 9900X；系统可见物理内存 32,706,220 KiB。枚举到 NVIDIA GeForce GTX 960、AMD Radeon Graphics，并存在 GameViewer / Oray 虚拟显示驱动。它们是同一台机器，不能充作要求的“独显、核显两台机器”。DPI 与实际渲染适配器待受控测量时记录。

## 工具与口径

`spikes/gpui-poc/bench/Measure-ProcessTree.ps1`：显式根 PID，按 ParentProcessId 递归，不按全机进程名抓取 WebView2；脱离父树的 daemon 需独立识别后作为额外根传入。每次核对根 CreationDate，避免 PID 复用；采样过程中退出导致性能计数缺失的项标记不完整，总和为空。

内存指标是 `Win32_PerfFormattedData_PerfProc_Process.WorkingSetPrivate`，不是 `Get-Process.PrivateMemorySize64`（Private Bytes）。私有工作集不包含共享页，总和不等于总物理占用。进程树含后代 shell 和工具，双方对比必须使用同一负载。枚举不是原子快照，短命进程可能遗漏。脚本不读取/输出 CommandLine，不启动或终止用户程序。

```powershell
powershell -NoProfile -File spikes/gpui-poc/bench/Measure-ProcessTree.ps1 `
  -RootProcessId <GUI_PID> -AdditionalRootProcessId <已识别的脱离父树DAEMON_PID> `
  -Samples 60 -IntervalMs 1000 -Scenario idle-controlled `
  -OutputPath spikes/gpui-poc/bench/results/tauri-idle.json
```

脚本故意始终标记 `formalBaseline=false`，人工确认受控条件和补充其他指标后再出正式报告，不能只改 flag 冒充验收。

## 已运行的工具冒烟

根 PID 31500（运行中的 Tauri GUI），其下另一个 cli-manager PID 14724；实际树还包含工具子进程。3 次样本均完整，每次 96 个进程，私有工作集分别为 1,723,305,984 / 1,732,141,056 / 1,739,087,872 bytes。仅作采样器冒烟，不能称作空闲内存。原始 JSON 在被忽略的本地 `spikes/gpui-poc/bench/results/sampler-smoke.json`，复测必须重新识别 PID。

## 正式测量矩阵

固定输入工具 `spikes/gpui-poc/bench/New-TerminalFixture.mjs` 已生成十进制 100 MB（100,000,000 bytes）、781,250 行的 LF/无 ANSI 文本，SHA-256 为 `81f24aeb0901804ebdb3e8e383158d21cd0874bd29a70583faca87c0ebf55193`。本地数据与旁车位于 `bench/results/fixture-v1/plain-100MB.txt` 及同名 `.json`（忽略入库）。已逐行回读验证序号、长度、LF、无 CR/ESC 和哈希，并覆盖短末行、跨 chunk、重复生成一致、非法参数与拒绝覆盖场景；`node --check` 通过。这些验证仅证明输入可复现，未运行终端吞吐。

可复现操作见 `spikes/gpui-poc/bench/README.md`：区分文件字节与 PTY 传输字节，以及输出进程结束、解析完成与帧呈现；缺观测证据仍列未测。8 分屏固定 200 MB 文件是替代负载，不能与设计中的 `yes` 重复行输出直接合并比较。

| 项目 | 方法 | 状态 |
|---|---|---|
| 冷启动到可交互首帧 | 干净进程启动，录像帧和日志时间戳交叉核对，记录缓存状态/样本数 | 未测 |
| 空闲内存及常驻进程 | 两种壳相同项目、会话和预览状态，GUI+WebView2+daemon 分类并合计 | 仅工具冒烟 |
| cat 100 MB 吞吐 | 固定输入、shell、窗口与滚动配置，计时至解析及绘制完成 | 未测 |
| 键入延迟 p95 | 按键事件至对应字形首次绘制，报告样本数和分位方法 | 未测 |
| 8 分屏帧率 | 同时输出，记录帧时间序列/掉帧和 GPU/DPI | 未测 |
| 空闲 10 分钟 CPU 唤醒 | ETW 或 powercfg/energy，记录窗口焦点和最小化状态 | 未测 |
| 第二台核显 Windows | 同一方法、负载和版本 | 无实测环境 |

不关闭用户当前会话来制造“空闲”；正式基线应在独立受控实例和专用目录中完成。
