# 修复 Git 变更面板拖拽文件和目录到终端

## Goal

让 Git 变更面板中的文件和目录行可以像文件浏览器一样，通过鼠标拖动把路径粘贴到应用内任意可见终端；复用既有路径格式、跨项目/Worktree/SSH 路径解析和终端聚焦行为。

版本记录使用 V1.3.8。

## 分诊结论

本项属于根因修复：问题是行为性缺失，Git 文件树没有接入文件拖拽生产者与终端拖放消费者之间已有的 payload 契约，而不是终端接收或路径解析错误。

根因陈述：GitChangesTree / GitTreeNode 在 Git 文件行这一生产者边界未生成 TerminalFileDragPayload 并驱动 terminalFileDrag 的指针拖拽会话，因此已注册的终端 drop zone 从未收到 Git 面板来源的路径；修复应落在共享拖拽源接入层，而不是在终端输入层添加 Git 特判。

## Requirements

- R1：Git 变更面板的所有文件叶子行和目录行均可发起应用内终端路径拖拽，包括已修改、已添加、已删除、已重命名、冲突和未跟踪状态；目录使用其显示行对应的真实仓库相对路径。
- R2：指针移动超过现有 POINTER_DRAG_START_PX 阈值后，拖拽须显示跟随光标的预览，并通过 createTerminalFileDragPayload、beginTerminalFileDrag、updateTerminalFileDragPointFromEvent、commitTerminalFileDragDrop 和 endTerminalFileDrag 走现有统一协议。
- R3：Git 来源必须使用当前 activeRepoPath 派生的 gitTreeProject 作为 payload 的源根目录。嵌套仓库、已选子仓库和 Worktree 不得错误地以面板所属项目根目录拼接绝对路径。
- R4：终端目标不得新增 Git 特判、不得直接写 PTY。继续由 useTerminalInput 的已注册 drop zone 在目标边界解析 payload：同一项目位置保留既有 CLI 相对格式；不同本地/WSL 根、不同 Worktree、不同 SSH 主机或远端根目录使用绝对路径回退。
- R5：文件常规单击仍打开 Diff，目录常规单击仍展开/折叠；拖拽完成后不得误触这些动作；StageCheckbox、回滚按钮和右键菜单不得被拖拽手势劫持。
- R6：不能复制文件浏览器中已有的复杂指针拖拽、预览、阈值和清理逻辑。应抽取可由文件浏览器与 Git 面板共同使用的前端拖拽源 Hook/组件，并保持现有文件浏览器的拖拽到终端和文件树内移动行为不变。
- R7：不新增用户可见文案，因此不新增 i18n 键；必须更新 CHANGELOG.md 的 V1.3.8 段与 docs/功能清单.md 的 Git 变更面板相关功能条目。

## 非目标

- 不实现向操作系统、外部终端或原生文件管理器的拖放。
- 不修改 Rust、IPC、数据库、Git 命令、终端 PTY 写入或已有 useTerminalInput 的路径决策。
- 不改变文件浏览器内原有的文件/目录移动语义。

## 场景矩阵

| 维度 | 覆盖要求 |
| --- | --- |
| 目标 Pane | 当前 Pane、同窗口另一分屏和深层分屏均通过注册 drop zone 命中实际可见终端。 |
| 项目位置 | 同一仓库根保留相对 CLI 文本；不同项目、嵌套仓库或 Worktree 走源绝对路径。 |
| 运行环境 | local/WSL 使用 project.path；SSH 使用 remote_path，并把主机 ID 与远端根一起比较。 |
| Git 状态 | M/A/D/R/C/U/?? 全部可产生文件路径；D 不要求物理文件仍存在。 |
| 源节点类型 | 文件叶子和目录行均可拖拽；压缩的连续目录链使用显示行对应的链尾目录路径并保留目录尾斜杠。 |
| 交互状态 | 小于阈值的点击、复选框、回滚按钮、右键菜单和取消拖拽不能遗留拖拽状态或误开 Diff。 |
| 面板呈现 | 展开 Git 面板可用；面板关闭或折叠时没有可操作的源行，保持既有行为。 |

## 发现清单

- [x] src/components/git/GitChangesPanel.tsx：确认 gitTreeProject 已按 activeRepoPath 改写本地/SSH 根；接入共享拖拽源并把其事件/预览传给两棵 Git 树。
- [x] src/components/git/GitChangesTree.tsx：扩展树与节点之间的拖拽事件和完整项目上下文传递。
- [x] src/components/git/GitTreeNode.tsx：文件叶子和目录行绑定指针拖拽，并抑制拖拽后的点击；确认嵌套按钮不会触发拖拽，目录展开/折叠点击仍可用。
- [x] src/components/files/FileExplorerSidebar.tsx：把现有指针拖拽和预览改为使用共享实现，保留其未命中终端时的文件移动回调。
- [x] 新增共享前端 Hook/预览组件：集中阈值、payload 生命周期、rAF 预览更新、点击抑制和卸载清理。
- [x] src/lib/terminalFileDrag.ts：确认 payload、drop zone、聚焦和清理协议已完整，预期不改业务语义。
- [x] src/hooks/useTerminalInput.ts：确认目标端已按项目位置解析 payload 并追加命令分隔符，预期不改。
- [x] src/lib/terminalProject.ts：确认位置比较覆盖本地/WSL、Worktree、SSH host 与 remote_path，预期不改。
- [x] scripts/fileExplorerPathActions.test.mjs：扩展为 Git 文件树接入共享拖拽源的回归保护。
- [x] .trellis/spec/frontend/component-guidelines.md：把文件浏览器单一来源契约补充为共享文件路径拖拽源，记录 Git 变更文件行的覆盖范围。
- [x] CHANGELOG.md 与 docs/功能清单.md：记录 V1.3.8 修复。

GitNexus 的 query/context 在本仓库索引中未能解析相关符号（FTS/symbol not found），已按分诊闸机降级为组件契约、terminalFileDrag / useTerminalInput / terminalProject 源码和全仓 rg 发现清单；开工前仍会再次尝试受影响符号 impact。

## Acceptance Criteria

- [ ] 从 Git 变更面板拖动任一文件状态的文件行或目录行到可见终端，终端只粘贴一次正确路径并获得焦点。
- [ ] 同根目标终端获得原有 CLI 相对格式；跨项目、跨 Worktree、跨嵌套仓库或跨 SSH 根目标获得源绝对路径。
- [ ] Git 面板当前选择的子仓库根会体现在绝对路径中，不会回退父项目根。
- [ ] 拖拽到非终端、取消拖拽或未超过阈值，不打开 Diff、不改变暂存状态、不遗留全局拖拽会话或 user-select 样式。
- [ ] 文件浏览器现有拖到终端、跨项目绝对路径回退、文件树内移动和预览表现保持可用。
- [x] 静态回归测试覆盖 Git 文件/目录行与共享 Hook/终端 payload 契约；Node 测试通过。目录扩展后的全量类型检查需在并行 i18n 改动完成后复验。
- [x] CHANGELOG.md 与 docs/功能清单.md 已更新，且没有新增未翻译的用户可见文案。
