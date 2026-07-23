# 优化终端分屏拖拽性能

## Goal

参照 VS Code 1.130.0 SplitView/Sash 的直接布局策略，降低终端分屏分隔线拖拽期间的 React 渲染开销，使 pane 几何按动画帧跟随指针，并在拖拽结束时一次性持久化比例。

## Requirements

- `mousemove` 只记录最新比例，每个动画帧最多执行一次 DOM 几何更新。
- 拖拽期间不得通过 React state 逐帧重算并协调所有 pane 子树。
- 保持 pane 和 `XTermTerminal` 组件身份稳定，不丢失 scrollback。
- 继续复用现有物理像素对齐、嵌套 split 布局和 20%～80% 比例限制。
- `setSplitRatio` 仅在拖拽结束时调用一次；PTY、xterm resize debounce 和数据模型不变。
- 拖拽结束、失焦或组件卸载时清理 RAF、事件监听器、光标和选区状态。
- 不新增依赖，不修改后端或配置。

## Acceptance Criteria

- [ ] 左右、上下和深层嵌套分隔线连续拖拽时，pane 按动画帧跟随指针。
- [x] 移动期间不因 drag preview 触发逐帧 React state 更新。
- [x] 松手时应用最后一个指针位置，并只持久化一次最终比例。
- [ ] Workspan、范围过滤、Pane 全屏和高 DPI 像素对齐行为不回归。
- [x] 现有 split layout、terminal resize debounce 测试和 TypeScript/build 检查通过。

## Root-Cause Statement

问题位于 `SplitTerminalView` 的实时预览边界：RAF 回调仍调用 `setDragPreview`，导致每个拖拽帧都进入 React 渲染与协调；修复应落在 pane/divider DOM 几何预览层，而不是调整 PTY 或 xterm resize 协议。

## Out of Scope

- Tab 拖拽创建分屏、侧栏和右侧工具面板拖拽。
- PTY/daemon、终端持久化模型和 xterm resize 算法。

## Notes

- GitNexus 对 `SplitTerminalView` 与 `buildTerminalSplitLayout` 的影响等级均为 LOW。
- 当前工作区已有用户修改 `AGENTS.md`、`CLAUDE.md`，本任务不触碰。
- 用户明确要求不先同步已领先 2 个提交的 `origin/master`，直接在当前分支修改。

## Verification Status

- `npx tsc --noEmit`：通过。
- `npm run build`：通过。
- `node scripts/terminalSplitLayout.test.mjs`：6/6 通过。
- `node scripts/terminalResizeDebouncer.test.mjs`：3/3 通过。
- `git diff --check`：通过，仅有现有 CRLF 提示。
- GitNexus `detect_changes`：LOW，无受影响执行流程。
- 按前端质量规约未启动 Tauri；拖拽观感、Profiler 与 DPI 场景待人工桌面验证。
