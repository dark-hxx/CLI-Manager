# 标准清理本地 Trellis 目录：技术设计

## Boundaries

清理仅覆盖 `.trellis/`。运行核心 `scripts/`、`workflow.md`、`config.yaml`、`.version`、`.template-hashes.json`、当前开发者身份和当前会话指针保持不变。

## Cleanup Classification

### 1. 可再生缓存

- 删除已验证位于 `.trellis/tasks/archive/2026-09/09-07-split-rust-foundation/rust-index/target/` 的 Rust 构建目录。
- 该目录位于预期归档任务内部，未被 Git 跟踪，删除后可通过 Cargo 重新生成。

### 2. 已结束任务

- 从任务元数据动态选取状态为 `completed` 或 `done` 的根级任务。
- 子任务先归档、父任务后归档，避免破坏仍位于活动区的父子关系。
- 每项调用 `python ./.trellis/scripts/task.py archive <name> --no-commit`，让 Trellis 更新状态、关系与会话指针，但禁止自动提交。

### 3. 孤儿任务目录

- 有已提交实质资料的三个目录使用同一 archive 命令迁入对应月份归档，保留其原始文件；不伪造 `task.json`。
- 空目录及仅含零字节 `vite-build.log` 的目录直接删除。
- 删除前再次解析绝对路径，确认目标均为 `.trellis/tasks/` 的直接子目录且不是当前任务。

### 4. 会话运行状态

- `.runtime/sessions` 是已忽略、可重建的会话状态。
- 删除 `last_seen_at < 2026-08-09T00:00:00Z` 或 `current_task` 不存在的条目，排除当前 Codex 会话文件。
- 不删除会话所指向的任务资料；最坏影响仅是旧窗口失去自动任务指针，可重新 `task.py start`。

### 5. 规范精简

- `frontend/type-safety.md` 被两个活动任务引用，保留路径并压缩为指向实际所有者契约的稳定入口。
- 将 `frontend/hook-guidelines.md` 收敛为现有唯一可执行规则，删除空章节与模板注释。
- 清理 `frontend/index.md` 的初始化模板话术，保留实际规范清单，并补入未索引的后台任务续跑契约。
- 在 `backend/index.md` 补入已存在且内容完整的崩溃报告契约。
- `component-guidelines.md` 等大文件虽长但包含不同领域的具体契约，当前没有精确重复证据，标准清理不删减它们。

## Safety and Rollback

- Git 跟踪的任务移动与规范编辑可通过提交前差异恢复；不使用 `git reset` 或 `git checkout`。
- 未跟踪构建缓存可重新构建，旧运行状态可由新会话重新生成。
- 删除前输出精确目标；移动后运行任务和归档列表验证。
- 若任一 archive 命令失败，停止后续批次并保留已完成结果供人工复核。

## Compatibility

- 不改变任务 JSON schema、命令参数、工作流阶段或平台 hook。
- 不修改活动任务的 context manifest，避免影响其他正在工作的会话。
- 不修改工作区 journal；其接近行数上限时由 Trellis 正常轮转。
