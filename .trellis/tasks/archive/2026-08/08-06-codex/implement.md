# 实施计划

1. 调整 scope launch contract：Codex 全局来源返回 passthrough；Codex scoped snapshot 保存 env-key/非敏感 overrides，不生成临时 Home。
2. 调整 PTY provider launch application：从 manifest 注入 Key，移除 Codex `CODEX_HOME` 覆盖，并拒绝旧/不完整 snapshot。
3. 调整前端启动与 resume 链路：识别 nullable global plan，将 scoped `-c` 参数安全追加到直接 Codex 命令，旧持久化 snapshot 强制重建。
4. 增加 Rust 测试：全局 passthrough、Codex snapshot 不生成 Home、manifest/env-key 校验、override 白名单、Key 不进入 DTO。
5. 增加 TypeScript/脚本测试：普通启动、项目覆盖、Worktree、resume、非直接命令、PowerShell/CMD/Git Bash/WSL 参数编码。
6. 运行 `cargo fmt --check`、相关 Rust 测试、`cargo check`、相关脚本测试、`npx tsc --noEmit`；不运行 dev/build。
7. 执行 GitNexus `detect_changes`（若当前环境仍不可用则记录降级证据），更新 `CHANGELOG.md` `[TEMP]` 与必要的功能清单/规格。

## Risky Touchpoints

- `src-tauri/src/provider/scope.rs`：snapshot 格式和 secret 边界。
- `src-tauri/src/commands/terminal.rs`：PTY 子进程环境。
- `src/stores/terminalStore.ts`：新启动与多条恢复路径。
- `src/lib/projectStartupCommand.ts`：跨 shell 命令参数安全。

## Validation Focus

- 真实 `CODEX_HOME` 未被 provider launch 覆盖。
- MCP、Hook、sandbox 与 sessions 仍来自真实 Home。
- provider Key 不出现在命令、DTO 和错误信息。
- 全局、项目、Worktree、resume 行为一致；SSH 不注入本地配置。
