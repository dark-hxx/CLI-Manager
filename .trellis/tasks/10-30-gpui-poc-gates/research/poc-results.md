# M0 门禁进度（2026-10-30）

总判定：**M0 进行中，尚无 Go / No-Go 结论，不放行 M1**。用户明确暂缓 macOS 测试，继续 Windows 隔离运行时 PoC；macOS 不记通过，也不再阻塞 Windows 实验。资源人工授权审查仍未关闭，不能发布或把依赖自动检查视作完整授权结论。

## 场景与范围

代码仅位于独立 `spikes/gpui-poc`，不修改生产 `src/`、`src-tauri/`。M0 implement 明确豁免新隔离 PoC 的生产图 impact，提交前仍需图变更检查。七成员分别覆盖编译、输入/编辑器、daemon、终端、checkpoint、预览和独立动态探测；`poc-compat` 包另含 `poc-window` 窗口/托盘实验 binary。

场景覆盖 Windows/macOS、输入焦点与组合文本、分屏、DPI、WebView 缺失、子窗口截图、后台 daemon 与独立临时会话清理；测试范围和未测项见 [Windows 运行记录](windows-runtime.md)，不能据编译或加载日志补勾功能验收。

## 验证表

| PoC / 门禁 | 状态 | 证据与剩余工作 |
|---|---|---|
| Windows 编译 | 七成员及新增窗口 binary 的 workspace release 复核通过 | offline、locked、jobs=2，最新 4m06s；不等于各项功能通过 |
| macOS 编译与系统测试 | 用户要求暂缓 | 无主机/runner，不计通过、不阻塞 Windows 研究 |
| 许可证 | 自动检查通过，人工审查未关闭 | 897 包声明（890 外部+7 本地）；来源、资源及 WGSL 授权待办见 license-audit.md |
| 检查点 A | 未关闭 | 按用户调整允许 Windows 隔离实验；仍不放行 M1 / 发布 |
| Tauri 基线 | 未完成 | 采样器冒烟与固定输入已备；非受控活跃数据不是空闲/冷启动基线 |
| IME | 接收器和三项组合逻辑测试通过，系统 IME 待测 | Input/Editor 和自绘接收器已实例化；微软拼音/搜狗/日文、焦点与 DPI 待测 |
| daemon 原生客户端 | 临时会话协议冒烟通过 | 复用本机 1.4.3 daemon，仅清理自身会话，未修改生产协议 |
| 终端绘制 / 吞吐 | 单色网格输出已显示，窗口与无绘制 100 MB 均超时 | 窗口收 31,291,770 bytes；无绘制两次约 35 MB；本地 ACK send 未解释大部分耗时，远端根因仍待定位；纯解析 100/200 MB 已完成 |
| 8 分屏 / p95 | 未验收 | 已有八窗格草图，未执行 8×200 MB；render callback 不是呈现 FPS |
| 检查点 B | 未关闭 | 系统 IME 与 8 分屏硬门槛未验收，不据当前吞吐问题直接判 No-Go |
| ANSI checkpoint | 当前草稿失败，分阶段定位完成 | 序列化丢链接；直接编码保留链接 ID/URI；内核下划线/光标表示有差异，反向编码未保留双缓冲/滚动区/wrap-pending；见 [checkpoint.md](checkpoint.md) |
| 原生编辑器 | 中英文大文件打开及实际替换/Undo/Redo 全文核对通过 | 1 MB TS / 10 MB 日志，分别 50.235/423.540 ms 编辑动作；非系统按键耗时；三栏、JSON 定位、滚动与系统 IME 待测 |
| Markdown/HTML/PDF | 中英文三路像素及窗口生命周期观察通过 | 最新六图已逐张检查；缩放、最小化恢复后布局同步，退出后已观察后代均回收；焦点/Airspace/跨屏 DPI/托盘仍待测 |
| WebView2 探测 | 独立动态探测 P8 通过 | 外部模块 false→true→false；版本 156.0.4314.50 仅为可用候选；4 单测、5 CLI 场景通过；PreviewHost 集成及异常 VM 待测，见 webview-probe.md |
| 窗口 / 托盘 / 单实例 | 中英文标题栏、原生样式、托盘命令与隔离双向协议通过 | Drag/Min/Max/Close 命中、双击最大化/还原、隐藏/恢复、Unicode 收参、异常消息拒绝及正常退出清理已测；实际 Snap、透明合成、跨屏 DPI、托盘真实鼠标菜单与 Tauri 互认仍待测，见 [window.md](window.md) |
| P7 分配器 | 解析子场景已完成，完整验收待测 | 100/200 MB 各 5 配对，20 次完整消费；未显示 mimalloc 收益，保留系统默认；冷启动/真实终端待测，见 allocator.md |
| P5 历史现状 | 静态核实完成 | 已有增量尾读，catalog 仍全量计算；详见下文 |

