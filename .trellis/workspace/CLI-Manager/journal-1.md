# Journal - CLI-Manager (Part 1)

> AI development session journal
> Started: 2026-04-21

---



## Session 1: Bootstrap frontend spec guidelines

**Date**: 2026-04-23
**Task**: Bootstrap frontend spec guidelines
**Branch**: `feat/compact-mode-launcher`

### Summary

Filled the frontend Trellis spec files, verified build, and captured current UI/component/state/type-quality conventions from the codebase.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `c7b2bd5` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 2: 全项目性能优化 MVP

**Date**: 2026-05-26
**Task**: 全项目性能优化 MVP
**Branch**: `feat/compact-mode-launcher`

### Summary

优化终端输出解码与隐藏缓冲、历史会话搜索匹配和 WebDAV 同步内存边界，并补充相关 Trellis code-spec。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `256549b` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 3: 修正 Claude Code IME 候选框漂移（底部优先锚点）

**Date**: 2026-06-15
**Task**: fix-claude-code-ime-drift
**Branch**: `master`

### Summary

上一轮"硬件光标就近双向扫描输入行"方案仍漂移：Claude Code 输入中文时候选框贴到屏幕顶部而非底部输入框。根因——TUI 的硬件光标（`buffer.cursorX/Y`）不指向底部真实输入框（输入框光标是 TUI 用反色字符画的视觉光标），而屏幕顶部历史回显的 `> hishu` 这类以 `>` 开头的行会被识别成输入行；就近双向扫描在光标漂移到上半屏时命中了顶部诱饵。改为从屏幕最底行向上扫描第一个输入行作为锚点（TUI/shell 当前输入框恒在底部），光标恰在该行时才返回精确光标以保留普通 shell 行内 caret。

### Main Changes

- `src/components/XTermTerminal.tsx` `resolveCompositionAnchorCell`：删除"光标在行即 return cursor + 就近双向扫描"两段，改为单向从 `terminal.rows-1` 向上扫第一个输入行；命中即锚点（光标在该行则返回精确光标），无输入行才回落硬件光标。净减代码，消除顶部诱饵死角。

### Testing

- [OK] `npx tsc --noEmit` 通过
- [ ] 运行态人工验收：Claude Code / Codex 中文 IME 候选框贴底部输入框；普通 shell 行内移动 caret 后 IME 跟随（待用户验证）

### Status

[进行中] 代码完成，待人工验收

### Next Steps

- 人工验证三场景：Claude Code 流式输出期间中文 IME、Codex、普通 shell 行内 caret 移动


## Session 3: V1.1.4 统计计费口径与界面一致性收口

**Date**: 2026-06-18
**Task**: V1.1.4 统计计费口径与界面一致性收口
**Branch**: `master`

### Summary

完成并提交 V1.1.4：统一模型价格计费来源、缓存用量文案、终端 Tab 状态展示、设置页外层容器和全局滚动条样式；归档 5 个 06-18 任务。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `271509d` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 4: 终端选区右键直接复制

**Date**: 2026-06-22
**Task**: 终端选区右键直接复制
**Branch**: `master`

### Summary

终端有选区时右键直接复制并关闭菜单，无选区时保留原右键菜单；提交 a5d339d。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `a5d339d` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 5: 优化子任务分屏流式输出

**Date**: 2026-07-10
**Task**: 优化子任务分屏流式输出
**Branch**: `master`

### Summary

Claude 启动阶段提前订阅子任务 transcript，Codex rollout 增加有界发现重试，并补齐跨平台契约、变更记录与功能清单。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `04f63bd` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 6: 优化项目列表拖拽排序即时反馈

**Date**: 2026-07-10
**Task**: 优化项目列表拖拽排序即时反馈
**Branch**: `master`

### Summary

项目与分组拖拽放手后先乐观更新 Zustand 项目树，再持久化 SQLite；失败时回滚，并同步更新 TEMP 变更记录与功能清单。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `e3bbee6` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 7: 终端文件路径快捷打开

**Date**: 2026-07-12
**Task**: 终端文件路径快捷打开
**Branch**: `master`

### Summary

为 xterm 终端输出添加绝对文件路径识别；项目或 Worktree 内文件使用内置编辑器打开，其他路径回退系统默认应用。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `180bd87` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 8: 完善 Workspan Tab 导航交互

**Date**: 2026-07-13
**Task**: 完善 Workspan Tab 导航交互
**Branch**: `master`

