# 研究三方冲突编辑器

## Goal

研究 Base/Ours/Theirs/Result 三方冲突编辑器的数据契约、Git 语义、写入安全和实施切片，形成后续 ADR；本任务不修改产品代码。

## Background

- 当前 Git 面板能识别冲突文件和 merge/rebase 状态，支持两者中止及 rebase continue；merge 通过后续提交完成。当前没有 stage 1/2/3 内容读取和结果编辑。
- Git index 的 stage 1/2/3 分别表示 base/ours/theirs；rebase 中 ours/theirs 的用户语义容易与“我的/对方的”直觉相反。
- 本地、WSL、SSH 已共用 Git Transport 方向，三方编辑器不能建立本地专用 UI 或把远程路径交给本地命令。

## Requirements

- 定义 Base/Ours/Theirs/Result、stage 1/2/3、merge/rebase/cherry-pick 类状态的命名和数据契约。
- 定义加载时 revision token，绑定 repository、path、index blob ids、worktree fingerprint 和 pending operation，阻止过期结果覆盖新冲突。
- 区分“保存结果”“标记已解决/暂存”“继续 rebase / 完成 merge 提交”，每一步都由用户明确触发，不做隐式连锁写入。
- 明确编码、BOM、换行、末尾换行、文件权限、符号链接、子模块、二进制和超限文件的支持/拒绝边界。
- 保存前创建工作区结果备份，采用原子替换并复核状态；自动恢复只允许发生在 index 尚未标记解决且指纹仍匹配时，任何结果未知或外部修改都禁止自动重试。
- 本地、WSL、SSH 使用同一前端契约；环境差异只在 `GitTransport` 和后端/Agent 执行层。
- 复用 Monaco 作为 Result 编辑器，Base/Ours/Theirs 只读；不得把三套完整编辑器和 Git 写入状态堆进单一组件。
- 输出 ADR 草案、风险、场景矩阵和可独立交付的后续垂直切片。

## Acceptance Criteria

- [ ] `research.md` 解释 stage 1/2/3 和 merge/rebase 下的标签语义，避免误导性“我的/对方的”。
- [ ] 加载、保存、标记解决、受限恢复、rebase continue 和 merge 提交交接都有请求/响应/竞态条件。
- [ ] 编码、换行、文件类型、权限、超限和冲突标记行为有明确支持矩阵。
- [ ] ADR 草案明确乐观并发 token、写前备份、原子写和写操作不自动重试。
- [ ] 模块职责和后续垂直切片符合单文件职责；预计超过 300 行的 UI 必须继续拆分。
- [ ] 本地/WSL/SSH、merge/rebase、外部 Git 并发和断线结果未知纳入场景矩阵。
- [ ] 本任务只产生规划文档，不修改 `src/`、`src-tauri/` 或依赖清单。

## Out of Scope

- 本任务直接实现冲突编辑器。
- 自动语义合并、AI 自动解冲突或自动接受某一侧。
- 目录树冲突、rename/rename 的完整图形化重命名工作流。
- 替代 Git 的 merge/rebase 状态机。

## Risk

风险为 **CRITICAL**：错误角色标签、过期写入、编码变化或隐式暂存都可能破坏用户冲突现场。实施前必须单独审查所有写入口。
