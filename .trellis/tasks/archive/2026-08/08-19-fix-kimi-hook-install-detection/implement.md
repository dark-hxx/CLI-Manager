# 修复 Kimi Hook 安装状态检测实施计划

## Phase 0 · 前置与影响检查

- [x] `master` 与 `origin/master` 同步（0/0），已按用户授权执行 `git pull --ff-only`，结果为最新。
- [x] 识别并保护既有未提交 `AGENTS.md`、`CLAUDE.md`、`CHANGELOG.md` 修改。
- [x] 通过修复分诊确定为根因修复，并完成 root-cause statement 与 discovery list。
- [x] 刷新 GitNexus 索引并执行拟修改 symbols 的 upstream impact。
- [x] 向用户披露 CRITICAL 聚合影响：`build_kimi_status` 有 11 个直接调用者，影响统一 Hook 状态 IPC；`discover_kimi_executable` / `kimi_doctor_capability` 通过该入口触达同一批流程。

## Phase 1 · 本地 Kimi 状态与安装

- [x] 加载 `trellis-before-dev` 及后端质量规范。
- [x] 从 `build_kimi_status` 移除本地 Kimi CLI capability 探测，始终按配置内容计算 Hook 状态。
- [x] 从 `install_kimi_hooks` 移除可执行文件发现和 doctor candidate validation。
- [x] 删除本地专用 `KimiExecutable`、doctor/PowerShell shim helper、带 executable 的安装封装。
- [x] 简化 `change_kimi_hooks` / `replace_kimi_config` validator 参数，同时保留 planner、symlink 防护、live revalidation、staged candidate 和 atomic replace。

## Phase 2 · 回归测试

- [x] 新增或调整 Rust 测试：无 Kimi CLI/无配置时返回 `notInstalled`。
- [x] 新增或调整 Rust 测试：无 Kimi CLI 时首次安装创建 root 和九个受管 definitions。
- [x] 保留并验证重复安装幂等、部分/完整状态、精确卸载、invalid TOML/conflict、live config 竞争保护。
- [x] 删除 doctor capability/candidate failure 与 PowerShell shim 专属过时测试。

## Phase 3 · 契约与交付记录

- [x] 更新 CLI Hook contract，区分本地无 CLI 检测与 SSH Agent 远端 doctor 校验。
- [x] 更新 `CHANGELOG.md`：目标 `V1.3.7`，收集/确认所有 `TEMP` 内容已归并并追加本次修复。
- [x] 更新 `docs/功能清单.md` 对应 Kimi Hook 板块。

## Phase 4 · 验证与审查

- [x] 运行 `cargo fmt --check`。
- [x] 运行 `cargo test` 的 Kimi Hook 聚焦测试；条件允许时运行 `cargo check`。
- [x] 运行 `npx tsc --noEmit`（若前端未改仍用于跨层回归，既有无关失败单独报告）。
- [x] 运行 `git diff --check`。
- [x] 运行 GitNexus `detect_changes(scope=all)`，确认只影响预期 symbols/Hook 状态流程。
- [x] 加载 `trellis-check` 完成规范、测试和记录一致性检查。

## Rollback Point

- 产品代码修改集中于本地 `hook_settings.rs`；若状态或写入回归，恢复 capability/validator 路径即可。契约与记录随代码同步回滚，不涉及数据库或用户配置迁移。
