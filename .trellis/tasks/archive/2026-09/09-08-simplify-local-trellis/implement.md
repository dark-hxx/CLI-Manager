# 标准清理本地 Trellis 目录：实施计划

## 1. Preflight

- [ ] 重新检查 Git 分支、上游和工作区差异。
- [ ] 加载 `trellis-before-dev` 与相关 Trellis 元规范。
- [ ] 重新计算缓存、已结束任务、孤儿目录和失效运行状态的精确目标。
- [ ] 确认所有删除目标的解析绝对路径位于 `.trellis/` 预期子目录。

## 2. Cleanup

- [ ] 删除归档任务中的 Rust `target/` 可再生构建目录。
- [ ] 子任务优先，使用 `task.py archive --no-commit` 归档所有 `completed` / `done` 根级任务。
- [ ] 归档三个有实质资料的孤儿目录。
- [ ] 删除空孤儿目录和零字节临时日志目录。
- [ ] 清除符合失效条件的旧 `.runtime/sessions` 条目，保留当前会话。

## 3. Spec Simplification

- [ ] 将纯模板 `frontend/type-safety.md` 压缩为活动任务可继续引用的稳定入口。
- [ ] 精简 `frontend/hook-guidelines.md`，只保留可执行项目规则。
- [ ] 更新 frontend/backend 规范索引，移除模板提示并补齐有效入口。
- [ ] 确认没有活动任务的 spec/research context 指向被删除的规范文件。

## 4. Verification

- [ ] 运行 `python ./.trellis/scripts/get_context.py`。
- [ ] 运行 `python ./.trellis/scripts/get_context.py --mode packages`。
- [ ] 运行 `python ./.trellis/scripts/task.py list` 与 `list-archive`。
- [ ] 检查根级任务状态不再含 `completed` / `done`。
- [ ] 检查所有规范索引链接存在，且不再出现 `To fill` / `(To be filled by the team)`。
- [ ] 对比 `.trellis/` 清理前后文件数与体积。
- [ ] 复核 `git diff -- .trellis`，确认不包含业务代码或用户已有文件。

## 5. Completion

- [ ] 汇总归档、删除、保留项和可恢复性。
- [ ] 完成 Trellis 质量检查；不自动提交。

## Execution Result

- Cargo 清理释放 173.3 MiB；`.trellis/` 从约 190 MiB 降至 8.83 MiB。
- 24 个已结束任务和 3 个有资料的孤儿目录迁入 `archive/2026-09`。
- 5 个空或仅含零字节日志的孤儿目录已删除。
- 旧运行状态从 95 个降至 18 个，当前会话保持有效。
- 156 个原 Git 跟踪路径均有归档目标；132 个非元数据文件哈希一致。
- 规范索引链接全部有效，占位提示已清除。
- `npm run check:architecture -- --strict` 通过：963 个源文件、0 个超限、0 个新增违规。
- 未自动提交；并发窗口产生的产品代码、功能记录及代码注释规范改动保持原样。
