# 项目内存与使用体验优化分析

> Continued implementation: protected renderer/model/content caches, indexed history message paging, deferred complete tool/diff views, bounded local serialization with full checkpoint debt tracking, and sparse spool cursor indexing are implemented. Contracts and synthetic regressions are recorded in the three `11-01` Trellis tasks. Original findings below describe the pre-repair baseline; installation/language/long-run acceptance is not implied by source checks.

日期：2026-11-01。源码基线：`master` / `13df26a2`，与本地 `origin/master` 同步，开始时工作区干净。

## 结论

优先处理 **回放缓存与按需 patch 加载、资源采样主线程阻塞、daemon spool 故障与写放大**，然后处理隐藏终端和编辑器的驻留预算。不要先全局降低滚动历史、关闭 GPU、升级依赖或改写整个状态层。

本次是业务源码横向分析与定向故障验证，不是逐文件逐行审计，也不是安装版受控性能测试。只新增这份报告，没有改业务代码、配置、数据库、安装包或 Trellis 任务状态。

## 现场基线与证据边界

只读查询安装程序及其可确认的 WebView 子进程，未读取命令行、终端内容、环境变量、凭据、heap dump 或用户历史正文。

| 2026-11-01 14:40:26 的单次样本 | 数值 |
| --- | --- |
| 主程序 PID 36912 私有内存 | 56.6 MiB |
| daemon PID 16512 私有内存 | 5.6 MiB |
| 最大 WebView 子进程 PID 29188 私有内存 | 404.6 MiB |
| 主程序、daemon、WebView 子进程私有内存合计 | 约 725.7 MiB |
| 系统提交内存 / 当前提交上限 | 44.90 / 51.40 GiB |
| 系统提交余量 | 约 6.50 GiB |

- 工作集包含共享页，不能把多个进程的工作集简单相加后视为独占内存；上述合计使用私有内存，也不等同 GPU 显存。
- 后续三秒样本中，两个 WebView 子进程分别使用约 80.3% 和 35.2% 的单核 CPU，最大子进程私有内存为 486.5 MiB。未控制用户操作、PTY 输出和 GC 时点，不能据此认定空闲高 CPU、线性泄漏或某个具体组件责任。
- 安装文件仍为 1.4.4，mtime 为 2026-10-16 19:55:12，早于当前源码修复。现场样本不是新源码的性能验收。
- 当前主要占用在 WebView，而不是 daemon；但 native spool 的故障增长路径仍需要修复。不要混淆当前占用、条件性风险和历史崩溃根因。

## P1：下一轮优先修复

### 1. 回放缓存只有单会话数量限制，没有跨会话淘汰

证据：`src/features/terminal/api/replayStore.ts:720`、`src/features/terminal/api/replayStore.ts:825`。

- `sessions` 只保留最近 12 个，但 `eventsBySession` 通过对象展开不断加入会话，不随列表裁剪，也没有总字节预算或 LRU。
- 单会话限制 200 个事件，不能限制访问很多会话后总计保留的事件和 patch 文本。
- 使用真实模块方法和合成存储复现：访问 30 个会话，列表 12 个，事件缓存仍为 30 组。
- 推荐：保留当前会话和少量最近会话，以总字节数及 LRU 双限额淘汰；从 DB 恢复被淘汰的会话，不删除历史数据。关闭面板后允许释放非活动重载荷。

### 2. 打开回放就并发加载所有快照，且大 patch 读取失败不呈现错误

证据：`src/features/terminal/api/replayStore.ts:282`、`src/features/terminal/api/replayStore.ts:310`、`src/features/terminal/api/replayStore.ts:550`、`src-tauri/src/features/git/mod.rs:44`、`src-tauri/src/features/files/commands.rs:660`。

