# 修复 Kimi Hook 安装状态检测设计

## 1. 边界与原则

- 只修改桌面端本地/WSL Kimi Hook 管理实现 `src-tauri/src/commands/hook_settings.rs`。
- 本地 Hook 管理以 Kimi `config.toml` 为事实来源，不再把 CLI 可执行文件能力作为状态或写入前置条件。
- 继续复用 `cli-manager-hook-schema::kimi::plan` 进行结构化 TOML 解析、精确 owner 识别、幂等合并和冲突拒绝。
- 继续保留同目录 staged file、live input 重验和原子替换；移除的只有外部 `kimi doctor` 子进程探测和 candidate validation。
- SSH Agent 的远端 Kimi doctor/candidate 行为不变。

## 2. 状态读取

`build_kimi_status` 直接读取 `<root>/config.toml` 并调用 Kimi planner inspect：

1. 无配置文件按空 TOML 处理，返回 `notInstalled`。
2. 部分受管 definitions 返回 `partialInstalled`。
3. 九个受管 definitions 完整且无 outdated/conflict 时返回 `installed`。
4. outdated/conflict 继续返回 `partialInstalled`。
5. 不运行 `discover_kimi_executable`，因此状态刷新不再产生 5~10 秒外部命令等待。

IPC response shape 与前端 `HookInstallStatus` union 不变；无需新增文案或前端代码。

## 3. 安装与写入

`install_kimi_hooks` 在目标 root 缺失时创建目录，然后直接调用 planner install 和原子替换：

- 删除 `KimiExecutable`、`discover_kimi_executable`、`kimi_doctor_capability`、PowerShell shim invocation 和 `install_kimi_hooks_with_executable` 等只服务于本地 CLI 检测的代码。
- `change_kimi_hooks` 与 `replace_kimi_config` 移除 validator 参数，保留 staged candidate、写前 live revalidation 和 atomic replace。
- planner 返回内容未变化时直接成功，避免无意义临时文件和替换。
- uninstall 继续走同一 planner 和精确 owner 规则。

## 4. 兼容性与风险

- 行为变化：本地旧 `kimi-cli` 或未安装 Kimi 时也允许写入当前 Kimi Code 格式的 `~/.kimi-code/config.toml`；这是用户明确选择的性能取舍。
- 数据安全仍由 TOML schema/planner、symlink 拒绝、owner conflict、live-file 重验和原子替换保证。
- GitNexus 将 `build_kimi_status`、`discover_kimi_executable`、`kimi_doctor_capability` 标为 CRITICAL，因为它们通过统一状态聚合入口影响 11 个 Hook IPC 返回路径；实际修改保持返回结构不变，并以全部本地 Hook 状态聚合回归测试约束。
- 回滚时恢复本地 capability/candidate 检测代码和对应测试即可；无数据库或持久化迁移。

## 5. 记录同步

- 更新 `.trellis/spec/backend/cli-hook-contracts.md`，明确本地不探测 Kimi CLI、远端 SSH 仍保留 doctor 校验。
- `CHANGELOG.md` 统一使用 `V1.3.7`，确保不存在 `TEMP` 标题并加入本次性能/状态修复。
- `docs/功能清单.md` 在 Kimi Hook/Hook 设置对应板块记录本地无 CLI 探测的行为。
