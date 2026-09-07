# 修复 Hook 删除未清理 CCS 通用配置

## Changelog Target

[TEMP]

## Goal

恢复设置中的 Claude/Codex Hook 安装、卸载与 CC Switch `common_config_claude` / `common_config_codex` 之间的同步，确保卸载 CLI-Manager 自有 Hook 后只移除 CLI-Manager 所拥有的通用配置，不残留保护配置，也不误删用户或第三方配置。

## What I already know

* Native Provider 重构提交 `2481dc1f` 删除了 `hook_settings.rs` 中的 cc-switch 同步调用、状态字段及相关实现。
* 当前本地 Hook 命令仍会写入 Claude `settings.json`、Codex `hooks.json` 和 Codex `config.toml`，但前端调用没有传递 `ccSwitchDbPath`。
* 旧实现已经定义了 Claude JSON / Codex TOML 的合并与卸载规则，可作为行为基线。
* 外部 CC Switch 数据库使用 SQLite `settings` 表；仓库已有 `ccswitch_db` 的 WSL 读取基础设施。

## Requirements

* 恢复 Hook 状态命令接收设置中的 `ccSwitchDbPath`，未配置时使用平台默认路径。
* Hook 安装完成后同步对应的 CC Switch 通用配置；卸载及单模块删除后同步移除 CLI-Manager 自有条目。
* Claude 仅处理带 `__hook` 或历史 CLI-Manager 脚本命令；Codex 仅处理 CLI-Manager 标记的 `[hooks.state.*]` 和 Hook 特性标记。
* 保留通用配置中的其他字段、用户 Hook、第三方 Hook、用户自有 Codex `features.hooks = true` 与非 CLI-Manager trust 状态。
* 同步失败不阻断本地 Hook 安装/卸载；状态返回稳定的失败信息，避免静默写入错误数据库。
* 设置页、侧边栏重装和启动状态检查使用同一同步参数。
* 新增或修改用户可见文案时同步 `zh-CN` / `en-US`，优先复用已有国际化文案。

## Acceptance Criteria

* [ ] 删除 Claude Hook 后，CC Switch `common_config_claude` 中 CLI-Manager Hook 被移除，其他内容保留。
* [ ] 删除 Codex Hook 后，CC Switch `common_config_codex` 中 CLI-Manager 标记与 owned trust blocks 被移除，用户自有 `hooks = true` 和其他表保留。
* [ ] 安装、重装、单模块切换和自动修复不会再次丢失 CC Switch 同步。
* [ ] 自定义 `ccSwitchDbPath` 被准确使用；未配置时使用默认路径；无效显式路径不回退到默认路径。
* [ ] CC Switch 不存在或同步失败时，本地 Hook 操作仍成功。
* [ ] 增加 Rust 回归测试覆盖 Claude JSON、Codex TOML、卸载保留非 CLI-Manager 内容以及 SQLite 写入。
* [ ] `npx tsc --noEmit` 与 `cd src-tauri && cargo check` 通过。
* [ ] 更新 `CHANGELOG.md` 的 `[TEMP]` 区块；如产品功能清单受影响，更新 `docs/功能清单.md`。

## Definition of Done

* 完成根因修复并通过定向测试、类型检查和 Rust 编译检查。
* 完成 GitNexus 变更影响检测。
* 记录根因陈述、发现清单和验证结果。

## 根因与发现清单

* 根因：Native Provider 重构提交 `2481dc1f` 删除了 Hook 命令到 CC Switch SQLite 通用配置的同步边界；本地 Hook 文件仍能安装/卸载，但 `common_config_claude` / `common_config_codex` 不再随之更新。
* 发现：前端状态检查、设置页操作、侧边栏重装、终端启动检查和 Codex 连接页都直接调用 Hook 状态命令，必须统一传递 `ccSwitchDbPath`。
* 发现：Claude 通用配置是 JSON Hook 数组，Codex 通用配置是 TOML 的 Hook 特性与 trust state 表，不能复用同一种解析或删除策略。
* 发现：单模块卸载必须根据卸载后的本地配置重建 CLI-Manager 自有片段，不能因状态变为 partial 就清空全部自有片段。
* 发现：WSL SQLite 不能通过 UNC/Plan 9 直接写入，必须在对应发行版内执行事务，并使用旧值校验避免覆盖并发更新。

## Out of Scope

* 不重做 Native Provider 域模型或 CC Switch 导入流程。
* 不改变非 CLI-Manager Hook 的所有权。
* 不实现项目级 Claude 配置或 managed settings 的保护。

## Technical Notes

* 相关触点：`src-tauri/src/commands/hook_settings.rs`、`src/components/settings/pages/HookSettingsPage.tsx`、`src/components/sidebar/SidebarFooter.tsx`、`src/components/TerminalTabs.tsx`、`src-tauri/src/ccswitch_db.rs`、`src-tauri/src/lib.rs`。
* 契约：`.trellis/spec/backend/cli-hook-contracts.md` 的 “CLI Hook Protection Through cc-switch Common Config”；`.trellis/spec/backend/ccswitch-integration-contracts.md`。
* GitNexus impact：`hook_settings_install`、`hook_settings_uninstall`、`hook_settings_install_codex`、`hook_settings_uninstall_codex` 均返回 LOW，但 Tauri command 注册/IPC 调用未被索引完整，需人工复核所有调用方。
* 根因陈述：Native Provider 重构删除了 Hook 命令与 CC Switch SQLite 通用配置之间的同步边界，导致本地配置变更不再传播到 CCS；修复应恢复该边界而不是仅在界面提示或卸载函数中增加补丁。

## Goal

TBD.

## Requirements

- TBD

## Acceptance Criteria

- [ ] TBD

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