- `fetchEvents` 用 `Promise.all(rows.reverse().map(mapEvent))`，每个 snapshot 都立即读取完整 patch，最多 200 个同时进入读取路径，即使用户只看事件列表。
- 合成数据验证：16 个 snapshot 导致 16 次读取、峰值 16 次并发；实际源码没有该操作的并发限额。
- 每个成功读取的 patch 可接近 1 MiB，200 个快照的文本载荷可接近 200 MiB，尚未计入字符串表示、中间复制和其他会话缓存；这是容量推导，不是实测峰值。
- Git 快照允许生成 4 MiB，但重载使用通用 `file_read_text`，预检上限为 1 MiB。大于 1 MiB 的快照可能写入成功后读取失败。
- `hydrateSnapshotPayload` 仅记录 warning 后返回无 patch 的 payload；合成读取错误验证显示 store error 仍为 null。用户可能看到缺少 diff，而不是具体原因。
- 推荐：列表只加载元数据，展开某个 diff 时再加载；读取并发限制为 2；为回放建立受路径校验和实际字节上限保护的专用读取契约，与 4 MiB 写入上限一致。错误和重试状态同步中英文。不要提高所有文件预览的 1 MiB 限额。

### 3. 资源面板采样仍在 GUI 主线程

证据：`src-tauri/src/features/system/resources.rs:884`、`src-tauri/src/features/system/resources.rs:236`、`src/features/terminal/components/SystemResourcesPanel.tsx:873`。

- 命令是普通同步 `#[tauri::command]`，没有 async 标记；持锁执行进程、CPU、内存、磁盘、网络及 GPU 采样。
- Tauri v2 官方文档明确：这类同步命令默认运行在主线程。面板打开时，每 2.5 秒发起一次采样。
- 昂贵分项已有独立刷新缓存，前端也有 in-flight 防重入；问题不是没有缓存，而是采样线程归属。未实测特定硬件上的停顿时长。
- 推荐：把初始化、持锁采样放进有界 blocking worker，返回拥有所有权的快照；继续保留现有分项缓存及防重入。窗口隐藏时降低非必要资源轮询，不暂停 PTY 心跳或 native crash heartbeat。

### 4. spool 写入失败后，2 MiB ring 上限会失效

证据：`src-tauri/src/infrastructure/daemon/server/replay.rs:53`、`src-tauri/src/infrastructure/daemon/server/session_inventory.rs:26`。

- 溢出帧落盘失败时放回内存并退出治理循环，下一次输出继续增加 `total_bytes`。磁盘满、目录不可写或持续 I/O 错误时，活跃会话可以持续积累 RAM。
- 全局治理只淘汰已退出会话，不能约束这个活跃会话的增长。这是静态确认的故障路径，未在用户机器制造磁盘满或 OOM。
- 推荐：定义存储故障下的有限内存和背压策略，暴露明确的可恢复状态与错误频率限制；不能无限回退到 RAM，也不能无提示地丢弃用户输出。用临时合成 spool 和故障注入回归先锁定行为。

## P2：有明确收益，但需要跨层验收

### 5. spool 满额后的全量重写与回放全量复制

证据：`src-tauri/src/infrastructure/daemon/server/replay.rs:262`、`src-tauri/src/infrastructure/daemon/server/replay.rs:122`、`src-tauri/src/infrastructure/daemon/server.rs:693`。

- 10 MiB spool 达到上限后，后续溢写触发全量读取、从 Vec 头部裁剪并全量重写；每次维护都产生大块临时载荷和 I/O。
- 按单次新增 64 KiB 推导，重写接近 10 MiB 已约为新增数据的 160 倍，另有读取成本；更小输出块可能更差。这不是吞吐基准结果。
- ACK 补发会先读取全部 spool 并复制内存帧，再筛选待发序号；客户端慢、后台无 GUI 或输出密集时收益更明显。
- 推荐：分段有界 spool / 游标索引，按需要的 sequence 读取，避免每次扩容重写全文件。保持整帧、ANSI 边界、checkpoint、ACK 和截断契约，不增加历史保留容量来掩盖问题。

### 6. daemon 总预算没有计入 checkpoint

