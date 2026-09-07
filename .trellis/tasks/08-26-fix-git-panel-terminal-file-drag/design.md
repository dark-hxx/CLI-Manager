# 技术设计：Git 文件和目录行接入共享终端拖拽源

## 1. 数据流

GitTreeNode 文件叶子或目录行
  → 共享 useTerminalFilePointerDrag 源控制器
  → TerminalFileDragPayload（相对 CLI 文本 + 绝对路径 + 源位置 + 文件/目录 kind）
  → terminalFileDrag 当前会话与最后指针坐标
  → 注册的 TerminalDropZone
  → useTerminalInput 按目标项目位置解析并调用 terminal.paste

拖拽源不决定目标终端使用相对还是绝对路径；该决定必须保留在 useTerminalInput 的目标边界。

## 2. 源项目上下文

GitChangesPanel 已计算 gitTreeProject：本地/WSL 时以 activeRepoPath 覆盖 path，SSH 时以 activeRepoPath 覆盖 remote_path。共享 Hook 使用该完整 Project 创建 payload，确保：

- 多仓库项目中选中的嵌套仓库是源根；
- linked Worktree / 子仓库不会误拼为父项目路径；
- SSH payload 同时保留 remote_path 和 ssh_host_id。

GitChangesTree 与 GitTreeNode 当前只声明了路径复制所需的窄 Project Pick。实现时应将其项目 Props 提升为共享 payload 所需的 Pick，或直接复用导出的 TerminalFileDragProject 类型；不得让节点自行猜测项目根。

## 3. 复用设计

把 FileExplorerSidebar 中已验证的自定义指针拖拽职责提取为一个前端 Hook（建议位置 src/hooks/useTerminalFilePointerDrag.tsx）及其预览渲染结果：

- 输入：源 Project、带 path/kind 的泛型文件条目，以及可选的“未落到终端”回调。
- 输出：onPointerDown / onPointerMove / onPointerUp / onPointerCancel、拖拽后点击抑制判断和 Portal 预览。
- 行为：仅主按钮、无修饰键时记录起点；越过 POINTER_DRAG_START_PX 后创建 payload；每帧仅直接更新预览 transform；抬起时先尝试 commitTerminalFileDragDrop；取消、未命中、卸载均清理 drag state 和 body user-select。
- 预览继续使用既有 ui-file-drag-preview 样式和 terminal drop-zone 高亮，避免视觉回归。

FileExplorerSidebar 改用该 Hook，并把其已有“未落到终端时按目标目录移动文件”的逻辑作为可选回调传入。GitChangesPanel 用同一 Hook，不传该回调，因此非终端落点只清理，不会触发 Git 操作。

这样复杂的阈值、预览、payload 生命周期和点击抑制只有一份；文件浏览器保留原有文件树内部移动能力，Git 面板只增加所需的终端投递能力。

## 4. Git 文件/目录行交互

GitTreeNode 的文件和目录行接收上层传入的共享 Hook 事件：

- 行内 StageCheckbox 和回滚 button 是交互控件，pointerdown 不能启动拖拽。
- 指针拖动成功后标记该行，紧接发生的 click 不调用 onFileClick 或目录 toggle。
- 小于阈值时原 onFileClick / 目录 toggle 保持不变；右键不满足主按钮条件。
- 文件行传入 kind=file；目录行传入 kind=directory，并使用 displayNode.path（压缩目录链的链尾真实路径），使格式化器保留目录尾斜杠。
- 文件状态不作为拖拽资格条件：路径文本对 D/R/C/U/?? 同样有用途。

不使用 HTML5 draggable / DataTransfer 作为主要手势路径：文件浏览器当前行已明确 draggable=false，稳定的应用内拖放依赖 Pointer Capture、内存 payload 和注册 drop zone。既有原生 drag handler保留在文件浏览器原路径，避免额外扩展本任务范围。

## 5. 保持不变的边界

- src/lib/terminalFileDrag.ts 保持 TerminalFileDragPayload、drop zone 与 paste/focus 一次提交的统一语义。
- src/hooks/useTerminalInput.ts 保持现有 isSameProjectFileLocation 决策、legacy MIME 兼容和 terminal.paste 路径。
- src/lib/terminalProject.ts 保持路径归一化及本地/SSH 位置判断。
- 不涉及 Rust、IPC、数据库、Git Store 命令、原生文件拖放或 i18n。

## 6. 验证设计

自动验证：

1. 扩展 scripts/fileExplorerPathActions.test.mjs，断言共享 Hook 仍使用 createTerminalFileDragPayload 与完整提交/清理链路。
2. 断言 GitChangesPanel / GitChangesTree / GitTreeNode 传递并绑定文件与目录行拖拽，而行内 button 不成为拖拽源、目录 click 仍保留。
3. 断言 FileExplorerSidebar 已使用共享 Hook，且未命中终端的文件移动回调仍保留。
4. 运行 node --test scripts/fileExplorerPathActions.test.mjs、npx tsc --noEmit；必要时运行 npm run build。

人工验证（用户当前没有 macOS 测试环境，交付时明确标为待验）：

- 本地/WSL/SSH：同根与不同根终端；
- 主仓库、嵌套仓库、Worktree；
- 当前 Pane、另一分屏、深层分屏；
- M/A/D/R/C/U/?? 文件、聚合目录和压缩目录链，以及单击、复选框、回滚、右键、取消拖拽；
- 文件浏览器的普通拖拽、跨项目拖拽和树内移动。

## 7. 风险与回滚

主要风险是把 FileExplorerSidebar 的既有指针拖拽改为共享 Hook 时造成文件树内移动或点击行为回归。用其现有未命中回调、静态回归断言和 TypeScript 编译保护；如出现问题，回滚共享 Hook 接入与 Git 事件传递即可，终端输入、Git 命令和数据层不会受影响。
