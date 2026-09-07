# Codex 远程托管运行配置一致性 - Implementation Plan

## Implementation

- [x] 调整 `CodexProviderOverrides::command_args()`，让 app-server 将完整 Provider profile 展开为 `-c`，并保留显式 Provider/模型锁定覆盖。
- [x] 增加 proxy 诊断开关和协议阶段分类，不记录消息正文或工具参数。
- [x] 仅在 cc-connect 日志开关开启时启用阶段诊断。
- [x] 补齐 app-server/普通命令、Provider/无 Provider、诊断开关和命令行超限测试。
- [x] 更新 `CHANGELOG.md` 的 `TEMP` 版本和 `docs/功能清单.md` 远程托管条目。

## Validation

- [x] `cargo test codex_app_server_proxy`（27 passed）
- [x] `cargo test cc_connect`（62 passed）
- [x] `cargo check --lib`
- [x] `npx tsc --noEmit`
- [x] `git diff --check`
- [x] GitNexus `detect_changes` 无可用索引且 codebase-memory transport 在最终刷新时关闭；降级过程已记录，并使用 `git diff --stat`、完整 diff、符号检索及专项测试复核。
- [x] Codex 0.151.0 冒烟验证接受完整 profile 等价的 `-c` 参数并进入 app-server，仅因测试输入 EOF 正常退出。

## Review gates

- [x] 不包含 cc-connect 源码改动。
- [x] 不包含数据库、IPC 或持久化 schema 改动。
- [x] 不泄露 Provider 密钥、prompt 或文件内容。
- [x] SSH 和非 Codex 托管分支保持不变。
- [x] 本地 Provider profile 是唯一完整配置来源；proxy 只做通用 TOML 展开，不重新维护业务字段清单。
