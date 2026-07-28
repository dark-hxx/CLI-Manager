# 研究 Git Diff 搜索复制与 AI 上下文

## Goal

为 Diff 内搜索、路径/Hunk/Patch 复制和 AI 上下文复制建立统一交互与数据格式，形成后续可独立实施的 ADR 和垂直切片；本任务不修改产品代码。

## Background

- P0/P1 将先完成共享 Diff Viewer、导航、交互和大 Diff 性能治理，本研究不得绕开这些公共边界另建工具栏。
- 仓库已有 `copyAiText`、`formatAiPathBlock`、`formatAiAnchor`、`formatAiContextBlock`，但尚无 Diff 专用的复制格式契约。
- `FileEditorPane` 已复用 Monaco 查找和 AI 上下文复制能力，可作为行为参考，不能直接把文件编辑器状态耦合进 Diff Viewer。

## Requirements

- 定义当前文件 Diff 内搜索的范围、匹配模型、键盘导航、虚拟列表定位和空/超限状态。
- 定义复制仓库相对路径、完整 Hunk、所选变更行和标准 Patch 的明确格式，保证复制结果可独立识别目标文件。
- 定义 AI 上下文文本格式，至少包含项目、仓库相对路径、变更范围和必要的 Diff 内容，并给出内容上限与截断标记。
- 复用现有剪贴板与路径格式语义；用户可见成功、失败、禁用提示必须同时覆盖 `zh-CN` 与 `en-US`。
- 搜索和文本组装优先在前端完成，不为纯文本操作增加 Tauri/SSH RPC 或新依赖。
- AI 能力仅限“复制上下文到剪贴板”，不得直接发送到 Agent、不得持久化 Diff 内容、不得采集剪贴板内容。
- 本地、WSL、SSH、实时 Diff 和历史快照 Diff 使用同一格式；只允许 capability 决定某个复制动作是否可用。
- 输出 ADR 草案、风险、场景矩阵和可独立交付的后续垂直切片。

## Acceptance Criteria

- [ ] `research.md` 记录现有复用点、差距和不新增依赖的依据。
- [ ] 搜索、路径复制、Hunk/Patch 复制、AI 上下文复制均有输入、输出、边界与快捷键建议。
- [ ] 明确超大 Diff、重命名、删除、未跟踪、冲突、二进制和快照只读场景的行为。
- [ ] ADR 草案明确状态归属、格式契约、隐私边界和不直接发送 Agent 的决定。
- [ ] 后续工作拆为可单独验收的垂直切片，并标明对 P0/P1 子任务的依赖。
- [ ] 本任务只产生规划文档，不修改 `src/`、`src-tauri/` 或依赖清单。

## Out of Scope

- 直接向 Claude、Codex 或其他 Agent 注入上下文。
- 跨文件/全仓库搜索、正则替换或 Diff 内容编辑。
- 剪贴板历史、云同步或新的 Prompt 管理体系。

## Risk

风险为 **MEDIUM**：主要风险是复制错误范围、虚拟列表定位不稳定和大 Patch 阻塞 UI，不涉及写仓库。