证据：`src-tauri/src/infrastructure/daemon/server/session_inventory.rs:36`、`src-tauri/src/infrastructure/daemon/server/replay.rs:164`、`src-tauri/src/infrastructure/daemon/protocol.rs:13`。

- 总治理按 `buffer.total_bytes` 计费，checkpoint 的 `Vec<u8>` 单独保留；帧上限为 8 MiB，会话上限为 64。
- 因而 128 MiB ring 预算不是整个 daemon 的堆内存上限，checkpoint、排队帧及回放临时复制都在预算之外。不能把最大组合推导当作当前实际占用。
- 推荐：为 checkpoint 建立独立总字节预算，同时统计 ring、checkpoint、spool、待发与临时回放；仍保护活动会话及恢复完整性。预算不能简单通过淘汰正在运行的任务实现。

### 7. 隐藏终端仍保留完整终端、滚动缓冲及部分 addon

证据：`src/features/terminal/components/PaneLeafView.tsx:196`、`src/shared/preferences/settingsStore.ts:156`、`src/features/terminal/hooks/useTerminalDisplay.ts:341`、`src/features/terminal/hooks/useXTermController.ts:1106`。

- 每个标签都挂载，非当前标签仅 `display:none`。默认滚动历史 9000 行，用户配置最多 50000 行。
- 低内存模式释放隐藏超过 10 秒的 WebGL，不 dispose xterm，也不清除正常滚动历史。ImageAddon 另有每实例 32 MiB 存储限额；限额不等于立即分配。
- 当前 xterm BufferLine 每单元使用三个 Uint32。填满 9000 行、200 列时，仅主缓冲单元数组约 20.6 MiB，未计可见行、对象、组合字符、渲染、图像及快照；未填满时不能套用此估算。
- 推荐：区分活动终端、短期温缓存、长期冷终端，以有限驻留实例和 renderer 预算治理。可借鉴 Tap 的三实例 LRU，但桌面不能直接照抄：必须验收 detach/attach、尚未 ACK 的输出、完整历史、鼠标/键盘协议和分屏。不要直接全局减少用户历史行数。

### 8. 编辑器和项目文件工作区缺少总驻留预算

证据：`src/features/files/api/fileExplorerStore.ts:616`、`src/features/files/api/fileExplorerStore.ts:1333`、`src/features/files/components/FileEditorContent.tsx:148`、`src/features/terminal/components/PaneLeafView.tsx:196`。

- 单文件已有文本 1 MiB、图片 5 MiB / 1200 万像素限制，但打开文件列表及跨项目工作区没有相应总字节预算。
- 文本内容、savedContent、图片 base64、Monaco model 与已解码图片各有驻留成本。相同字符串可能共享，不能假定每个字段都额外完整复制。
- 隐藏编辑器 pane 仍挂载；`isActive` 主要影响项目激活和行为，不自动卸载 Editor。
- 推荐：仅对干净、非活动的文件/工作区实行 LRU，保存视口状态再按需恢复；保护 dirty 文件、undo/redo、diff 草稿和重复项目编辑器的 model 生命周期。图片优先考虑有清晰 revoke 生命周期的资源 URL，避免长驻 base64。

### 9. 历史列表已优化，但大单会话详情仍全量传输

证据：`src/features/history/lib/historyCache.ts:4`、`src/features/history/components/SessionDetailPane.tsx:814`、`src-tauri/src/features/history/catalog/session_detail.rs:184`、`src/features/history/store/historyStore.ts:943`。

- 列表是 20 条分页，消息视图也已虚拟化，不能再把问题描述成 DOM 没有虚拟化。
- 详情仍 `fetch_all` 消息、parts 和工具数据，然后整包 IPC；前端保留全部 messages。虚拟化只减少 DOM，不减少传输和消息对象占用。
- 快速切换会话用 requestSeq 防旧结果覆盖，不能取消已经开始的解析、查询和传输。
- 推荐：详情按消息游标/范围加载，工具内容及大 diff 按需获取；全文搜索仍留在 SQLite/FTS。必须保护日期下钻、搜索跳转、编辑、收藏快照及原生 resume 身份，适合独立任务而非局部补丁。

