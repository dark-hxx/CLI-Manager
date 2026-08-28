# 修复 Diff 窗口点击回退导致卡死

## Changelog Target

`V1.3.6`

## Goal

修复打开 Git Diff 弹窗后点击文件级回退按钮，确认操作不可见且界面失去响应的问题；同时统一侧边栏折叠态项目的图标和单击/双击行为。

## Background and Root Cause

- Git Diff 文件级回退入口位于 `src/components/git/diff/GitDiffHeader.tsx:27-45` 与 `src/components/git/diff/GitDiffToolbar.tsx:188-202`。
- 入口经 `GitDiffReviewDialog` 转发到 `GitChangesPanel.handleRequestDiscard`，再由父级渲染 `ConfirmDialog`。
- Diff 弹窗内容 `src/components/git/diff/GitDiffDialogFrame.tsx:20-59` 使用内容层 `z-index: 101`、遮罩层 `z-index: 100`；Git 面板中的回退确认框 `src/components/git/GitChangesPanel.tsx:1331-1344` 未指定层级，沿用 `DialogContent` 默认 `z-index: 50`。
- 因此确认框位于活动 Diff 模态层下方；外层 Diff Dialog 仍保持打开，Radix 两个 modal 的焦点管理也同时生效，用户看到的是被遮挡/无法交互的界面。

根因陈述：**当 Diff 窗口处于打开状态时，文件级回退确认框在父组件以低于 Diff 模态层的层级挂载，导致确认框不可见并与外层焦点陷阱冲突；修复应落在该确认框的模态层级边界，而不是在回退异步逻辑中添加兜底。**

## Requirements

- 文件级回退确认框必须显示在 Git Diff 弹窗之上，并可正常点击确认、取消及按 Esc 关闭。
- 变更块（Hunk）回退必须先显示二次确认框，确认后才调用既有回退动作。
- 确认回退后，既有 `discardFile`/`revertHunk`、Git 状态刷新和 Diff 目标刷新行为保持不变。
- 取消确认或关闭确认框后，Diff 弹窗仍可继续操作，不得改变当前文件、导航位置或选择状态。
- 只调整 Git Diff 回退确认框的层级/生命周期边界，不修改全局 `ConfirmDialog` 默认层级，避免影响其他 19 个直接消费者。
- 不新增依赖，不改变 Tauri/Rust 命令协议，不改变本地、WSL、SSH 的回退实现。

## Discovery List

- [x] `GitDiffHeader.tsx` / `GitDiffToolbar.tsx`：确认文件级回退触发点，二者均只调用 `onRequestDiscard`，与卡死的层级问题无关。
- [x] `GitDiffReviewDialog.tsx`：确认 Diff 弹窗到父级确认状态的转发链路。
- [x] `GitDiffDialogFrame.tsx`：确认活动 Diff 模态层级为 overlay `100`、content `101`。
- [x] `GitChangesPanel.tsx`：确认父级 `ConfirmDialog` 使用默认层级，是修复触点。
- [x] `ConfirmDialog.tsx` / `ui/dialog.tsx`：确认默认层级由通用组件提供；GitNexus 评估其上游风险为 `CRITICAL`，因此不改全局默认值。
- [x] `gitStore.ts` / `gitTransport.ts`：确认回退异步链路本身不负责弹窗展示，作为确认后行为保持不变。
- [x] `GitDiffEditorHost.tsx`：确认固定到编辑器后的回退确认框已有独立渲染路径，需回归验证但不直接修改。
- [x] `GitDiffHunkBlock.tsx`：确认变更块回退按钮直接调用 `controller.revertHunk`，是新增二次确认的修复触点。
- [x] `src/lib/i18n.ts`：确认 Git Diff 文案按 `zh-CN`/`en-US` 分区维护，新增确认文案需同步双语。
- [x] `ProjectTree.tsx` / `TreeNodeItem.tsx` / `CliToolIcon.tsx`：确认折叠态项目按钮与展开态项目行存在独立渲染和点击路径，CLI 图标已有共享解析器可复用。

## Scenario Matrix

| 维度 | 覆盖场景 | 预期 |
|---|---|---|
| Diff 宿主 | Git 面板 Diff 弹窗 / 固定到编辑器 | 弹窗回退确认可见；编辑器路径行为不回归 |
| 回退动作 | 文件级回退 / Hunk 回退 / 选中行回退 | 文件级与 Hunk 回退需确认；选中行回退保持原行为 |
| 侧边栏模式 | 展开 / 折叠 / 紧凑嵌入 | CLI 图标一致；单击跳转已有 Tab；双击启动新 Tab |
| 确认结果 | 确认 / 取消 / Esc | 确认执行回退；取消/Esc 保留 Diff 操作能力 |
| 窗口焦点 | 当前窗口聚焦 / 失焦后恢复 | 不出现不可恢复的焦点锁定 |
| 分屏与会话 | 单会话 / 多会话及 Workspan 切换 | 不串改其他终端或 Diff 状态 |
| 运行环境 | 本地 PowerShell/CMD/Pwsh / WSL / SSH | 确认层行为一致，后端回退实现不变 |
| Worktree | 主仓库 / Worktree / 目录已不存在 | 仅验证层级修复不扩大路径行为；既有错误提示保留 |
| Hook | Claude/Codex Hook 已安装 / 未安装 / 单独安装 | 与该 UI 模态层级无关，不应产生额外行为 |

## Acceptance Criteria

- [x] 在 Git Diff 弹窗中点击文件级回退，确认框显示在 Diff 弹窗上方且按钮可操作（调用点设置 `zIndex={220}`）。
- [x] 确认回退后，回退请求完成，Diff/Git 状态按既有流程刷新；未修改原有异步链路。
- [x] 取消或 Esc 关闭确认框后，Diff 弹窗仍可点击导航、关闭和其他工具栏按钮（层级修复不改变状态链路）。
- [x] Hunk/选中行回退路径不受影响。
- [x] Hunk 回退增加二次确认，确认后仍复用原有异步回退与刷新链路。
- [x] 固定到编辑器后的回退确认路径不回归；该路径未使用 Git 面板的外层 Diff Dialog。
- [x] 折叠态项目使用与展开态一致的 `CliToolIcon`；运行中项目不再以状态圆点替代 CLI 图标。
- [x] 折叠态项目和分组浮层项目单击只选择/跳转已有 Tab，双击才启动新终端。
- [x] 折叠态分组浮层背景不再过度透明，项目内容保持可读。
- [x] `npx tsc --noEmit` 通过；未启动 Tauri 开发/构建命令。
- [x] `CHANGELOG.md` 的 `V1.3.6` 已增加该修复记录。
- [x] `docs/功能清单.md` 已有 Git Diff 文件级回滚条目，无需重复新增。

## Out of Scope

- 不修改 `ConfirmDialog` 全局默认 `z-index`。
- 不重构 Radix Dialog，不改变 Git 回退协议、Rust 命令或 Transport。
- 不新增回退确认交互、批量回退能力或新的 Diff 功能。
