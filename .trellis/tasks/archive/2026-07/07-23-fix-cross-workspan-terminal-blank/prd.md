# 修复跨 Workspan 分屏后普通终端空白

## Goal

修复将顶层普通终端拖入另一个 Workspan 分屏后，终端内容不可见、必须输入命令或清屏才恢复的问题。保持原 PTY 进程和 Session ID，不触碰后端、IPC、依赖或分屏几何逻辑。

## Changelog Target

`[TEMP]`

## Requirements

- 根因位于 Workspan 布局迁移造成的 `XTermTerminal` 卸载/重新挂载：旧 xterm 的内存缓冲区必须在布局卸载阶段保存，并在新实例挂载时恢复。
- 恢复顺序必须是：打开 xterm、写入快照并完成刷新/fit、再订阅实时 PTY 输出；迁移期间未提交的输出必须继续补发且不重复。
- React StrictMode 探测挂载不得提前消费启动提示符；订阅任务必须可取消，卸载时清理计时器和监听器。
- 不改变 `mergeTerminalWorkspansAtPaneEdge`、Pane 树数据结构、PTY 生命周期、IPC 协议或公开接口。
- 复用现有 `TerminalSession.initialTerminalOutput` 与 `updateSessionTerminalSnapshot`，保留当前未提交修改，不回退无关变更。

## Acceptance Criteria

- [ ] 带提示符和历史输出的空闲 PowerShell 顶层 Terminal 拖入另一 Workspan 的左、右、上、下边缘后，内容立即可见。
- [ ] 迁移期间产生的新输出只出现一次，输入无需先清屏；Session ID、当前目录和 Shell 状态保持不变。
- [ ] 重复拖入、分离、嵌套分屏及 React StrictMode 下不再出现空白或重复输出。
- [ ] Codex/Claude Code 终端不重启、不重复 resume，TUI 重绘正常。
- [ ] 自动化测试、TypeScript 检查和人工桌面验证通过。

## Technical Approach

- 在 `XTermTerminal` 的 layout-effect cleanup 中序列化当前 xterm 缓冲区，避免被动 effect cleanup 晚于新实例读取状态。
- 新实例优先写入 `initialTerminalOutput`，完成后再启动可取消的 PTY 输出订阅；复用 `TerminalProcessManager` 现有 generation/commit 机制处理迁移期间的积压帧。
- 增补输出管理器的已提交/未提交重挂载契约测试，以及终端挂载时序的源码契约测试；不引入 React 测试依赖。

## Out of Scope

- 不保留选择区、搜索状态或精确滚动位置；恢复后回到实时底部。
- 不重构 Workspan/Pane 布局，也不通过 Portal 或全局 DOM 注册表保持 xterm 实例身份。

## Definition of Done

- 相关测试通过，`npx tsc --noEmit` 通过，`git diff --check` 无新增问题。
- `[TEMP]` Changelog 和终端人工验证清单记录已复核，无重复条目。
- 未修改用户已有的无关工作区变更。

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
