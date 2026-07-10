# 优化子任务分屏流式输出

## Goal

修复子任务分屏只能在子任务完成后显示内容的问题。子任务执行期间，只要独立 transcript 已产生或继续写入，分屏就应持续增量展示可读内容。

## Changelog Target

`[TEMP]`

## What I already know

- 前端已监听 `subagent-transcript-append`，并通过 `appendSubagentTranscript` 增量更新分屏内容。
- Rust `SubagentTranscriptBridge` 已支持 tail JSONL 文件并发送增量事件。
- 当前问题集中在子任务执行中无法及时发现或订阅独立 transcript，完成事件到达后才拿到路径或发现文件。
- 用户明确期望采用子任务流式输出，而不是完成后一次性回填。

## Requirements

- 子任务启动后尽早发现对应独立 transcript，并建立持续 tail 订阅。
- transcript 新增内容应增量进入现有子任务分屏，不等待 Stop/完成事件。
- Claude 与 Codex 现有事件格式和路径保护逻辑不得回归。
- 流式发现与订阅必须兼容 Windows 原生、WSL、Linux 和 macOS。
- 不使用父会话 transcript 冒充子任务正文。
- 不新增依赖，不修改无关分屏或普通终端逻辑。
- 新增或修改用户可见文案时同步维护中文与英文。

## Acceptance Criteria

- [ ] 子任务运行期间产生的 transcript 内容可逐步显示。
- [ ] transcript 文件晚于启动事件创建时，应用可在合理时间内发现并订阅。
- [ ] Stop/完成事件仍能正确收尾，并保留最终增量。
- [ ] 多个并行子任务的内容按各自分屏隔离，不串流。
- [ ] Windows 原生路径、WSL UNC/Linux 路径、Linux 原生路径和 macOS 原生路径均使用现有平台路径解析规则正确订阅。
- [ ] 缺少独立 transcript 时保留状态提示，不读取父会话正文。
- [ ] 前端类型检查通过，相关 Rust 测试或编译检查通过。

## Out of Scope

- 重构通用终端分屏树。
- 修改 Claude Code 或 Codex 自身的 transcript 生成行为。
- 历史会话子任务树或历史回放能力。

## Technical Notes

- 重点链路：`src/App.tsx` Hook 路由 -> `src/stores/terminalStore.ts` transcript 发现/订阅 -> `src-tauri/src/commands/subagent_transcript.rs` 文件 tail -> `src/components/terminal/SubagentTranscriptView.tsx` 增量解析。
- Rust tail 已支持“订阅时文件尚不存在”：线程会等待文件创建，再按完整 JSONL 行持续推送。因此 Claude 已知 `cwd/sessionId/agentId` 时可在 Start 阶段直接订阅推导路径，无需等待 Stop。
- Codex rollout 路径不能直接推导，当前 `openSubagentTranscript` 只在 Hook 事件到达时单次扫描；Start 时文件尚未出现就会错过，通常到 Stop 再次扫描才回填。
- 现有 Claude 目录 discovery 只覆盖部分缺少 `agentId` 的 AgentTool fallback，且发现任意文件后就停止，不适合作为已知子任务的统一流式发现方案。

## Proposed Approach

- Claude：只要 Start/更新事件已具备 `cwd + sessionId + agentId`，立即调用现有 `subagent_transcript_subscribe` 订阅推导出的 child JSONL；后端 tail 自行等待文件出现并流式发送。
- Codex：为每个 pending 子任务启动有界短轮询，重复调用现有 `codex_subagent_transcript_discover`；找到 rollout 后立即建立现有 tail 订阅并停止轮询。
- 平台路径继续复用现有后端规则：Windows 使用本机用户目录，WSL 使用 `wslDistroName` 或 UNC cwd 推导发行版并转换路径，Linux/macOS 保持原生绝对路径，不默认套用 WSL 转换。
- Stop：保留现有“最后一次发现/晚到路径升级后再 finish”的兜底，并清理对应发现定时器。
- 不修改 Rust command 签名，不新增依赖，不读取父 transcript 正文。

## Impact Analysis

- `startSubagentDiscovery`：GitNexus 风险 `MEDIUM`，直接影响仅 `src/stores/terminalStore.ts`，间接影响来自该 store 的广泛导入；需要重点回归普通终端、并行子任务和关闭分屏清理。
- GitNexus 未能把 Zustand 对象属性 `openSubagentTranscript` 识别为独立符号；按文件级影响处理，避免修改公开 store action 签名。

## Verification Results

- `npx tsc --noEmit`：通过。
- `cargo test subagent_transcript --lib`：11 个相关测试通过，覆盖 Windows/WSL 路径推导、原生 Linux/macOS 路径保持、显式发行版优先级和完整 JSONL 行增量读取。
- `git diff --check`：通过，仅有仓库既有 LF/CRLF 转换提示。
- GitNexus `detect_changes`：风险 `LOW`，未识别到受影响执行流程。
- 未启动 Tauri 桌面应用；运行中流式展示和并行子任务隔离需要人工桌面验证。
