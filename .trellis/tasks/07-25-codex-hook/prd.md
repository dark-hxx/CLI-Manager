# 修复 Codex Hook 信任状态自动恢复

## Goal

当 Codex Hook 模块均已完整安装、但 `config.toml` 中对应信任记录缺失、禁用或哈希过期时，在状态检查阶段自动恢复信任记录，避免错误显示“部分安装”。

## Requirements

- 仅在 Codex 必需 Hook 事件及 Hooks 功能均完整时自动修复信任记录。
- 保留用户其他 Codex 配置和非 CLI-Manager Hook 状态块。
- Hook 模块真实缺失时不得伪装成已安装。
- 不修改现有 Tauri command 签名和前端状态协议。
- Changelog Target: `[TEMP]`

## Acceptance Criteria

- [ ] 完整 Hook 的缺失、禁用或过期信任记录可自动恢复为 `installed`。
- [ ] 缺少必需 Hook 模块时仍返回 `partialInstalled`，且不生成信任记录。
- [ ] 用户其他 TOML 配置及非 CLI-Manager Hook 状态块保持不变。
- [ ] Rust 定向测试、`cargo check` 和 `git diff --check` 通过。

## Technical Approach

在 `hook_settings_get_status` 的只读检测链路中先计算 Codex 结构状态；若只有信任检查失败，则根据当前 `hooks.json` 重新生成 CLI-Manager Hook 的 `hooks.state` 块，合并写回 `config.toml` 后重新检测。

## Out of Scope

- 不自动补装缺失的 Hook 事件。
- 不改动前端展示。

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