### Summary

补齐 Workspan Tab 右键菜单、隐藏滚动条、IDEA 风格下拉列表，并确保激活 Tab 自动滚入可视区域。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `cb3d998` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 9: 修复 Claude 状态栏编辑器与 Powerline 预览

**Date**: 2026-07-13
**Task**: 修复 Claude 状态栏编辑器与 Powerline 预览
**Branch**: `master`

### Summary

修复组件库固定高度、全局属性返回交互和 Powerline 字形显示；预览跟随终端字体并支持 ANSI256/TrueColor；Rust 主题色板按 colorLevel 对齐 ccstatusline-zh v2.2.23。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `08e632b` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 10: 添加 Workspan 开发开关

**Date**: 2026-07-13
**Task**: 添加 Workspan 开发开关
**Branch**: `master`

### Summary

新增默认开启的 Workspan 开发开关；关闭时恢复 Pane 内 Tab 分屏逻辑，并保留现有 PTY 与布局。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `3629d5e` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 11: 修复本地路径打开权限

**Date**: 2026-07-14
**Task**: 修复本地路径打开权限
**Branch**: `master`

### Summary

将项目、Worktree 与终端本地路径统一改由 Rust 命令打开，避免 WebView opener ACL/scope 拒绝；补充后端路径打开契约并完成编译、类型和格式验证。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `8701471` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 12: 统一应用内文本输入弹窗

**Date**: 2026-07-14
**Task**: 统一应用内文本输入弹窗
**Branch**: `master`

### Summary

移除状态栏配置流程中的 window.prompt，新增主题化应用内输入弹窗，并将禁用 window.prompt 写入前端规范。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `4132e23` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 13: 修复 Worktree 今日项目用量统计

**Date**: 2026-07-14
**Task**: 修复 Worktree 今日项目用量统计
**Branch**: `master`

### Summary

实时统计按当前 Worktree 实际路径聚合今日用量，避免 raw project_key 导致 Token 与费用缺失；同步更新统计契约、CHANGELOG 和功能清单。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `12a2b50` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 14: 简化 Worktree Tab 标题

**Date**: 2026-07-14
**Task**: 简化 Worktree Tab 标题
**Branch**: `master`

### Summary

统一新建、分屏、历史恢复及范围内 Worktree 终端标题为任务名，并更新 TEMP 变更记录与功能清单。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `5619a3e` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 15: 全局统一应用内确认对话框

**Date**: 2026-07-14
**Task**: 全局统一应用内确认对话框
**Branch**: `master`

### Summary

移除前端全部 window.confirm，新增 useAppConfirm 复用应用内 ConfirmDialog，并同步前端规范、变更记录和功能清单。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `34da804` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 16: 修复终端切换渐进重绘

**Date**: 2026-07-14
**Task**: 修复终端切换渐进重绘
**Branch**: `master`

### Summary

保留隐藏终端白屏恢复刷新，通过 xterm onRender 完成信号和超时兜底遮蔽渐进重绘；补充回归测试、变更记录和前端规范。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `904e4a3` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 17: Hook 桥接独立启用开关

**Date**: 2026-07-14
**Task**: Hook 桥接独立启用开关
**Branch**: `master`

### Summary

为 Claude Code 与 Codex CLI Hook 桥接增加独立启用配置，统一状态灯、自动修复、统计检查、快捷重装和终端 Hook 环境注入口径；同步中英文文案、变更记录、功能清单与 Hook 契约。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `a4019cd` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 18: 统一文件浏览器折叠目录聚合

**Date**: 2026-07-15
**Task**: 统一文件浏览器折叠目录聚合
**Branch**: `master`

### Summary

将已加载子树中的默认折叠目录和手动忽略目录统一收集到文件树底部单一聚合行，使用相对路径区分同名目录，并同步 TEMP 变更记录与功能清单。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `123e632` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 19: 修复 Claude 状态栏 Powerline 符号显示

**Date**: 2026-07-15
**Task**: 修复 Claude 状态栏 Powerline 符号显示
**Branch**: `master`

### Summary

定位 WebView2 无法解析系统注册字体的根因，改为通过 CSS @font-face 直接加载内置 Powerline 字体，并补充回归契约与 TEMP 变更记录。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `8e10baa` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 20: 修复历史会话恢复 CLI 参数

**Date**: 2026-07-16
**Task**: 修复历史会话恢复 CLI 参数
**Branch**: `master`

