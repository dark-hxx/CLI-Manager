# 修复分屏 Workspan 实时统计链路

## Goal

修复分屏、Workspan、旧终端及外部 CLI 场景下实时统计因 Hook 投递或会话绑定失败而长期空白的问题，同时确保统计数据不会串到其他终端会话。

## Changelog Target

`[TEMP]`

## Root Cause

问题位于 Hook 事件从 CLI 进程跨越 daemon/前端边界并映射到 PTY Tab 的链路：事件投递失败或 `tabId` 无法命中当前终端时，`cliSessionId` 不会绑定，而统计面板在已识别 CLI 来源但未绑定时主动停止查询和轮询；分屏与 Workspan 只放大了这个状态依赖，并不会主动丢失会话 ID。

## Requirements

- 保留单个统计面板，始终跟随当前焦点分屏和当前 Workspan 的活动会话。
- Hook 事件使用稳定事件 ID；投递失败时有限重试，服务端按事件 ID 去重。
- 优先按精确 `tabId` 绑定；外部或旧终端事件只在来源、cwd、项目/worktree 与近期 PTY 活动能够唯一定位时绑定。
- 无法唯一定位时不得使用“项目最近会话”猜测，必须保持空态并记录诊断原因。
- 未绑定面板不查询“项目最近会话”；后续有效 Hook 到达时通过唯一候选规则自动恢复。
- Hook 后安装不强制重启 PTY；后续事件可通过 daemon 发现文件和安全映射恢复。
- Worktree、WSL 路径使用统一规范化规则；SSH 继续要求精确远端会话身份。
- 不新增用户可见状态或文案。

## Acceptance Criteria

- [ ] 鼠标、触摸或键盘聚焦任意分屏时，统计面板立即切换到该分屏。
- [ ] Workspan 切换、会话移动、拆出和嵌套分屏不改变 PTY Tab ID 或已绑定 CLI 会话 ID。
- [ ] Hook 短暂连接失败后能自动恢复，重复投递不会产生重复前端事件。
- [ ] 外部 Grok/旧终端 Hook 在候选唯一时绑定到正确 Tab，多候选时拒绝绑定。
- [ ] 后续有效 Hook 到达后，未绑定面板可自动恢复；没有 Hook 时保持安全空态，不展示其他分屏的最近会话数据。
- [ ] 主仓库、Worktree、WSL 和本地 PowerShell/CMD/Pwsh 路径匹配正确。
- [ ] SSH 未取得精确远端会话标识时不展示猜测数据。
- [ ] TypeScript 类型检查、Rust check/test、相关 Node 测试和 `git diff --check` 通过。
- [ ] `CHANGELOG.md` 与 `docs/功能清单.md` 已更新。

## Discovery List

- [x] PTY 创建与 Hook 环境注入：`src-tauri/src/commands/terminal.rs`
- [x] Hook 客户端投递与 daemon 发现：`src-tauri/src/hook_client.rs`
- [x] Hook HTTP 校验与事件出口：`src-tauri/src/claude_hook.rs`
- [x] 前端 Hook 监听：`src/App.tsx`
- [x] Tab/CLI 会话绑定与 Workspan 状态：`src/stores/terminalStore.ts`
- [x] 历史会话精确查询：`src/stores/historyStore.ts`
- [x] 统计面板门控与轮询：`src/components/terminal/TerminalStatsPanel.tsx`
- [x] 分屏焦点与面板目标：`src/components/TerminalTabs.tsx`
- [x] WSL 环境透传：`src-tauri/src/pty/manager.rs`，现有行为确认相关但无需重构
- [x] SSH 远端历史：保持精确身份约束，不引入最近会话兜底

## Scenario Matrix

- 窗口焦点：当前窗口、其他窗口、应用失焦。
- 分屏：当前 pane、同窗口其他 pane、深层嵌套 pane、鼠标/触摸/键盘激活。
- Workspan：单会话、多会话、跨 Workspan 切换、会话移动/拆出。
- 窗口状态：正常、最小化、托盘恢复。
- 焦点模式：开启、关闭。
- 运行环境：PowerShell/CMD/Pwsh、WSL、Bash、SSH。
- 项目路径：主仓库、Worktree、缺失 Worktree。
- Hook：已安装、未安装、终端创建后安装、只安装部分 CLI Hook。
- CLI：Claude、Codex、Pi、Grok、本地 PTY 与外部进程。

## Technical Approach

- 在现有 Hook payload 的兼容字段上增加本地事件唯一 ID，daemon 使用有界近期集合去重；客户端复用同一 ID重试并重新解析 daemon 目标。
- 抽取纯函数完成 Hook 目标解析和路径比较，store 只负责原子绑定与刷新信号。
- 统计面板继续只按已绑定 session ID 查询；恢复由后续 Hook 的唯一目标解析完成，不新增历史猜测、Tauri command 或数据库迁移。
- 保持严格会话校验：任何歧义均返回未绑定，不以可用性换取错误数据。

## Decision

**Context**：分屏场景中错误绑定比短暂空态更危险，同时旧终端和外部 CLI 需要无重启恢复能力。

**Decision**：采用“精确绑定优先、唯一候选恢复、歧义拒绝”的保守策略，并在投递层增加幂等重试。

**Consequences**：极端多候选场景仍可能提示等待 Hook，但不会串会话；不引入依赖、数据库迁移或强制 PTY 重启。

## Out of Scope

- 每个分屏同时展示独立统计面板。
- 自动重启正在运行的终端或 CLI 进程。
- 用项目最近会话替代精确会话绑定。
- 修改 SSH 远端历史身份协议。
