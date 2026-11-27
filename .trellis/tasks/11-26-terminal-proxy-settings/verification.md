# V1.5.3 · 代理配置验证记录

## 前端验证

1. `npx tsc --noEmit`：通过（0 错误）。
2. `npm run check:architecture -- --strict`：通过（1561 source files；0 above 2000 lines；0 new violations）。
3. `node --test scripts/proxySettings.test.mjs scripts/settingsDialog.test.mjs scripts/settingsFocus.test.mjs scripts/settingsPresentation.test.mjs`：14/14 全部通过。
   - `scripts/proxySettings.test.mjs`（7 项）：URL 协议/格式校验、`NO_PROXY` 本地回环合并、凭据剥离、三级优先级（项目 > Agent > 全局）与 `direct` 覆盖、SSH 不继承本机代理仅支持项目自定义、大小写环境变量与 `direct` 空值 sentinel、分栏结构化拆分/拼装/URL 特殊字符编码及智能粘贴拆分。
   - `scripts/settingsDialog.test.mjs`、`scripts/settingsFocus.test.mjs`、`scripts/settingsPresentation.test.mjs`（7 项）：设置模态框导航顺序、焦点隔离与样式回归全部通过。

## 后端验证（`src-tauri`）

1. `cargo check`：通过（`cli-manager v1.5.3`）。
2. `cargo test --lib project_proxy`：3/3 通过（v43 迁移顺序、表列默认值、`db_repair_known_migration_drift` 三类漂移自愈）。
3. `cargo test --lib commands::proxy::tests`：3/3 通过（协议/凭据脱敏校验、本地监听 TCP 连通成功、关闭端口错误映射）。
4. `cargo test --lib wsl_env_forwarding`：8/8 通过（`WSLENV` 转发非空代理变量并跳过 `direct` 空值，保留原有 8 个回调键及用户标志）。
5. `cargo test --lib proxy_overrides`：1/1 通过（Windows `merge_environment` 大小写不敏感替换及 `direct` 移除宿主/用户代理变量，保留非代理空值）。
6. `cargo test --lib database_restore`：7/7 通过（含 `proxy_config` 新列清单恢复与旧快照兼容）。
7. `cargo test --lib migration_tests`：15/15 通过（全量迁移顺序与校验无冲突）。

## 2026-11-27 发布前复核

- `npm run check:architecture -- --strict`：1562 个源文件、0 超限、0 新违规；`npx tsc --noEmit` 通过。
- 代理及设置的 4 个 Node 测试文件：15/15 通过；Release workflow、R2 配置和准备脚本检查全部通过。
- 启动回归发现测试加载器抽取 `resolvePtyLaunch` 后未提供新引入的代理依赖；仅为 `codexHookIsolation`、`deepseekTuiRuntime`、`resumeCliArgs` 三个测试接入真实代理函数和默认偏好，不改产品实现。修正后 agy、Hook、CLI 恢复、DSH 与实时统计的 8 个 Node 测试文件：97/97 通过。
- `cargo check --locked`、Hook schema 全套测试及 `project_proxy`、`commands::proxy::tests`、`wsl_env_forwarding`、`proxy_overrides`、`database_restore`、`migration_tests`、`antigravity`、`agy` 定向 Rust 测试均通过；需显式产品 exe 的真实 TUI 烟测仍按原规则默认忽略，不记为通过。
- GitNexus `detect-changes --scope all --repo .` 标记 critical（共享设置、迁移、PTY 启动链路），不以图分析替代上述定向测试。
- 本轮未运行 macOS/WSL 真机桌面测试或重新进行 UI 双语人工验收。
- 已知风险：项目代理凭据脱敏复用于本机安全快照及恢复写入，备份下载/导入失败后的回滚或 Undo 可能清除原项目代理用户名/密码。用户在发布前明确选择“接受风险，按现状发布”；本次不修复该业务链路。