### Summary

统一历史详情与右键恢复入口，按项目来源和目录匹配配置；多匹配项提供搜索分组选择框，并继承 CLI 参数与启动环境。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `51c6ffd` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 21: 合并 VS Code 终端正确性分支

**Date**: 2026-07-18
**Task**: 合并 VS Code 终端正确性分支
**Branch**: `master`

### Summary

将 feat/vscode-terminal-correctness-completion 合并到最新 master，语义解决 6 个冲突，补齐测试桩并通过前端、Node 与 Rust 验证。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `7fd0c4a` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 22: 修复终端 OSC 颜色响应泄漏

**Date**: 2026-07-18
**Task**: 修复终端 OSC 颜色响应泄漏
**Branch**: `master`

### Summary

区分 live 与 replay 的 OSC 10/11 处理，合并实时颜色回复并补充回归测试与前端契约。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `5c5d55f` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 23: 精简项目多选右键菜单

**Date**: 2026-07-18
**Task**: 精简项目多选右键菜单
**Branch**: `master`

### Summary

项目多选后右键已选项目仅保留取消选择、启动已选、批量修改 Shell 和删除已选；同步更新 TEMP 变更记录与功能清单，并通过 TypeScript 类型检查。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `41885d7` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 24: Reduce default info log noise

**Date**: 2026-07-18
**Task**: Reduce default info log noise
**Branch**: `master`

### Summary

将常规扫描、轮询和诊断日志从 INFO 降为 DEBUG，保留关键生命周期日志，并将 daemon 缓冲区淘汰升级为 WARN。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `538a051` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 25: 版本化备份恢复

**Date**: 2026-07-18
**Task**: 版本化备份恢复
**Branch**: `master`

### Summary

将覆盖式同步重构为 V3 WebDAV 版本快照与本地 ZIP 备份，支持五域恢复、Outbox 重试、安全快照回滚和旧格式导入，并提交当前工作区全部改动。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `13f6d3d` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 26: 合并远程代码并解决冲突

**Date**: 2026-07-18
**Task**: 合并远程代码并解决冲突
**Branch**: `master`

### Summary

合并 origin/master 的 6 个远端提交，解决 Cargo.lock 与同步设置分类冲突，保留版本化备份并纳入远端崩溃报告和侧栏增强。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `41c1275` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 27: 修复 WSL Codex 子任务转录延迟

**Date**: 2026-07-20
**Task**: 修复 WSL Codex 子任务转录延迟
**Branch**: `master`

### Summary

修复 WSL Codex 子任务分屏仅在结束前显示文字的问题：发现重试绑定子任务生命周期并降频续扫，统一 WSL UNC 路径解析，避免 sessions 重复拼接；TypeScript、Rust 定向测试与 cargo check 通过。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `33679da` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 28: 修复终端图片插件 WASM CSP 崩溃

**Date**: 2026-07-21
**Task**: 修复终端图片插件 WASM CSP 崩溃
**Branch**: `master`

### Summary

为 Tauri CSP 增加 wasm-unsafe-eval，并在 xterm ImageAddon 加载失败时安全降级；补充回归测试、变更记录和前端兼容契约。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `b457aa9` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 29: CLI 启动参数历史与同步

**Date**: 2026-07-22
**Task**: CLI 启动参数历史与同步
**Branch**: `master`

### Summary

为新建项目增加按 CLI 工具统计、按次数和最近使用时间排序的 CLI 参数历史下拉，仅展示前 10 条；历史随偏好设置快照同步，并补充测试、国际化、功能清单和同步契约。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `79a6f9d` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 30: 文件预览熔断保护

**Date**: 2026-07-22
**Task**: 文件预览熔断保护
**Branch**: `master`

### Summary

禁止视频预览，并为本地与 SSH 文件浏览增加 1 MiB 文本、5 MiB 图片和 12 MP 光栅图片读取熔断；补充本地化提示、测试、文档与契约。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `9ca8c923` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 31: 修复 Codex 子任务窗格自动关闭

**Date**: 2026-07-23
**Task**: 修复 Codex 子任务窗格自动关闭
**Branch**: `master`

### Summary

为 Codex 子任务转录补充 task_complete/turn_aborted 终态兜底，统一自动关闭延迟并更新契约与文档。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `0347ab8e` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 32: 修复跨 Workspan 终端空白

