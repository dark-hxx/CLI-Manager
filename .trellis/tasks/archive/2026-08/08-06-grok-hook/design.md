# Grok 真实 Home 启动设计

## Architecture

供应商解析仍生成可释放的启动快照，但 Grok 快照从“临时 Home”改为“进程覆盖凭据”。后端负责解析并校验供应商运行时数据、保存 manifest 与密钥、向 PTY 子进程注入环境变量；前端只负责把后端返回且已校验的模型追加为 Grok `--model` 参数。

```text
provider scope resolve
  -> effective Grok provider (base URL / model / key)
  -> snapshot manifest (base URL / model) + provider.key
  -> frontend command: grok --model <model>
  -> PTY env: GROK_MODELS_BASE_URL + XAI_API_KEY
  -> GROK_HOME untouched -> real hooks/MCP/sessions/skills remain visible
```

## Boundaries

- `src-tauri/src/provider/scope.rs`
  - Grok 不再生成 `<snapshot>/grok/config.toml` 或 `generated_home`。
  - manifest 保存 Grok Base URL 与模型，避免信任前端回传任意运行时配置。
  - 环境注入校验 manifest/DTO 一致性后设置 `XAI_API_KEY`、`GROK_MODELS_BASE_URL`，明确移除供应商链路自身注入的临时 `GROK_HOME`。
- `src/lib/types.ts`、`src/terminal/core/TerminalProcessManager.ts`
  - Grok 启动配置由 `generatedHome` 改为 `model`。
- `src/lib/projectStartupCommand.ts`、`src/stores/terminalStore.ts`
  - 对直接 Grok 命令安全追加 `--model`；已有用户 `-m/--model` 时以供应商选择为准，替换而非重复。
  - 新建和 resume 两条路径使用同一 helper。
- `.trellis/spec/backend/ccs-provider-domain-contracts.md`
  - 更新 Grok scope 合同：真实 Home + 进程级覆盖，不再声明 `GROK_HOME` 隔离。

## Compatibility

- 旧的持久化 Grok snapshot 含 `generatedHome`。启动恢复时判为旧格式、释放并重新准备，避免继续注入临时 Home。
- manifest 新字段使用可选反序列化以允许垃圾回收旧快照；新 Grok 启动必须要求完整 Base URL 与模型。
- Claude、Codex DTO 和启动路径不变。

## Security

- 密钥不进入命令行、manifest、日志或前端 DTO，只存在快照密钥文件和 PTY 子进程环境。
- Base URL 与模型在后端生成并通过 manifest/DTO 一致性检查，命令参数经过 shell 元字符拒绝与引用。
- 不修改真实 Home 中除已有全局应用行为之外的任何文件。

## Rollback

回滚代码即可恢复旧的临时 `GROK_HOME` 行为；快照均可垃圾回收，无数据库迁移。