## 证据索引与边界

- [compat.md](compat.md)：固定依赖、共存版本与平台编译边界。
- [license-audit.md](license-audit.md)、source-review.md、shader-review.md：32 个来源命中（16 个误报）、25 个 GPUI 包、1868 个资源候选、六份上游许可/声明快照；WGSL 实际来源与兼容性待处置，重复扫描不能关闭人工待办。
- [windows-runtime.md](windows-runtime.md)：终端分层诊断、预览 surface 截图、原始本地附件路径。
- [checkpoint.md](checkpoint.md)：八场景、失败细节及协议修订方向。
- [webview-probe.md](webview-probe.md)：安全动态加载、版本候选分类、P8 三阶段与缺失环境边界。
- [allocator.md](allocator.md)：P7 配对解析对照、观察内存峰值、体积及新增依赖许可。
- [window.md](window.md)：标题栏/托盘/副窗口与隔离单实例协议、原生资源清理及真实产品互认边界。
- [baseline.md](baseline.md) 与 `spikes/gpui-poc/bench/README.md`：测量方法与固定负载，不虚报正式基线。

原始截图、fixture 和日志在本地被忽略目录；可入库报告保留关键数值、版本、哈希和附件路径。中英文 PoC 用 `POC_LANG` 验证，未修改产品 UI，不把这些截图视作生产语言设置或系统 IME 验收。

## P5：已有增量能力与缺口

- `history/scan_state.rs` 的文件 fingerprint 记录创建/修改时间和 size，没有读取 offset。
- `history/catalog.rs` 对 fingerprint 未变文件跳过，变更文件经 `parse_catalog_file` 调用 `scan_session_computation_with_messages` 全量计算，尚非增量统计。
- `history/live_transcript_reader.rs` **已经**维护 offset，seek 后用 64KiB buffer 读取；stamp 未变直接跳过正文和 probe；检测创建时间变化、截断、等长改写；prefix 256 + boundary 64 字节用于改写探测。
- Reader 处理半行/半 UTF-8、完整无换行 JSON、补换行去重、尾部继续写时 reset；最近 40 条加字节限制，支持 page/older。
- `history/live_transcript.rs` 每个 entry 一个线程 + notify watcher，父目录监听、超时等待/sleep、lease 清理；Reader 受 Mutex 保护。
- `history/tests/live_transcript.rs` 已有 `live_transcript_zero_idle_io_incremental_append_and_pagination_benchmark`、`live_transcript_half_utf8_tail_no_newline_and_reset_do_not_duplicate`。本次未运行，不引用 TAP_BENCH 数值。

后续任务应复用现有 reader 和测试，按目录共享 watcher、统一任务调度；不能重写一套仅按 offset 的 reader。catalog 聚合增量化需单独设计截断、重写、删除、会话元数据变化下的撤销/重算策略，不能把尾读直接替换统计扫描。首次全量扫描的有界并发和 JSON 引擎更换需实测证明收益。

## 对父设计的修订与后续顺序

1. D5 锁定 gpui-component 0.8.1 / gpui-pre 0.3.10，直接兼容，无 patch/fork。
2. P5 复用已有实时转录增量 reader；catalog 增量统计需另设撤销/重算策略。
3. `checkpoint_ansi_v1` 保留未验证；当前草稿存在明确失败，不能用可见网格相同承诺跨壳无损 attach。
4. 终端优先分离传输/ACK 与解析/绘制；100 MB 超时原因尚未定位，TCP_NODELAY 的 1 MB 对照未显示收益。
5. 继续 Windows 系统 IME、编辑器、预览窗口交互、窗口/托盘、P7 及正式性能测量；macOS 按用户要求暂缓。
6. 完整授权和硬门槛均未关闭，M0 不标完成，不启动 M1、生产迁移或发布。