**Date**: 2026-07-23
**Task**: 修复跨 Workspan 终端空白
**Branch**: `master`

### Summary

修复普通终端跨 Workspan 分屏重挂载时 StrictMode 探测实例覆盖有效快照的问题，并补充重挂载输出契约测试。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `5cd5011d` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 33: 完善终端 Tab 悬浮信息卡

**Date**: 2026-07-24
**Task**: 完善终端 Tab 悬浮信息卡
**Branch**: `master`

### Summary

修复 Workspan 单会话 Tab 悬浮卡缺失，使悬浮卡跟随终端主题，并补齐字段图标、CLI 厂商图标与路径复制。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `592729e9` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 34: 终端状态标记设置与视觉优化

**Date**: 2026-07-31
**Task**: 终端状态标记设置与视觉优化
**Branch**: `feat/terminal-status-marker-settings`

### Summary

新增默认关闭的终端状态标记开关；焦点色跟随终端主题，顶部样式两侧缩短为 2%，并补齐测试、规范与文档。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `5603bde1` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 35: 终端状态标记设置预览

**Date**: 2026-07-31
**Task**: 终端状态标记设置预览
**Branch**: `feat/terminal-status-marker-settings`

### Summary

优化终端状态标记设置 Demo，修复边框展示，并增加完成、错误、审批颜色选项与双 Demo 实时联动。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `2e73f3a7` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 36: 修复子任务分屏滚动条与工具栏

**Date**: 2026-08-03
**Task**: 修复子任务分屏滚动条与工具栏
**Branch**: `master`

### Summary

完成子任务分屏工具栏按钮按会话类型过滤，并实现覆盖式滚动条、悬浮放大、拖拽同步及终端主题颜色复用；提交到 master，类型检查和差异检查通过。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `b7c148b7` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 37: 修复项目切换丢失文件预览与 Tab 卡死

**Date**: 2026-08-05
**Task**: 修复项目切换丢失文件预览与 Tab 卡死
**Branch**: `master`

### Summary

按文件位置缓存项目编辑工作区，保留已打开文件与未保存内容；切断项目同步 effect 的状态反馈循环，并补充相关回归测试与规范。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `f5544d3b` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 38: 统一终端侧边栏标题与缓存命中率

**Date**: 2026-08-06
**Task**: 统一终端侧边栏标题与缓存命中率
**Branch**: `master`

### Summary

统一实时统计、文件、Git 变更、时间轴和系统资源面板的标题尺寸与终端主题背景，并在 Token 用量卡片中补充缓存命中率。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `fb89406a` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 39: 彻底修复多会话终端输出卡死

**Date**: 2026-08-06
**Task**: 彻底修复多会话终端输出卡死
**Branch**: `master`

### Summary

合并 PR #197，并补充 daemon 64 KiB 有界聚合、跨终端公平 xterm 调度、回归测试和可执行契约。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `e46052c2` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 40: 对齐供应商快捷侧边栏

**Date**: 2026-08-10
**Task**: 对齐供应商快捷侧边栏
**Branch**: `feat/native-provider-management`

### Summary

统一供应商面板标题栏，简化路由与状态展示，并同步规范、文档和国际化文案。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `16e7b9e8` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 41: 修复 WSL CLI Home 手动输入

**Date**: 2026-08-11
**Task**: 修复 WSL CLI Home 手动输入
**Branch**: `feat/native-provider-management`

### Summary

修复供应商设置 CLI Home 在 WSL 自动模式下同时禁用目录选择和文本输入的死路；允许直接编辑或粘贴 WSL UNC，并在首次输入时切换为手动模式。完成契约、Changelog、功能清单同步，TypeScript 与 GitNexus staged 影响检查通过。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `ee8b4b98` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 42: 修复 WSL CLI Home 自动解析与目录选择

**Date**: 2026-08-11
**Task**: 修复 WSL CLI Home 自动解析与目录选择
**Branch**: `feat/native-provider-management`

### Summary

修复 Local→WSL 时沿用 host identity 导致 Home 自动解析错误的问题；后端自动探测默认发行版与真实 HOME，前端同步 identity，并启用 Local/WSL 目录选择与手动编辑。类型检查、12 个 Home 单测和 cargo check 均通过。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `68be1e60` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 43: Fix WSL Home cold-start detection

**Date**: 2026-08-11
**Task**: Fix WSL Home cold-start detection
**Branch**: `feat/native-provider-management`

