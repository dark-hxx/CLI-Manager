# 历史备份与恢复

**Requirements Quality Score**: 96/100

## Goal

为历史会话外部 mutation 提供跨运行环境备份、保留清理、恢复 plan、回滚与设置页恢复入口。

## Requirements

- 独立提供 Backup Service，不把备份路径、清理和恢复逻辑散落到各来源 adapter。
- 默认备份根跟随被修改来源所在运行环境，支持 Windows、WSL、macOS、Linux。
- 每个运行环境独立保留 7 天或最多 1 GiB，任一条件先达到即清理。
- 单次必要备份超过 1 GiB 时阻止 mutation；允许更换该环境备份目录或显式提高仅本次临时上限，完成后仍按默认规则自动清理。
- 文件、SQLite、混合来源按完整 artifact graph 创建一致性快照。
- 已验证 shared artifact 允许逻辑备份，例如 append-only 截断恢复和 SQLite row graph；未知 schema、独占文件或破坏性重写必须完整快照。
- shared artifact 恢复优先执行精确逆操作，禁止旧整文件/整库覆盖 mutation 后的无关新数据。
- mutation 失败支持自动回滚；主会话级联删除全有或全无。
- 回滚失败进入 `manualRecoveryRequired` 并锁定来源实例后续 mutation。
- 在 `设置 -> 历史来源 -> 备份与恢复` 提供按环境查看、预览、恢复、打开位置和永久清理。
- 恢复前目标工具必须关闭，fingerprint 冲突时禁止自动覆盖。
- 备份保持原始格式，不加密、不参与同步。
- 详细设计以 `docs/历史备份与恢复设计.md` 为准。

## Acceptance Criteria

- [ ] Windows、每个 WSL distro、macOS/Linux 分别解析和管理 backup root。
- [ ] 7 天 / 1 GiB 清理以完整 mutation 目录执行，不删除执行中、恢复中和异常 manifest。
- [ ] 单次估算超过上限时不会跳过备份或静默超限；临时上限只对当前环境、当前 mutation 有效，完成后不长期豁免默认清理。
- [ ] 文件、WAL SQLite 和 mixed artifact 均有可验证的备份策略。
- [ ] shared JSONL append-only 和 SQLite row graph 可用逻辑备份；未验证或无法精确恢复时退回完整快照。
- [ ] mutation 中途失败能够按逆序恢复并重新解析验证。
- [ ] 主会话树删除任一步失败时完整恢复，不产生部分删除。
- [ ] 手动恢复有 plan、影响预览、进程/锁检查、fingerprint 冲突检查和执行后重新索引。
- [ ] 目标工具运行时不能恢复，无 override、无强制结束进程。
- [ ] `manualRecoveryRequired` 可导出 manifest、打开备份目录并重新生成恢复 plan。
- [ ] 设置页新增文案同步 `zh-CN` 和 `en-US`。
- [ ] 多来源 mutation task 在对应 Backup Service 能力完成前不开放真实执行。

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
