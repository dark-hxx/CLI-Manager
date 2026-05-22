# 全项目性能优化

## Goal

降低 CLI-Manager 在多终端、大量终端输出、大历史会话和同步数据较大时的 CPU 与内存占用；优先处理已能从代码确认的热路径，避免为了“优化”做大规模重构。

## What I already know

* 用户目标：扫描全项目，针对 CPU 和内存占用做性能优化。
* 项目是 React 19 + Tauri 2 + Rust，终端使用 xterm.js + WebglAddon，状态管理使用 Zustand。
* 前端已有终端输出按 animation frame 批量写入，但仍存在 Base64 解码、Uint8Array 分配、隐藏终端缓冲和多终端常驻挂载成本。
* 后端 PTY reader 已有批量阈值，但仍会对每批输出做 Base64 编码并通过 Tauri event 推送。
* 历史读取/搜索/统计路径会扫描 jsonl 文件并解析 JSON；大历史下 CPU 成本明显。
* 同步上传/下载/导入路径存在全量 JSON/String/Vec 读写，峰值内存可能放大。
* 当前任务只处于需求发现/规划阶段，尚未修改业务代码。

## Requirements

* 全项目扫描性能热点，覆盖前端 React/Zustand/xterm 和 Rust/Tauri/PTY/历史/同步路径。
* 优先选择对 CPU/内存收益明显、改动局部、风险可控的优化。
* 不新增依赖，除非后续明确证明收益大且获得确认。
* 不改变用户可见功能语义：终端输出、历史搜索、Diff、同步导入导出结果应保持一致。
* 每个实际优化点必须有验证方式：至少类型检查/编译检查，必要时补手动压测步骤。
* 避免大规模架构重写；先做 MVP 性能修补，再视结果决定是否继续深入。

## Acceptance Criteria

* [ ] 形成热点清单，标出文件、行号、成本来源和风险等级。
* [ ] 对选定 MVP 热点实施最小改动优化。
* [ ] TypeScript 类型检查通过：`npm run build` 或 `npx tsc --noEmit`。
* [ ] Rust 检查通过：`cd src-tauri && cargo check`。
* [ ] 关键功能手动验证：终端输出、隐藏/切回终端、历史搜索、Diff 打开、同步导入/导出中受影响部分。
* [ ] 记录可复现的性能验证方式，例如大输出、大历史或多终端场景下观察 CPU/内存变化。

## Definition of Done

* Tests/checks pass where applicable.
* No behavior regression in affected user flows.
* No new dependency unless explicitly approved.
* Performance-sensitive paths avoid不必要的全量 clone、重复 lower-case、频繁持久化、过大缓冲或常驻实例。
* Rollback is straightforward: each optimization should be localized and independently revertible.

## Technical Approach

先做“热点驱动”的小步优化：

1. 终端链路：减少非活动终端的内存堆积和主线程写入压力；评估终端组件常驻挂载策略。
2. 历史链路：避免无查询时构建全文 lower-case 索引；限制超大消息高亮/worker 传输成本；把后端重扫描类工作移出 async worker 热路径。
3. 同步链路：优先控制导入/下载峰值内存和文件大小边界，必要时改为流式解析。
4. 设置链路：减少颜色/字体滑动时的高频 store 持久化与终端 refit。

## Decision (ADR-lite)

**Context**: “全项目优化”范围很大，直接全量重构风险高，也难验证收益。  
**Decision**: 用户选择第一批“全做一批”，覆盖终端、历史、后端 I/O、设置高频更新四类已确认热点；仍坚持每个点做局部最小改动，不做架构重写。  
**Consequences**: 一次性能覆盖更多真实占用来源，但会触碰更多文件，验证成本和回归面高于单一批次；每个优化点必须可独立回退。

## Out of Scope

* 不引入新的性能监控平台或 profiling 依赖。
* 不重写 xterm、历史系统或同步系统架构。
* 不改变历史数据格式、同步文件格式或终端协议语义。
* 不做 UI 大改版。
* 不做远程/生产环境性能采集。

## Technical Notes

### Confirmed hotspots

