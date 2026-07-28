# Self Review

## Scope

- 任务：`完善 Git Diff 行操作与无障碍`
- 风险：HIGH。GitNexus 对本次前端新符号返回 `UNKNOWN / target not found`，已降级按 Git Diff Viewer 契约和精确调用点复审；变更影响共享弹窗、固定 Diff、行级回滚选择及键盘焦点。
- 结论：选择模型独立于 DOM，Split / Unified 锚点规则明确；弹窗复用 Radix Dialog，未保留全局键盘监听。

## Scenario Matrix

- [x] Modal / pinned：Modal 使用焦点锁定与恢复；固定 Diff 复用选择模型但不创建第二层 Dialog。
- [x] Split / Unified：Split 的 old/new 锚点独立；Unified 跨 side 的 Shift 操作重置范围。
- [x] 鼠标 / 键盘：单击、Shift+单击、Enter/Space、Shift+方向键均落到同一选择纯函数。
- [x] 内容 / 文件 / options / view mode：身份变化会清空选择与锚点，避免旧行号进入新 Diff 回滚请求。
- [x] 本地 / WSL / SSH / 嵌套仓库：交互层不感知 Transport，继续由 payload capability 统一控制部分回滚。
- [x] 未跟踪 / 冲突 / 非 UTF-8 / 非 exact：不可用状态不渲染可聚焦 gutter，Controller mutation 仍有能力门控。
- [x] 中英文：Dialog 名称、gutter 行语义、选择数量和操作文案均同步。

## Findings And Fixes

1. 原弹窗使用手写 Portal 和全局 Escape 监听，没有标准焦点锁定与关闭恢复。
   - 修复：迁移到项目 Radix Dialog，首控件聚焦，关闭恢复触发元素，IME composing 时阻止 Escape 关闭。
2. 原行选择使用数组线性查询和单行切换，无法表达 Split 双锚点及稳定范围。
   - 修复：抽取 `gitDiffSelection.ts`，使用 Set、稳定顺序数组和 Map 索引，范围计算不依赖 DOM 行号。
3. 原选中状态主要依赖颜色，gutter 不可聚焦。
   - 修复：抽取 `GitDiffGutter.tsx`，增加 `+/-`、勾选、`aria-pressed`、focus ring 和固定槽位；选择栏增加 polite live region。
4. 复审重点检查了嵌套确认框、焦点恢复和选择清空时机。
   - 结果：顶层 Escape 由 Radix dismissable layer 管理；外层仅在自身关闭时恢复焦点；目标、内容、生成选项或视图模式变化均触发选择重置。

## Verification

- [x] `npx tsc --noEmit`
- [x] `npm run build`
- [x] 9 个 Git Diff / Git Store 测试文件，共 40 项通过。
- [x] `git diff --check`
- [x] 新增选择纯函数、键盘和无障碍契约测试。
- [x] Git Diff 职责文件均不超过 300 行。
- [x] 未发现直接 `console.log/info/warn`、TypeScript 抑制或新增依赖。
- [x] GitNexus staged 检测：25 个代码/规格文件、9 个符号、0 条受影响流程，最终风险 `low`。

按项目质量规范未启动 Tauri 桌面应用。IME、嵌套确认框、亮暗主题、125%/150%/200% 缩放、中英文切换及窄窗口视觉检查保留到父任务最终人工验收。
