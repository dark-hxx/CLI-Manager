# ADR: 三方冲突编辑器采用后端权威会话

- 状态：Proposed
- 日期：2026-07-28
- 风险：CRITICAL

## Context

Git 冲突的 Base/Ours/Theirs 权威数据位于 index stage 1/2/3，不在工作区 marker。外部 Git、编辑器、分支操作和远程断线都可能使已加载内容过期。普通文件保存与通用 stage API 缺少冲突会话 token，不能保护这条写链路。

## Decision

### Session

后端读取 operation、index stages 和 worktree，生成不可伪造的 `conflictId` 与 fingerprints。前端所有动作必须回传 token；任一身份或内容不匹配即拒绝。

### Actions

四个动作彼此独立：保存 Result、标记已解决、继续 rebase、交接 merge commit。禁止自动组合，禁止结果未知时重试。

### Persistence

保存前在执行环境本地创建有界备份，再在目标同目录原子替换并保留 mode。备份只能在 unresolved index 与 fingerprints 仍匹配时自动恢复；mark-resolved 后仅可查看/导出。

### Scope

首期仅 UTF-8/UTF-8 BOM 普通文本。mixed newline、legacy encoding、binary、symlink、submodule、目录冲突和超限内容不可写。

### Architecture

Transport 提供窄 conflict capability；Host 绑定 lease；Session Hook 编排 token；Result Monaco 只编辑草稿；Actions 只触发显式命令。任一模块达到 300 行必须继续拆分。

## Consequences

### Positive

- 不会用陈旧会话覆盖新的冲突现场。
- 本地、WSL、SSH 使用相同前端语义。
- 用户清楚工作区写入、index 修改和状态机推进的每个时点。
- 保存失败和远程结果未知都有可审计恢复边界。

### Negative

- 需要 Desktop、WSL、SSH Agent 同时扩展读取与专用写命令。
- 备份保留、配额和清理需要独立生命周期。
- 首期拒绝非 UTF-8 与特殊文件类型，覆盖面有限。

## Rejected Alternatives

1. 解析 conflict markers：marker 不是 index 权威数据。
2. 普通 save + generic stage：两个调用之间存在竞态，且无法证明 stage 的是已保存结果。
3. save 后自动 continue：副作用不可见，失败恢复不明确。
4. SSH 写超时自动重试：第一次可能已成功，会造成重复或状态机越级。
5. mark-resolved 后自动恢复 conflict：工作区备份不能重建已折叠的 stage 1/2/3。

## Required Gates For Implementation

- 对 conflict read/save/resolve/restore/continue 所有符号分别执行 upstream impact。
- 每个 mutation 使用真实 Git fixture 覆盖 index/worktree 外部变化。
- Agent capability 版本化；旧 Agent 必须在序列化请求前被拒绝。
- `detect_changes` 确认没有绕过 Transport 或复用普通文件写入。
- 人工验收 merge/rebase 标签、窄窗口、键盘、亮暗主题和中英文。
