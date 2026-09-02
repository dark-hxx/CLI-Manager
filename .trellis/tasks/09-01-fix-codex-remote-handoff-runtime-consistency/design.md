# Codex 远程托管运行配置一致性 - Technical Design

## 1. Root-cause statement

故障位于“Native Provider 配置 -> CLI-Manager Codex proxy -> cc-connect app-server”进程启动边界：本地 TUI 使用完整 Provider profile，而托管 app-server 只重新构造地址、密钥、模型、wire API 等参数子集，导致同一个 `cliSessionId` 在两个运行阶段采用不同的 Codex 运行配置；修复必须让 app-server 加载同一完整 profile，并保留显式 Provider 身份校验，而不是继续逐项猜测需要复制哪些配置。

## 2. Evidence

- `terminalStore.resolvePtyLaunch()` 为本地 Codex Provider 会话生成 profile，并将 `--profile <name>` 加到 TUI 启动命令。
- `provider::runtime::materialize_codex_profile()` 已从 Provider、公共配置和活动密钥投影出不含明文密钥的完整 profile。
- `prepare_remote_codex_launch()` 会写入同一个 profile，但 `CodexProviderOverrides::command_args(false)` 在 app-server 分支故意不使用它，只保留少量 `-c` 参数。
- Codex 0.151.0 实际启动 `codex --profile <name> app-server ...` 时返回“`--profile` only applies to runtime commands”，因此 app-server 不能直接消费该全局参数；仅执行 `--help` 成功不能证明真实启动兼容。
- 托管开始前 `suspendSessionForRemoteHandoff()` 等待 `terminalProcessManager.close()`；PtyHost 的 close 在杀死进程树并 join reader 后才确认，已构成明确所有权交接，无需新增并发兜底。
- cc-connect 从本地 rollout 执行 `thread/resume`，聊天平台没有传输完整上下文。

## 3. Runtime contract

本地 Provider Codex：

```text
Native Provider effective settings
  -> materialize complete <profile>.config.toml
  -> real Codex launcher
  -> parse complete profile and flatten it to dotted -c overrides
  -> explicit -c model_provider/provider endpoint/env key/model/catalog locks
  -> app-server --listen stdio://
```

未登记 Provider：

```text
registered Codex launcher + CODEX_HOME
  -> app-server --listen stdio://
```

SSH Codex：继续由 `SshCodexLaunch` 在远端读取远端 `CODEX_HOME`，不得使用本地 profile。

## 4. Command generation

app-server 拒绝 `--profile`，因此代理读取 Native Provider 域生成的同一份 profile，使用 TOML 解析器递归展开所有有效配置，再将显式 Provider/模型锁定追加在后：

```text
codex -c <complete-profile-options> -c <locks> app-server --listen stdio://
```

普通代理透传命令继续使用 `codex --profile <name> ...`，不重复展开 profile。完整 profile 和最终 app-server 参数均设置大小上限，超过 Windows 安全命令行预算时明确失败，不静默截断。

## 5. Diagnostics

只有 `CcConnectProfile.logging_enabled=true` 时：

- managed config 使用 debug 日志级别；
- CLI-Manager 向 proxy 注入诊断开关；
- proxy 仅记录协议阶段和 request ID/thread ID 的短哈希或是否匹配，不记录 prompt、additionalContext、工具参数、响应正文、环境变量或密钥；
- 可观察 initialize、thread/resume、turn/start 请求/响应以及 turn started/completed、非重试错误和审批等待。

关闭日志时保持当前 info 配置和无额外 proxy 输出。

## 6. Process ownership

- 前端资格判断继续要求会话停止或 Hook 权威 idle。
- preflight 不加载目标线程。
- `terminalProcessManager.close()` 完成后才调用 `cc_connect_handoff_start`。
- cc-connect 停止或取消完成后才创建新的本地 PTY resume 会话。
- 本阶段不保留两个 Codex 进程，也不引入轮询等待。

## 7. Scenario matrix

| 场景 | 预期 |
| --- | --- |
| 本地 Codex + 项目 Provider | 完整 profile + 显式 Provider 锁定 |
| 本地 Codex + 跟随全局 | 读取现有 `CODEX_HOME`，不注入 profile |
| Windows launcher 路径含空格/扩展前缀 | 沿用安全 launcher 与 proxy 启动 |
| 登记命令残留 resume 参数 | 继续剥离，不重复 Session ID |
| 四种消息平台 | 共用同一 cc-connect 进程和修复 |
| cc-connect 日志开/关 | 开启有阶段诊断；关闭无额外输出 |
| SSH Codex | 保持远端配置与远端 launcher |
| Claude/Pi/OpenCode | 不进入 Codex profile/proxy 分支 |
| 取消托管/恢复失败 | 保持现有锁与 `recovery_failed` 语义 |

## 8. Discovery list

### Must change

- [x] `src-tauri/src/codex_app_server_proxy.rs`：app-server 结构化展开完整 profile，普通命令保留 `--profile`；增加安全阶段诊断、命令行预算和测试。
- [x] `src-tauri/src/commands/cc_connect.rs`：按日志开关注入诊断配置，补运行配置/命令生成测试。
- [x] `CHANGELOG.md`：`TEMP` 版本修复记录。
- [x] `docs/功能清单.md`：远程托管配置一致性和诊断能力。

### Inspect, change only if evidence requires

- [x] `src/stores/terminalStore.ts`：已确认 close 等待 PtyHost 完成，无需改。
- [x] `src-tauri/src/pty/manager.rs`：已确认 close 杀进程树并 join reader，无需改。
- [x] `src-tauri/src/commands/cc_connect/handoff.rs`：现有 preflight/关闭/启动顺序正确，无需改。
- [x] `src-tauri/src/provider/runtime.rs`：已经生成完整 profile，无需新增配置字段。
- [x] `src-tauri/src/provider/scope.rs`：本地 TUI 已消费同一 profile，无需改。

### Out of scope

- [x] cc-connect 源码、全局安装和平台 SDK。
- [x] 纯消息中继/单 Agent 后端架构。
- [x] 数据库、IPC 契约和 UI 文案。

## 9. Risk and rollback

- 风险等级 CRITICAL（GitNexus 调用链标注）：`build_codex_child_args()` 同时影响本地 Codex 托管 app-server 和普通 proxy 透传；profile 加载仅进入本地 Provider 托管分支。
- 控制：分别覆盖 app-server/非 app-server、有 Provider/无 Provider、参数顺序和无效配置测试；SSH 不带本地 launcher/profile。
- 回滚：恢复 app-server 不加载 profile 的旧逻辑即可；无数据迁移和持久化格式变化。

## 10. Tool fallback

仓库内 GitNexus CLI 索引因 `tree-sitter-kotlin` 缺失而无法建立。已降级到 codebase-memory moderate 索引和调用路径分析，并继续使用 Trellis 契约、`rg`、源码、Git diff 和可执行测试复核；memory 结果仅作为定位线索。
