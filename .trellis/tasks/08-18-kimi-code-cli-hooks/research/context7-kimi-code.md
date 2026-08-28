# Kimi Code Context7 索引交叉核对

> 本文件记录最初的文档索引结果。随后固定到官方 `0.37.2` commit 的源码研究发现 Context7 命中了旧 `agent-core` Hook 类型；当前权威结论以 `kimi-code-official-hooks.md` 为准。

## 结论

- Context7 将 Moonshot AI 官方仓库解析为 `/moonshotai/kimi-code`，来源信誉为 High。
- CLI 可执行命令为 `kimi`；验证命令为 `kimi --version`。
- 默认数据根目录为 `~/.kimi-code`，可通过 `KIMI_CODE_HOME` 覆盖；Hook 配置位于 `<KIMI_CODE_HOME>/config.toml`。
- Kimi Code 使用 TOML `[[hooks]]` 数组。当前用户配置 schema 仅允许必填 `event`、`command` 与可选 `matcher`、`timeout`；旧内部类型中的 `cwd`、`env` 不能写入用户配置。
- 当前 `0.37.2` 官方源码支持 20 个事件，新增并推荐用于完整 running 状态的 `TurnStarted`；完整列表和触发语义见 `kimi-code-official-hooks.md`。
- Hook stdin 至少包含 `hook_event_name`、`session_id`、`session_title`、`client_type`、`cwd`。现有共享 normalizer 已支持 `session_id`、`cwd`，无需伪造 Kimi 专属 payload。
- 多个匹配 Hook 会并行执行；相同 command 会去重。CLI-Manager 仍应只写一个精确受管条目，并让重复/陈旧条目显式显示为 partial/outdated 或在确认安装时收敛。

## 官方来源

- Hook 文档：https://github.com/moonshotai/kimi-code/blob/main/docs/en/customization/hooks.md
- Hook 类型：https://github.com/moonshotai/kimi-code/blob/main/packages/agent-core/src/session/hooks/types.ts
- 配置文件：https://moonshotai.github.io/kimi-code/en/configuration/config-files.html
- 数据目录：https://github.com/moonshotai/kimi-code/blob/main/docs/en/configuration/data-locations.md
- CLI 安装与验证：https://github.com/moonshotai/kimi-code/blob/main/apps/kimi-code/README.md

## 实现约束

- 本地和 SSH 均使用 Kimi 原生 `config.toml`，不得套用 Claude `settings.json` 或 Codex `hooks.json`。
- 只操作 command 明确包含 `__hook --source kimi --event ...` 的受管 `[[hooks]]`；保留所有用户及第三方 Hook、未知字段、顺序和注释。
- 本地配置目录支持 Windows、WSL UNC、Linux/macOS home；SSH 配置目录只接受已有远程 POSIX home-path 契约。
- 本任务不新增 Kimi 历史解析。`KIMI_CODE_HOME` 只用于 CLI/Hook 根目录，不得因此启用远程历史能力。