### 10. 后台任务轮询重复，查询失败会让列表消失

证据：`src/features/terminal/hooks/useTerminalTabsController.tsx:1686`、`src/features/desktop-pet/api/useDesktopPetCoordinator.ts:244`。

- 工具栏和可见桌宠各有 3 秒轮询；工具栏入口没有请求 in-flight 保护。
- daemon 可返回可重试的 busy 状态，两处 catch 却都清空列表，导致任务暂时消失。它与 spool 慢 I/O 可以叠加；退出守卫另有独立保护，不能据此说会误杀任务。
- 推荐：复用单个会话列表查询服务，防重入，采用事件更新和低频兜底；失败保留最后有效结果，并标为未知/过期，而不是“零任务”。

### 11. 快照先完整同步序列化，再裁剪本地尾部

证据：`src/shared/lib/terminalSnapshot.ts:25`、`src/features/terminal/hooks/useXTermController.ts:1081`、`src/features/terminal/api/sessionSnapshotPersistence.ts:192`。

- 已有 dirty 检测及单飞；但 `addon.serialize()` 仍同步遍历完整缓冲，随后才生成 2000 行本地尾部，并向 daemon 上传完整 checkpoint。
- 当前 deadline 能释放异步等待，却不能抢占正在运行的同步 JS 序列化。超大历史、宽终端和多个脏终端下，CPU 与临时字符串峰值值得单独测量。
- 推荐：先加入受控耗时/字节基准，减少中间复制，区分本地尾部与完整 checkpoint 的工作。官方 serializer 支持 scrollback 选项，但不能直接把完整 checkpoint 改成 2000 行，否则会改变恢复契约。

## P3：低风险体验和启动优化

- **Emoji 数据按需加载**：`src/features/projects/components/NodeAppearancePanel.tsx:2` 被 Sidebar 静态导入，虽然 picker 尚未打开，数据模块已进入加载链。首次打开再载入，缓存后续结果；实际包体收益需生产 chunk 分析，不从依赖目录大小推断运行内存。
- **能力快照缓存随作用域回收**：`src/features/agents/api/useAgentCapabilities.ts:15` 的 snapshotCache / baselineFingerprints 没有 LRU 或删除路径；scopeKey 随会话/位置变化。增加有限预算与关闭会话清理，并保护配置变化基准。此项尚未做增长复现，优先级低于回放缓存。
- **性能设置集中展示**：低内存模式目前在 `src/features/settings/components/pages/DeveloperSettingsPage.tsx:188`。建议普通设置提供明确性能入口，资源面板区分本应用/WebView 私有提交、系统 commit 余量与物理 RAM；提示基于数值与持续时间，不自动关闭 GPU 或删历史。
- **读入上限约束实际字节**：`src-tauri/src/features/files/commands.rs:660` 在 metadata 限额检查后使用 `fs::read`。不断增长的文件可能在检查和读取间超限；建议 bounded read + 最终长度验证，复用 SSH 文件已有的 take(limit + 1) 模式，不只依赖预检。

## 已有措施：不重复实现

