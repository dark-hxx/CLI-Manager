# 标准清理本地 Trellis 目录

## Goal

按照 Trellis 本地架构与任务生命周期规范，清除可再生或失效内容，归档已结束任务，并精简没有项目约束价值的模板规范；保留未完成任务、历史追溯资料和所有有效工程契约。

## Requirements

- 采用标准清理，不删除 `planning`、`in_progress`、`review` 任务。
- 删除任务资料中的可再生编译缓存；当前已确认目标为归档任务内未受 Git 跟踪的 Rust `target/`。
- 使用 `task.py archive --no-commit` 归档所有 `completed` / `done` 任务，避免绕过生命周期维护，也避免自动提交。
- 将有实质资料但缺少 `task.json` 的历史目录移出活动任务根目录并保留在月份归档；删除空目录和只含零字节临时日志的残留目录。
- 清理 30 天前或指向不存在任务的会话运行状态，但保留当前会话状态。
- 压缩占位规范并保留活动任务仍引用的稳定路径；不删除无法证明重复或过期的实质契约。
- 补齐有效但未列入层级索引的规范入口。
- 不修改 Trellis 版本、模板哈希、运行脚本、工作流语义或平台集成。
- 不触碰用户已有的 `AGENTS.md`、`CLAUDE.md` 修改。

## Acceptance Criteria

- [ ] `.trellis/tasks/**/target/` 等已确认可再生构建输出被清除。
- [ ] 活动任务根目录不再包含 `completed` / `done` 任务。
- [ ] 3 个有实质内容的孤儿任务目录进入对应月份归档；空目录和零字节日志残留被删除。
- [ ] 当前会话运行状态仍存在；符合失效条件的旧会话状态被清理。
- [ ] `type-safety.md` 保留为精简的稳定入口，`hook-guidelines.md` 仅保留项目实际规则，索引不再显示 `To fill`。
- [ ] `background-task-continuation-contracts.md` 与 `crash-reporting-contracts.md` 进入对应层级索引。
- [ ] 其余实质规范保持不变；没有仅凭文件大小进行删减。
- [ ] `get_context.py`、任务列表、归档列表和规范索引检查正常。
- [ ] 最终 Git 差异不包含本任务之外的 `AGENTS.md`、`CLAUDE.md` 内容。

## Definition of Done

- 执行定向 Trellis 验证并复核 Git 差异。
- 对比清理前后的文件数和体积。
- 记录删除、归档、保留项及恢复方式。
- 本任务仅改变 Trellis 资料与本地运行状态，不更新产品 `CHANGELOG.md` 或 `docs/功能清单.md`。

## Decision (ADR-lite)

**Context**: `.trellis/` 约 190 MB，其中约 175 MB 是可再生构建产物；活动根目录还混有已结束任务、孤儿目录和模板占位规范。

**Decision**: 采用标准清理。保留所有未完成任务和实质历史资料，以生命周期归档代替删除；只删除可再生缓存、失效运行状态、空残留及无实际规则的模板内容。

**Consequences**: 磁盘占用将显著下降，任务列表和规范索引更准确；历史资料仍可追溯，但已归档任务不会继续出现在活动任务列表中。

## Out of Scope

- 激进删除历史归档或长期未完成任务。
- 重写或拆分仍有实质内容的大型领域契约。
- 修复其他活动任务中因代码迁移而失效的旧源码路径清单。
- 修改 Trellis 全局 npm 安装目录或上游源码。
- 修改产品业务代码、发布版本或 Git 同步状态。

## Technical Notes

- 当前分支 `refactor/ai-architecture` 未配置上游；工作区开始时已有 `AGENTS.md`、`CLAUDE.md` 修改。
- 清理前 `.trellis/` 约 190 MB、1,745 个文件；`tasks/` 约 188 MB、1,496 个文件。
- 活动根目录有 19 个 `completed`、5 个 `done`、74 个 `in_progress`、5 个 `planning`、5 个 `review` 任务。
- 孤儿目录中，`06-29-fix-wsl-history-scope-realtime-stats`、`08-05-fix-terminal-live-bottom-resize`、`08-06-fix-terminal-tab-switch-output-freeze` 有已提交的实质文档；其余为空或只含零字节日志。
- 95 个会话运行状态中有 56 个指向不存在任务，74 个早于 30 天；清理集合取二者并集并排除当前会话。
- 规范没有完全相同的文件；`type-safety.md` 原为纯模板但被两个活动任务引用，因此保留路径并压缩为稳定入口；`hook-guidelines.md` 是模板骨架加一条有效规则。