| Area | Location | Cost | Candidate fix |
|---|---|---|---|
| PTY 输出前端解码 | `src/components/XTermTerminal.tsx:222-243` | 每包 `atob` + `Uint8Array.from` + `TextDecoder`，高吞吐下 CPU/GC 明显；隐藏终端最多 1MB/会话缓冲 | 降低隐藏缓冲、优化 flush 策略，评估后端直接传文本或更小复制路径 |
| 多终端常驻 | `src/components/TerminalTabs.tsx:292-309` | 所有会话都挂载 xterm/WebGL/监听器，会话数增加时内存线性增长 | MVP 可限制非活跃终端保留策略或先降低非活跃资源占用 |
| 历史列表索引 | `src/components/HistoryWorkspace.tsx:154-170` | session 列表每次构造 lower-case haystack | 仅在查询非空时构建，或把可见分页前置 |
| 历史消息搜索 | `src/components/HistoryWorkspace.tsx:206-221` | active session 全量 lower-case message，消息大时内存翻倍 | 查询非空时懒构建；按需扫描而非长期保存 lower-case 副本 |
| 消息高亮渲染 | `src/components/history/SessionDetailPane.tsx:149-180` + `src/components/history/historyViewUtils.tsx` | 大消息 split 成大量 React 节点 | 超长消息限制高亮或只高亮命中片段 |
| Diff worker 输入 | `src/components/history/DiffModal.tsx:138-146` | 打开 Diff 时复制整会话 messages 给 worker，结构化克隆峰值高 | 只传含 diff/patch 关键词的消息，或预过滤 content |
| 设置高频更新 | `src/components/settings/pages/GeneralSettingsPage.tsx:384-399,446-455` | color/range 输入每次 change 都持久化并触发全局更新/refit | draft + debounce/onBlur/onPointerUp 提交 |
| PTY 后端编码 | `src-tauri/src/pty/manager.rs:127-151` | 输出批次 Base64 编码 + Tauri event 字符串传输 | 先调批量阈值/统计；如可行改事件 payload 形态 |
| PTY 写入 | `src-tauri/src/pty/manager.rs:197-219` | 每次写入持锁并 flush | 仅在确认不会影响交互后再评估批量写入，MVP 暂谨慎 |
| 历史后端扫描 | `src-tauri/src/commands/history.rs:236-354`、`src-tauri/src/commands/history.rs:964-1083` | async command 内同步扫盘、逐行 JSON parse/lower-case | `spawn_blocking` 包住重扫描/搜索，减少阻塞 Tokio worker |
| 同步全量内存 | `src-tauri/src/sync/mod.rs:71-78,151-157`、`src-tauri/src/webdav/mod.rs:65-72` | 全量 JSON/String/Vec 导致峰值内存放大 | 加大小边界，局部改为 stream/to_reader |

### Selected MVP scope

用户选择“全做一批”，本任务同时覆盖以下四类热点，但每类只做局部低风险优化。

**Batch A: 终端优先**

* 优化隐藏终端缓冲和 flush。
* 降低多终端场景常驻资源压力。
* 风险：终端输出不能丢失当前用户关心的内容；需要手动验证活跃/非活跃切换。

**Batch B: 历史优先**

* 懒构建 lower-case 索引。
* Diff worker 预过滤消息。
* 超长消息限制高亮成本。
* 风险：搜索命中、高亮和 Diff 结果必须保持一致。

**Batch C: 后端 I/O 优先**

* 历史扫描放入 `spawn_blocking`。
* 同步导入/下载加大小边界或减少中间分配。
* 风险：Tauri command 错误处理与同步兼容性需要验证。

### Files inspected

* `package.json`
* `src-tauri/Cargo.toml`
* `src/components/XTermTerminal.tsx`
* `src/components/TerminalTabs.tsx`
* `src/components/HistoryWorkspace.tsx`
* `src/components/history/SessionDetailPane.tsx`
* `src/components/history/DiffModal.tsx`
* `src-tauri/src/pty/manager.rs`
* `src-tauri/src/commands/history.rs`
* `src-tauri/src/sync/mod.rs`
* `src-tauri/src/webdav/mod.rs`
* `src/components/settings/pages/GeneralSettingsPage.tsx`

### Tooling notes

* 本地 hook 曾在读取文件后报 `bash: xmalloc: cannot allocate 8192 bytes`，说明当前环境本身可能已有内存压力；后续验证时需要注意区分应用占用与工具链/hook 占用。
