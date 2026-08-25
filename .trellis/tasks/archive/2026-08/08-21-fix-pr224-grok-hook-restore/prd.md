# 修复 PR #224 Grok Hook 配置恢复

## Goal

修复 PR #224 的 Grok SSH Hook 配置：安装时为 Claude/Cursor 兼容 Hook 设置隔离值，卸载时必须只还原由同一 SSH Agent 安装实例写入的原始值，不能永久篡改用户已有的配置。

## Confirmed facts

- PR #224 的 `plan_files(..., Source::Grok, ...)` 在安装路径调用 `apply_grok_compat_isolation`，无条件写入 `compat.claude.hooks = false` 与 `compat.cursor.hooks = false`。
- 同一分支的卸载路径保留 `config.toml` 原字节，因此不会恢复上述值。
- 同文件的 Codex `features.hooks` 已有带 `installation_id`、原始值与表创建状态的 marker 方案；它是本修复的可复用所有权模式。
- `V1.3.8` 是本次 `CHANGELOG.md` 与功能清单的记录版本；Agent 版本仍由 PR 已有的 `0.1.10` 决定，其发布标签保持 `ssh-agent-v0.1.10`。

## Requirements

### R1 — 可逆且有所有权的 Grok 兼容配置

- 安装时，仅对未隔离的 `compat.<vendor>.hooks`（`vendor` 为 `claude`、`cursor`）写入 `false`。
- 对每个实际写入的值，保存同一 `installation_id`、原始状态（缺失或 `true`）及为该键创建的表层级信息；预先为 `false` 的值不写 marker、不归 Agent 所有。
- 卸载时，仅恢复仍为 Agent 管理的 `false` 值；无 marker、属于另一 installation、或用户后来修改过的值必须保持不变。
- 恢复缺失值时，仅删除 Agent 为该值创建且已空的表；不得删除用户已有表、键、注释或无关配置。

### R2 — 覆盖行为契约的测试

- 证明已有 `true`、已有 `false`、缺失键/表、混合 vendor 状态、另一安装实例及安装后用户修改等路径均满足 R1。
- 维持现有 Grok Hook JSON 安装、检查和冲突检测行为。

### R3 — 交付与 PR 更新

- 在 PR 分支提交修复、测试和 `V1.3.8` 变更记录，并推送到 PR #224 的 head 分支。
- 修复后重新执行以 SSH Agent 为中心的质量检查和 GitNexus PR 影响复审。

## Acceptance criteria

- [ ] 对已有 `true` 的 Claude/Cursor Hook 配置，安装后为 `false`，同一安装实例卸载后精确恢复为 `true`（包括用户注释）。
- [ ] 对缺失的兼容键和由 Agent 创建的空表，卸载后恢复为缺失，且不删除原有其他配置。
- [ ] 已为 `false`、无 Agent marker、另一 installation 的 marker，或安装后用户改写的值在卸载后均不被改写。
- [ ] 安装、卸载、检查和预览的 Grok 行为通过相关 Rust 测试；SSH Agent crate 全量测试通过。
- [ ] `CHANGELOG.md` 与 `docs/功能清单.md` 以 `V1.3.8` 记录修复；提交已推送至 PR #224。
- [ ] 最终 PR diff 仅包含预期的 Grok 修复、测试、交付记录与任务元数据，且复审没有阻塞性发现。

## Out of scope

- 不修改 Grok Hook 事件集合、SSH 启动/终端路由、历史删除功能或 PR 内 CcConnect 的独立行为变更。
- 不重打或移动已有 Git tag，不在本任务中创建 GitHub Release；桌面端 `V1.3.8` 发布另行按发布流程处理。
