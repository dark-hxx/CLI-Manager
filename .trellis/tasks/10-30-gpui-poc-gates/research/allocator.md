# P7 分配器对照（2026-10-30）

结论：完成 Windows 解析子场景，当前证据不支持采用 mimalloc。保留系统默认分配器；P7 的冷启动、真实 PTY/绘制吞吐与完整应用内存仍待测，不据本结果关闭 P7 或 M0。

## 实现与场景

`poc-term` 默认 features 为空；仅显式 `allocator-mimalloc` 使用 `mimalloc = 0.1.52` 的全局 Rust 分配器。锁定 `libmimalloc-sys = 0.1.49`，未启用 secure、override、extended、v2 等特性；本地 build.rs 确认默认编译 vendored v3。Windows MSVC 使用同一 release profile（fat LTO、cgu=1、strip、abort），未改生产分配器。

触点：`poc-term/Cargo.toml` 可选依赖、`main.rs` 条件全局分配器、`offline.rs` 输出分配器身份、workspace 锁文件、`bench/Compare-Allocator.py`、依赖导出工具及交付记录。daemon、PTY 协议和生产目录均未改动。按 M0 implement 约定，隔离新 PoC 不依赖生产图 impact。

覆盖系统/替代分配器、100/200 MB、交替先后次序、精确输入字节数、身份核对、进程异常/超时清理和缺失采样拒绝通过。纯解析不涉及焦点、分屏、WSL、Worktree 或 Hook；这些场景不能由本实验推断通过。脚本只启动传入的隔离二进制，异常时只终止自己启动的进程，读取内存计数不读取用户进程命令行。

## 方法与结果

同一活跃开发机，配置见 baseline.md。两个二进制先构建并保存快照；每种输入 5 组配对，每组各跑一次，偶数组 system→mimalloc，奇数组反向。全部 20 次退出 0、完整消费输入并核对分配器身份。缓存未清除，无置信区间，不能称冷启动或正式性能基线。

以下均为各分配器 5 次样本的中位数；时长单位 ms，内存单位 bytes。

| 输入 / 指标 | system | mimalloc 0.1.52 |
|---|---:|---:|
| 100 MB 纯解析 | 593.7807 | 604.8337 |
| 100 MB 读取+解析 | 695.7586 | 707.4616 |
| 100 MB 整进程时长 | 750.4507 | 756.5604 |
| 100 MB 观察工作集峰值 | 35,553,280 | 37,097,472 |
| 100 MB 观察提交峰值 | 27,738,112 | 35,532,800 |
| 200 MB 纯解析 | 1174.0049 | 1203.4225 |
| 200 MB 读取+解析 | 1373.9496 | 1404.3840 |
| 200 MB 整进程时长 | 1420.8140 | 1450.6000 |
| 200 MB 观察工作集峰值 | 35,557,376 | 37,019,648 |
| 200 MB 观察提交峰值 | 27,705,344 | 35,500,032 |
| exe 大小 | 7,305,216 | 7,371,264 |

内存通过自身子进程句柄的 `GetProcessMemoryInfo` 读取 OS high-water counters，每约 2 ms 轮询。工作集包含共享页，与基线采样器的私有工作集不是同一指标；PeakPagefileUsage 为提交口径，不是物理常驻内存。采样可能遗漏退出前最后活动。整进程时间含启动、读盘、解析与退出，不能拆成“启动耗时”。

二进制 SHA-256：system `d9e0d8d9d4cdba070dfba987b34d669e7c139daa032a3d79729651e9bb2b0b43`；mimalloc `c97e5cd96de607f242cbd05c594e0bb7621d5e3145977fbaf0aa8878cc107f4b`。100 MB 输入 hash `81f24aeb0901804ebdb3e8e383158d21cd0874bd29a70583faca87c0ebf55193`；200 MB `a2533d9ef93b13cb3679c6dd1fd44c97f71d5d233ce7e1e3ecfcea7eab4b8136`。

本地原始结果为 `spikes/gpui-poc/bench/results/allocator/parser-{100MB,200MB}.json`，包含全部时间样本、采样数、输入和二进制 hash；二进制快照在同目录，被忽略入库。没有 PTY、ACK、shaping、GPU 或首帧数据。

## 新增依赖授权

显式 feature 依赖声明另存 `spikes/gpui-poc/research/dependency-licenses-p7.md`：899 包（892 外部、7 本地）；默认图仍为 897 包。`cargo deny --format json --offline --locked --features poc-term/allocator-mimalloc check licenses bans` 退出 0，licenses 0 errors/0 warnings，bans 0 errors/75 warnings。摘要为 `deny-summary-p7.json`，不覆盖默认图结果。

回读两个发布包的 LICENSE.txt，MIT，Copyright 2019 Octavian Oncescu，SHA-256 均为 `a08554fab028af3af047e8588d32d019662c1b1bf07959a195a2f75fe340726b`。vendored v3 的 LICENSE 为 Microsoft Corporation、Daan Leijen 的 MIT，SHA-256 `82ade5d7d9b029044b5fbbc326207fc47c2d44ee4dd71e8a559c36d728217de9`（v2 文件同 hash，但本实验未选择 v2）。发布时须保留两层归属；本实验没有分发二进制。原有 GPUI 资源授权待办不因此关闭。

## 复现

从仓库根目录执行；先保存 feature 二进制，再构建默认二进制，避免同名 exe 被覆盖后混用。Python 需支持 `hashlib.file_digest`（3.11+）。

```powershell
cargo build --release --offline --locked --jobs 2 --manifest-path spikes/gpui-poc/Cargo.toml -p poc-term --features allocator-mimalloc
New-Item -ItemType Directory -Force spikes/gpui-poc/bench/results/allocator | Out-Null
Copy-Item spikes/gpui-poc/target/release/poc-term.exe spikes/gpui-poc/bench/results/allocator/poc-term-mimalloc.exe
cargo build --release --offline --locked --jobs 2 --manifest-path spikes/gpui-poc/Cargo.toml -p poc-term
Copy-Item spikes/gpui-poc/target/release/poc-term.exe spikes/gpui-poc/bench/results/allocator/poc-term-system.exe
python spikes/gpui-poc/bench/Compare-Allocator.py --system spikes/gpui-poc/bench/results/allocator/poc-term-system.exe --mimalloc spikes/gpui-poc/bench/results/allocator/poc-term-mimalloc.exe --fixture spikes/gpui-poc/bench/results/fixture-v1/plain-100MB.txt --output spikes/gpui-poc/bench/results/allocator/parser-100MB.json --pairs 5
python spikes/gpui-poc/export-licenses.py --features poc-term/allocator-mimalloc --output spikes/gpui-poc/research/dependency-licenses-p7.md
```

用 200 MB 输入及对应输出名运行同一脚本。后续须在受控窗口和真实终端负载中补齐 P7，当前不把替代分配器带入 M1。
