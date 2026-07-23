# 实施计划

1. 为 Codex Hook state 增加 key、规范化哈希及信任校验纯函数和测试。
2. 将信任校验接入 `build_codex_status`，失效时返回 `partialInstalled`。
3. 重构 `hook_client` 失败处理，增加脱敏、限长诊断日志及单元测试。
4. 在不覆盖现有未提交改动的前提下补充会话 ID 重新绑定回归测试。
5. 更新 `[TEMP]` CHANGELOG，运行目标测试、`cargo check`、`npx tsc --noEmit` 与 GitNexus 变更检测。

## 完成结果

- Codex 状态检查已覆盖 Hook trusted hash、禁用状态与哈希过期。
- Hook 客户端保持恒定退出码 0，失败写入不超过 1 MiB 的脱敏诊断日志。
- 会话 ID 重绑定提取为纯函数，并覆盖 old session -> `/clear` new session -> next prompt。
- 目标测试、`cargo check`、`npx tsc --noEmit` 通过；GitNexus 对整个脏工作区报 critical，主要来自并行存在的分屏/Workspan 未提交改动，本任务符号此前影响分析为 LOW/MEDIUM。
