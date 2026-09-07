# Claude Code / Codex / Grok 配置契约调研

## 证据版本

| 项目 | 固定版本 | 用途 |
|---|---|---|
| Anthropic Claude Code | [`7ef6eec9`](https://github.com/anthropics/claude-code/tree/7ef6eec9d9ba84ea6f233f26c45f1df5c5991843) | settings JSON 示例与层级 |
| OpenAI Codex | [`2b5bdcf6`](https://github.com/openai/codex/tree/2b5bdcf67547860f2e5c5a605009a70026796b2b) | `config.toml`、named profile、provider `env_key` |
| xAI Grok Build | [`a4221165`](https://github.com/xai-org/grok-build/tree/a4221165824e5b1f5c4c10b7459f65e78dd6448d) | `GROK_HOME`、配置层级、项目配置边界 |
| cc-switch | [`ebbf141f`](https://github.com/farion1231/cc-switch/tree/ebbf141fc71547a99f669df1be8e345130d1d890) | 三类型 live writer 与 Grok 自定义 provider 格式 |

## 能力矩阵

| 类型 | 全局 live 配置 | 项目隔离机制 | Key 投影 | 设计结论 |
|---|---|---|---|---|
| Claude Code | `~/.claude/settings.json` | 生成独立 JSON，启动加 `--settings <path>` | 仅在后端渲染到该进程 settings/env | 保留现有机制；全局只修改 provider-owned `env` 键，保留 hooks/permissions/statusline |
| Codex | `${CODEX_HOME}/config.toml`；可用 named profile | 生成 `${CODEX_HOME}/<name>.config.toml`，启动加 `--profile <name>` | provider 使用稳定 `env_key`，真实 Key 由进程环境注入 | 不把 bearer token 写入 TOML；保留注释/未知段落；项目 profile 为派生物 |
| Grok Build | `${GROK_HOME:-~/.grok}/config.toml` | 为进程生成独立 Grok home，并设置 `GROK_HOME=<dir>` | 优先用 provider `env_key` + 进程环境；兼容 `XAI_API_KEY` | 官方源码确认 `GROK_HOME`，因此可安全实现项目/Worktree 隔离，不改全局 `~/.grok` |

全局切换契约与项目隔离契约必须分开：全局切换像 CCS 一样修改上述用户 Home live 文件，使应用外新进程也生效；`~/.cli-manager/providers/generated/*`、`--settings`、named profile 和 per-process `GROK_HOME` 仅用于项目/Worktree override，不能冒充全局切换。

## Claude Code

Claude Code 官方示例说明 settings 使用合法 JSON，并存在用户级、项目级和本地设置层。当前 CLI-Manager 用 `--settings` 传入生成文件，适合项目覆盖。

设计约束：

- 通用配置和 provider overlay 均先做 JSON 语法、对象根节点和受限字段校验。
- JSON 对象递归合并；数组整体替换；`null` 是显式覆盖，不表示删除。
- Key 字段不允许出现在通用配置；provider overlay 中的旧明文 Key 在保存/导入时抽取到原生 Key 子表并从通用配置/供应商配置 blob 清除，避免重复多份。
- 全局应用只改 provider-owned 环境变量集合；CLI-Manager 管理的 hooks、permissions、statusline 和未知字段保留。
- 项目覆盖生成 `~/.cli-manager/providers/generated/claude/<scope-id>.settings.json`，写入前 stage/validate，参数路径按 PowerShell/CMD/Bash/WSL 转换。

参考：[Claude Code settings examples](https://github.com/anthropics/claude-code/tree/7ef6eec9d9ba84ea6f233f26c45f1df5c5991843/examples/settings)。

## Codex

Codex 官方代码以 `${CODEX_HOME}/config.toml` 为用户配置，并支持 named profile；`model_providers` 支持 `env_key`。这允许配置文件只保存环境变量名，真实 Key 在 PTY 创建时注入。

设计约束：

- `config.toml` 用 `toml_edit` 做结构化、尽量保留注释和顺序的修改。
- 通用配置只允许非秘密、非 provider identity 的通用段；provider overlay 覆盖同名 assignment/table。
- 活动 Key 投影为稳定 env 名，例如 `CLI_MANAGER_PROVIDER_KEY`，并只传给目标进程；不写 `auth.json` 明文、不写 `experimental_bearer_token`。
- 全局切换在 live `config.toml` 中更新 CLI-Manager 拥有的 provider/profile 块和 `model_provider`，保留 MCP/notifications/features 等用户段。
- 项目覆盖继续生成 named profile；派生 profile 不参与备份身份和 CCS 映射。

参考：[config loader](https://github.com/openai/codex/blob/2b5bdcf67547860f2e5c5a605009a70026796b2b/codex-rs/config/src/loader/mod.rs)、[config schema](https://github.com/openai/codex/blob/2b5bdcf67547860f2e5c5a605009a70026796b2b/codex-rs/config.schema.json)。

## Grok Build

xAI 官方源码明确：配置根目录是 `$GROK_HOME`，未设置时为 `~/.grok`；主配置是该目录下 `config.toml`。官方用户指南也列出 `GROK_HOME` 路径变量。项目仓库内 `.grok/config.toml` 只允许 MCP、插件、权限等有限段，不适合承载项目级模型供应商切换，因此应使用每进程 `GROK_HOME` 隔离。

设计约束：

- 全局 live 文件为 `~/.grok/config.toml`；项目/Worktree 生成独立 home 并设置单进程 `GROK_HOME`。
- 隔离 home 只写必要 provider/config；不得复制用户 `auth.json`、会话、日志或插件凭据。
- 如需保留全局通用 UI/permission 设置，应按允许字段投影到生成配置，而非整目录复制。
- 自定义 provider 的 `[models]` / `[model.<name>]` 形状按当前 Grok Build + cc-switch writer 固定版本验证；环境检查发现 CLI 版本不兼容时阻止激活并给出说明。
- 真实 Key 通过 `env_key` 或 `XAI_API_KEY` 注入目标进程，界面和诊断不返回值。

参考：[Grok paths.rs](https://github.com/xai-org/grok-build/blob/a4221165824e5b1f5c4c10b7459f65e78dd6448d/crates/codegen/xai-grok-config/src/paths.rs)、[configuration guide](https://github.com/xai-org/grok-build/blob/a4221165824e5b1f5c4c10b7459f65e78dd6448d/crates/codegen/xai-grok-pager/docs/user-guide/05-configuration.md)、[cc-switch Grok writer](https://github.com/farion1231/cc-switch/blob/ebbf141fc71547a99f669df1be8e345130d1d890/src-tauri/src/grok_config.rs)。

## 统一合并与所有权契约

```text
用户 live 配置（保留非 CLI-Manager-owned 段）
  + 类型通用配置（defaults）
  + 供应商覆盖配置（provider wins）
  + 活动 Key 投影（backend-only，最高优先级）
  = 有效配置预览 / 全局或隔离配置
```

- 密钥、token、password、authorization、bearer 等字段不参与通用合并。
- 配置编辑器必须展示“供应商原始配置 / 通用配置 / 最终有效配置 / 与 live 文件差异”。
- 语法错误、受限字段、只读目标、外部修改冲突均在写入前阻止。
- 所有目标先 stage 并解析验证，再替换；跨文件失败执行补偿恢复并记录无秘密 journal。
