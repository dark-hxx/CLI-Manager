# JetBrains 风格 Git Diff 审阅能力升级

## Goal

参考 IntelliJ IDEA 2026.1 Diff Viewer，在不复制完整 IDE 的前提下，补齐 CLI-Manager Git Diff 的高频审阅能力，并按职责边界拆分现有大文件。

## Changelog Target

`[TEMP]`

## Confirmed Decisions

- 所有任务在 `feat/git-power` 分支完成，目标分支为 `master`。
- 使用一个父任务和按 P0/P1/P2 拆分的子任务。
- 单击 Git 变更文件仍默认打开弹窗；用户可将 Diff 固定到编辑器。
- 固定页必须是完整实时视图，继续支持导航与文件/Hunk/行级回滚。
- P0/P1 形成可实施规格；P2 仅完成研究与 ADR，不直接实现。
- 不新增前端依赖，复用现有 React、Zustand、react-diff-view、Monaco 和 TanStack Virtual。

## Requirements

- P0 建立共享 Diff 组件边界，增加变更导航、显示模式、源码跳转和完整实时固定页。
- P1 增加空白/上下文选项、行选择与无障碍、大 Diff 性能治理。
- P2 调研搜索/复制/AI 上下文、图片/二进制比较和三方冲突编辑器。
- 本地、WSL、SSH 和嵌套仓库必须使用同一前端交互，环境差异只存在于 `GitTransport` 和后端执行层。
- 所有破坏性操作继续经过后端状态复核、Patch dry-run 和现有确认流程。
- 新增或修改的用户文案必须同步 `zh-CN` 与 `en-US`。
- 新增文件按职责拆分；文件超过 300 行时必须重新审查是否混入了第二项职责。

## Child Tasks

| Order | Priority | Task | Dependency |
|---:|---|---|---|
| 1 | P0 | `07-27-git-diff-viewer-foundation` | none |
| 2 | P0 | `07-27-git-diff-review-navigation` | foundation |
| 3 | P0 | `07-27-git-diff-editor-pin` | foundation, navigation |
| 4 | P1 | `07-27-git-diff-generation-options` | foundation |
| 5 | P1 | `07-27-git-diff-interaction-a11y` | navigation |
| 6 | P1 | `07-27-git-diff-large-performance` | foundation |
| 7 | P2 | `07-27-git-diff-review-tools-research` | navigation, performance |
| 8 | P2 | `07-27-git-binary-image-diff-research` | none |
| 9 | P2 | `07-27-git-three-way-merge-research` | none |

## Acceptance Criteria

- [x] P0/P1 六个实施任务均通过各自验收并形成独立提交。
- [x] P2 三个研究任务均形成证据、ADR、风险和后续垂直切片建议。
- [x] 默认弹窗入口、历史 Diff、终端统计 Diff 和现有回滚能力无回归。
- [x] 本地、WSL、SSH、根仓库和嵌套仓库通过场景矩阵验证。
- [x] `CHANGELOG.md` 的 `[TEMP]` 和 `docs/功能清单.md` 与最终行为一致。
- [x] GitNexus `detect_changes` 或规定的降级发现清单确认影响范围符合设计。

## Out of Scope

- 本轮不实现可编辑右侧代码、图片/二进制 Diff、三方合并和直接发送内容到 Agent。
- 不重写 Git 面板的提交、分支、网络或冲突操作。
- 不引入新的 UI、Diff、状态管理或测试框架。

## Risk

整体风险为 **HIGH**：共享 Git Store、远程 Agent 协议和不可逆回滚均被涉及。每个实施子任务必须先完成符号影响分析，发现 HIGH/CRITICAL 时暂停并报告。
