# Performance Optimization Across Terminal, Lists, History, State, Startup

## Goal

优化 CLI-Manager 的关键交互性能。用户明确表示可以牺牲包体积，只关注运行时性能。优化范围覆盖：终端渲染、大列表渲染、历史解析/搜索、Zustand 状态更新、启动与终端恢复。

## What I already know

- 项目是 React 19 + Tauri 2 桌面应用，前端使用 Zustand，终端使用 xterm.js。
- `package.json` 已有 `@xterm/addon-webgl`，说明终端 WebGL 优化不一定需要新增依赖。
- 可能受影响的核心文件：
  - `src/components/XTermTerminal.tsx`：xterm 初始化、主题、输出订阅、fit/webgl 相关逻辑。
  - `src/components/history/HistoryListPane.tsx`：历史会话列表渲染。
  - `src/components/CommandPalette.tsx`：命令面板过滤与列表渲染。
  - `src/components/sidebar/ProjectTree.tsx`：项目树列表/分组渲染。
  - `src/stores/historyStore.ts`：历史会话加载、搜索、分页状态。
  - `src/stores/terminalStore.ts`：终端会话、恢复、active session、split 状态。
  - `src/stores/projectStore.ts`：项目树构建与派生数据。
  - `src/App.tsx`：启动加载、会话恢复、全局面板装配。
  - `src-tauri/src/commands/history.rs`：后端历史命令，若优化历史解析/搜索可能涉及。
- 前端质量规约要求避免热路径内逐项分配大字符串，隐藏终端输出必须有界缓冲。
- 状态规约强调 persisted compound field 需要 migrator；本任务优先避免新增持久化字段，降低兼容风险。

## Assumptions (temporary)

- 优先优化用户可感知卡顿，而不是追求理论指标。
- 可以新增前端依赖，但只有在现有实现成本明显更高时才引入。
- 默认不改数据库 schema，不改 Tauri IPC 返回结构，除非历史搜索/解析确认必须后端化。
- 默认先做安全的前端优化：渲染批处理、虚拟化、memo/selector、启动恢复调度。

## Requirements (evolving)

- 终端渲染：减少高频输出时 React/xterm 主线程压力，优先启用/复用 WebGL 与批处理写入。
- 大列表：历史列表、命令面板、项目树在大量数据下减少 DOM 节点和重复计算。
- 历史解析/搜索：避免 UI 热路径逐条 `toLowerCase()` 等大字符串分配；必要时将重计算下沉到后端或 Worker。
- 状态更新：减少 Zustand 全量订阅导致的无关重渲染，使用 selector、浅比较、memo 化派生数据。
- 启动与恢复：首屏优先，非必要恢复和重任务延后；终端恢复过程避免一次性阻塞 UI。

## Open Questions

- 无。

## Acceptance Criteria (evolving)

- [ ] 多终端持续输出时，隐藏/非活跃终端不会造成无界内存增长。
- [ ] 历史列表、命令面板、项目树在大量条目下减少一次性 DOM 渲染量。
- [ ] 搜索逻辑避免热路径中对每条大文本反复分配完整小写副本。
- [ ] 主要全局 store 订阅点不因无关字段变化触发大面积重渲染。
- [ ] 启动流程优先完成首屏渲染，再恢复非首屏/非活跃任务。
- [ ] `npx tsc --noEmit` 通过。
- [ ] 如修改后端，`cd src-tauri && cargo check` 通过。
- [ ] 如修改 UI，运行应用并手动验证关键路径。

## Definition of Done

- 最小必要改动，不做无关重构。
- 遵守 Trellis 前端质量规约和状态管理规约。
- 所有被改动的符号修改前运行 GitNexus impact analysis。
- 完成后运行 `gitnexus_detect_changes()` 检查影响范围。
- 能验证的性能路径必须实际验证；不能验证的部分明确说明。

## Technical Approach

采用强性能版，但仍按最小必要改动落地：

- 新增 `@tanstack/react-virtual`，用 `useVirtualizer` 处理历史会话列表、命令面板结果列表、项目树可见项渲染。
- 保留现有 xterm WebGL；增强输出写入批处理与隐藏缓冲刷新策略，避免大 burst 直接一次性写入阻塞主线程。
- 历史会话本地过滤使用预计算/正则匹配，避免热路径中逐项创建大写/小写副本；全局历史搜索继续走现有后端命令，除非实现时确认前端仍有明显阻塞。
- Zustand 订阅改为更细粒度 selector / shallow selector，避免 CommandPalette、HistoryWorkspace、App 因无关 store 字段变化重渲染。
- 启动流程保持首屏优先，把自动同步、更新检查、终端恢复/启动命令等非首屏任务延后或分批调度。

## Implementation Plan

1. 依赖与虚拟化基础：安装 `@tanstack/react-virtual`，更新 `package.json` / lockfile。
2. 大列表虚拟化：改 `HistoryListPane`、`CommandPalette`、`ProjectTree`，并保留键盘导航、选中态、滚动加载、拖拽行为。
3. 终端热路径优化：改 `XTermTerminal` 输出 flush 策略，限制隐藏输出恢复时单帧写入量。
4. 历史与状态优化：改 `HistoryWorkspace` 本地过滤/消息检索热路径，减少重复字符串分配；按需调整 store selector。
5. 启动恢复优化：改 `App` / `terminalStore.restoreSessions` 的任务调度，避免启动阶段一次性阻塞。
6. 验证：跑 TypeScript 检查；若动 Rust 后端则跑 cargo check；运行应用手动验证终端、命令面板、历史面板、项目树、启动路径。

## Decision (ADR-lite)

**Context**: 用户要求优化 5 个性能方向，并明确“不需要那么在乎体积，舍弃体积，只在乎性能”。

**Decision**: 采用强性能版：允许新增专用虚拟化库、Worker 管线、更多预缓存/预加载逻辑，但仍避免无关架构重写。用户已同意新增 `@tanstack/react-virtual`，并允许 npm 更新 `package.json` / lockfile。

**Consequences**: 包体积和实现复杂度会上升；需要更严格验证终端、历史、命令面板、项目树、启动恢复等关键路径，避免性能优化引入交互回归。

## Out of Scope

- 不做视觉重设计。
- 不修改业务功能定义。
- 默认不改 SQLite schema。
- 默认不新增远程服务或后台常驻进程。
- 默认不做大规模架构重写。

## Technical Notes

- Trellis packages context: single-repo project; spec layers are `frontend` and `backend`.
- Relevant frontend specs read:
  - `.trellis/spec/frontend/quality-guidelines.md`
  - `.trellis/spec/frontend/state-management.md`
- Relevant shared guides read:
  - `.trellis/spec/guides/code-reuse-thinking-guide.md`
  - `.trellis/spec/guides/cross-layer-thinking-guide.md`
- Relevant backend spec index read; backend changes require stable Tauri command signatures and `cargo check`.
- GitNexus query found relevant files but did not produce reliable full flow context for all frontend components; before editing each symbol, run targeted `gitnexus_impact`.
