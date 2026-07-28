# ADR: Git Diff 搜索、复制与 AI 上下文边界

- 状态：Proposed
- 日期：2026-07-28
- 决策范围：后续 `D07-A`、`D07-B`、`D07-C`

## Context

共享 Diff Viewer 已覆盖弹窗、固定页、实时与快照数据源，并完成 Hunk 虚拟化。下一阶段需要搜索和复制能力，但不能让 `useGitDiffController`、工具栏或 Transport 再次膨胀，也不能把 Diff 内容绕过用户直接注入 Agent。

## Decision

### 1. 状态与职责

- `useGitDiffSearch` 持有单个 Viewer 的 query、结果、active index 和 generation；关闭 Viewer 即释放，不进入 Zustand 或设置持久化。
- `gitDiffSearch.ts` 只负责从解析模型匹配并返回稳定定位描述。
- `GitDiffHunkList` 只消费定位意图，负责虚拟滚动与挂载后聚焦。
- `gitDiffPatchFormatter.ts` 只负责路径、Hunk、选中行和完整 Patch 的确定性格式。
- `gitDiffAiContextFormatter.ts` 只负责 metadata、有界内容和截断标记。
- `GitDiffCopyMenu` 只负责 capability、命令入口和双语反馈，不解析 Patch。
- 剪贴板适配器只写文本，不了解 Diff、项目或 Agent。

### 2. 数据权威

- 原始 Diff 是文件 header、换行和 Patch 字节的权威。
- `react-diff-view` 解析模型是 Hunk、行号、side 和选择范围的权威。
- DOM 不是数据源；虚拟化、折叠、主题和 Split/Unified 不得改变输出。
- 每次搜索与复制都绑定 `targetId + revision`；revision 不一致时取消命令。

### 3. Capability

```text
raw content exists
  -> canSearch / canCopyRaw
standard unified + verified mapping
  -> canCopyHunk / canCopyFilePatch
exact mode + selected changed lines + verified mapping
  -> canCopySelectedPatch
project/path metadata exists
  -> canCopyAiContext
```

只读不是复制限制；是否能生成可应用 Patch 由内容格式和 Diff options 决定。冲突、二进制和 Monaco fallback 不伪造 Patch。

### 4. 隐私

AI 上下文只生成文本并写入剪贴板。禁止读取剪贴板、持久化正文、遥测正文、自动选择 Session、自动发送或调用 Agent RPC。用户必须在外部粘贴动作中再次确认内容去向。

### 5. 性能

沿用现有 64 KiB Worker 阈值和硬限制。大内容搜索结果只返回定位描述；连续查询终止旧 generation。格式化按需执行，不在状态中长期缓存完整 Patch 或 AI 文本。

## Consequences

### Positive

- 弹窗、固定页、本地、WSL、SSH 和快照共享一套行为。
- 搜索、Patch、AI 格式可独立测试和交付。
- Controller、Transport 和工具栏保持职责清晰。
- 用户保留对 AI 内容的最终审阅和发送权。

### Negative

- 选中行正向 Patch 需要一套前端纯函数，必须用真实 Git fixture 验证。
- Monaco fallback 的搜索体验与主 Diff 搜索 UI 不完全一致。
- 大 Diff 搜索需要额外 Worker 生命周期管理，但不新增依赖。

## Rejected Alternatives

1. 直接复用 Monaco 查找：主 Diff 没有 Monaco model，且虚拟列表无法与 Monaco selection 对齐。
2. 从 DOM selection 生成文本/Patch：未挂载 Hunk、装饰行和 Split 布局会导致内容缺失。
3. 把搜索与格式化塞进 `useGitDiffController`：该 Hook 已承担加载和变更编排，会重新形成大文件。
4. 新增 Tauri/SSH 搜索或复制 RPC：纯文本操作没有跨进程收益，只增加平台与协议分支。
5. 直接发送到 Agent：会引入跨项目/Session 误投和敏感内容泄露风险，超出本轮授权。

## Verification Required By Follow-up Tasks

- 搜索：快速输入取消、同 Hunk/跨 Hunk、虚拟定位、边界不循环、Split/Unified 和 fallback。
- Patch：新增、删除、重命名、未跟踪、无尾换行、多 Hunk，并通过 `git apply --check`。
- AI：UTF-8 字节上限、完整行截断、遗漏行数、双语反馈，以及无网络/Agent 调用的架构断言。
