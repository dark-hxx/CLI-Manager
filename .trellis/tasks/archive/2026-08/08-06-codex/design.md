# 技术设计

## Architecture Decision

`CODEX_HOME` 始终表示用户选择的真实 Codex 状态根目录，不再承担供应商 scope 隔离。供应商切换只改变供应商拥有的配置字段和活动密钥：

- 全局跟随：不创建 launch snapshot，直接使用已由 global writer 原子写入真实 Home 的配置。
- 项目/Worktree/显式恢复覆盖：保留真实 Home，通过 Codex `-c key=value` 启动参数覆盖 `model`、`model_provider` 和目标 `model_providers` 表，并通过 PTY 子进程环境注入活动 Key。

这与仓库现有 CC Connect Codex wrapper 的做法一致：配置覆盖进入 Codex 参数，历史根目录仍由真实 `CODEX_HOME` 管理。

## Data Flow

1. `provider_scope_prepare` 解析 Worktree > project > global。
2. Codex + global 返回 passthrough（无 snapshot）；前端不构造 provider launch config，也不改启动命令。
3. Codex + project/worktree/explicit 读取 effective provider settings，生成只含供应商拥有字段的安全 `-c` override 列表。
4. scope snapshot 只保存不可由前端读取的活动 Key 与 manifest，并返回非敏感 overrides；Codex env-key 使用后端固定的 `CLI_MANAGER_PROVIDER_KEY`，不再生成 `codex/auth.json`、`codex/config.toml` 或 `generatedHome`。
5. 前端只把非敏感 override 列表追加到直接 Codex 启动/恢复命令。
6. `pty_prepare_create` 校验 snapshot manifest 后把活动 Key注入 manifest 指定的环境变量；不写入 `CODEX_HOME`。
7. Codex 从真实 Home 读取 MCP、Hook、sandbox、plugins、skills、projects 与 sessions，再在进程内应用供应商覆盖。

## Contracts

- `provider_scope_prepare` 对 Codex 全局来源可返回 `null`；项目、Worktree 和显式 provider ID 返回 snapshot。
- Codex snapshot DTO 新增非敏感 `configOverrides: string[]`，不再要求 `generatedHome`。
- `ProviderLaunchConfig` 不接收客户端提供的 env-key 或 secret；env-key 使用后端固定常量，Key 从受信任 snapshot 文件读取。
- 只允许固定供应商字段生成 override。不得把 provider raw TOML 的 MCP、sandbox、hooks、projects、plugins 或未知表注入命令行。
- override 值必须作为独立参数拼接并按现有 PowerShell/CMD/Git Bash/WSL 命令规则安全引用；不允许 shell 控制字符进入命令。
- 非直接 Codex 自定义启动命令无法安全追加参数时，显式覆盖应失败并返回稳定错误，而不是静默改 `CODEX_HOME`。
- Claude/Grok 的 scope materialization 不在本次重构范围内。

## Compatibility

- 全局 apply 文件格式与 provider DB schema 不变。
- 既有持久化 session 若携带旧 Codex `generatedHome` snapshot，恢复时重新 prepare 新 launch plan，不继续使用旧临时 Home。
- 已运行进程保持原环境，修复只影响新启动/恢复进程。
- SSH 继续丢弃本地 provider config；WSL 使用真实 WSL Home 并将启动参数按目标 shell 编码。

## Security

- API Key 只存在 providers.db、受控 snapshot key 文件和 PTY 子进程环境，不进入 React state、启动命令、日志或 toast。
- Snapshot mismatch、缺失、旧格式或 env-key 异常时 fail closed，并清理不完整 snapshot。
- `configOverrides` 只含 endpoint/model/provider 元数据，不含 credential。

## Rollback

- 若 scoped override 启动失败，可回滚为“不应用项目覆盖并提示错误”；不得回滚到临时 `CODEX_HOME`。
- 全局 passthrough 与 scoped override 分开测试，便于独立定位。