### Summary

Reproduced default WSL Home detection taking 12.3 seconds, separated 30-second cold-start detection from 5-second directory validation, added timeout policy coverage, and verified 13 focused Rust tests plus cargo check.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `cd1930b6` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 44: 修复 Codex 历史 sub-agent 层级

**Date**: 2026-08-11
**Task**: 修复 Codex 历史 sub-agent 层级
**Branch**: `feat/native-provider-management`

### Summary

贯通 Codex session_meta 的 parent_thread_id/forked_from_id，从 Rust 历史解析、SQLite catalog 到前端层级树；保留 Claude 路径兼容并补充回归测试。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `c266572a` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 45: Unify sidebar provider switching with CLI Home

**Date**: 2026-08-11
**Task**: Unify sidebar provider switching with CLI Home
**Branch**: `feat/native-provider-management`

### Summary

Aligned sidebar provider switching with settings global CLI Home apply flow, added local/WSL mode indicators, recorded bilingual UI/docs/contracts, and archived the task.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `22c8b8b6` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 46: 修复文件面板路径复制二级菜单裁剪

**Date**: 2026-08-12
**Task**: 修复文件面板路径复制二级菜单裁剪
**Branch**: `feat/native-provider-management`

### Summary

实现文件面板与 Git 变更面板的绝对路径、AI 路径和相对路径复制；修复窄侧栏中二级菜单被 overflow-x-hidden 裁剪的问题，统一通过 ContextMenu Portal 渲染子菜单。npx tsc --noEmit 通过。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `af5403f7` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 47: 修复路径复制菜单交互与图标

**Date**: 2026-08-12
**Task**: 修复路径复制菜单交互与图标
**Branch**: `feat/native-provider-management`

### Summary

将路径复制 Radix 旁侧子菜单改为原位替换菜单，隐藏一级菜单项，统一文件菜单样式，使用 Sparkles/Link2 语义图标并恢复切换后的键盘焦点；补充 TEMP 变更记录、功能清单与前端菜单契约。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `72538d0d` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 48: 修复供应商故障转移排序持久化

**Date**: 2026-08-13
**Task**: 修复供应商故障转移排序持久化
**Branch**: `feat/native-provider-management`

### Summary

移除供应商侧栏重复上下移动图标；关闭自动故障转移时保留已有队列和 sort_index 顺序；补充前后端回归测试、功能清单、CHANGELOG 与供应商域契约。验证通过 npx tsc --noEmit、cargo check、provider routing focused tests 22/22。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `d4df1777` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 49: 修复路由请求日志重复与布局

**Date**: 2026-08-13
**Task**: 修复路由请求日志重复与布局
**Branch**: `feat/native-provider-management`

### Summary

对照 CC Switch 的代理权威/会话回退策略，修复路由归属与缓存语义跨源去重，统一历史统计匹配，并让五张请求日志汇总卡片同排自适应。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `16b3e051` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 50: 修复自动故障转移当前供应商高亮

**Date**: 2026-08-17
**Task**: 修复自动故障转移当前供应商高亮
**Branch**: `master`

### Summary

修复自动故障转移队列首个非当前供应商成功后未提交为当前供应商的问题，并精简供应商快捷面板路由开关辅助文字；补充回归测试、产品记录与后端契约。

### Git Commits

| Hash | Message |
|------|---------|
| `d9d04050` | (see git log) |

### Status

[OK] **Completed**


## Session 51: 修复应用重启后本地路由未恢复

**Date**: 2026-08-17
**Task**: 修复应用重启后本地路由未恢复
**Branch**: `master`

### Summary

daemon 连接完成后自动协调持久化路由意图，复用手动启停逻辑并恢复完整本地/WSL listener 与端口状态；补充回归测试、功能清单、CHANGELOG 和后端契约。

### Git Commits

| Hash | Message |
|------|---------|
| `a3958343` | (see git log) |

### Status

[OK] **Completed**


## Session 52: 修复供应商目录残留选中态

**Date**: 2026-08-24
**Task**: 修复供应商目录残留选中态
**Branch**: `master`

### Summary

供应商详情关闭后仅清除目录视觉选中态，保留缓存选择用于重新进入详情；新增回归测试并更新供应商契约与 TEMP 产品记录。

### Git Commits

| Hash | Message |
|------|---------|
| `320d4d6f` | (see git log) |

### Status

[OK] **Completed**