- 退出预算、在途 ownership、快照取消/暂停、sessionStore FIFO、控制 socket shutdown、诊断写盘隔离与 native commit heartbeat：上一轮实现仍保留。
- 历史列表分页、消息虚拟化、FTS、统计 LRU：前端统计缓存 16 项、项目选项 8 项；远程详情按 20 项 / 64 MiB 序列化字节预算淘汰。预算不是精确 Rust 对象堆占用。
- daemon reader batching、客户端输出队列与请求队列已有限额，不建议换成无界 channel；session spool 故障路径及 checkpoint 计费是例外。
- Tap 的 mounted 终端限额为 3，被淘汰时 detach 并清 stream。桌面端可复用思路，而不是重新设计 PTY 协议。
- Web outbox 具有 256 条 / 16 MiB 上限和错误保留通道；服务端 socket 有消息大小、发送队列、发送超时及慢消费者治理。没有做线上多设备压测。
- 资源面板关闭会停止其轮询，历史采样保留 48 个点；原生 crash heartbeat 与可选资源面板是两条独立链路。
- Monaco、重型统计面板已有延迟入口，Markdown 使用轻量语法高亮；不要把“包内存在重依赖”误判为启动已加载。
- 本地/SSH 预览有大小及像素限制，剪贴板原始 RGBA 留在后端；WebDAV 响应有 16 MiB 实际读取限额，同步导入/导出重操作已有 blocking 边界。
- providers、prompts、extensions、agents、sync、remote 的入口和容量/后台工作边界已横向检查；本报告没有证明它们所有场景都不存在性能问题。没有全仓类型检查、编译或无关重构。

## 推荐 Trellis 推进顺序

1. **回放内存与 diff 可用性**：事件缓存总预算/LRU、按需 patch、两路并发、专用一致读取上限、明确失败 UI。先固化本次合成复现为回归测试，再实现；不动 DB schema。
2. **采样与后台任务流畅度**：资源采样有界后台执行、列表共享单飞、busy 保留旧数据和过期状态。用慢采样、busy/timeout、隐藏窗口和桌宠开关矩阵验收。
3. **daemon 存储预算**：故障背压、checkpoint 计费、分段 spool 和按序号读取。先做满额/不可写/慢写/慢 ACK 的可控测试，保证不丢输入、不无声丢历史、不停止用户任务。
4. **桌面驻留与大历史详情**：分别建立独立任务，处理冷终端、干净编辑器 LRU、分页详情，避免将多个跨层行为改动合并成一次大重构。

本轮没有用户对新实现任务的创建/范围授权，因此未创建新 task，也没有变更上一轮 task。建议先推进第 1 项，暂不做全局参数降配。

## 本轮验证记录

- CodeGraph 两次查询均完成；GitNexus MCP 不可用，之后用当前源码与领域契约核对，不修改索引。
- Node VM 编译并执行真实 replayStore，mock 仅限结构化 DB、文件 IPC、Zustand 和日志；使用几十 KiB 级合成 patch，无用户数据、无真实内存压力。
- 已复现：30 会话产生 30 组事件缓存；16 快照并发读入；file_too_large 导致无 patch 且无 store error。
- 首次合成 harness 因缺少 debugConsole mock 未达到预期；补齐 mock 后重跑通过。此失败不计为产品缺陷。若干路径探索命令也已纠正，未作为功能验证结果。
- 大 patch 的 4 MiB / 1 MiB 不一致由两端源常量确认；没有打开用户文件来复现。
- spool、主线程采样、checkpoint 预算、冷终端等为源码证据；尚未受控复现安装版卡顿、磁盘满、native OOM 或新源码 heap 峰值。
- 没有执行 commit、push、安装替换、GUI 启动、真实 OOM/磁盘填满、生产网络请求或线上负载测试。所有本轮命令会话已退出，没有保留后台服务。

## 官方参考

- Tauri v2 同步/异步命令线程语义，经 Context7 查询：
  https://github.com/tauri-apps/tauri-docs/blob/v2/src/content/docs/develop/calling-rust.mdx
- xterm SerializeAddon scrollback/range 与 Terminal dispose，经 Context7 查询，并对照已安装 beta typings：
  https://github.com/xtermjs/xterm.js/blob/master/addons/addon-serialize/typings/addon-serialize.d.ts
  https://github.com/xtermjs/xterm.js/blob/master/typings/xterm.d.ts
- 单元数组估算来自已安装 xterm 源码 `node_modules/@xterm/xterm/src/common/buffer/BufferLine.ts:21` 和 `node_modules/@xterm/xterm/src/common/buffer/BufferLine.ts:89`，不是对当前 heap 的直接测量。
