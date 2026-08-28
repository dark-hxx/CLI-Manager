# 桌面宠物远程托管多 Agent 适配 - Technical Design

## 1. Root-cause statement

现有托管链路在前端资格判断、Tauri IPC、cc-connect 配置、Session 注入、Hook 归属和取消恢复六个边界都把 Agent 隐式固定为 Codex；因此仅放宽桌宠按钮会把非 Codex 会话送入 Codex 的启动和恢复流程。修复必须把 Agent 类型提升为贯穿整条托管链路的显式契约，而不是在 UI 处增加例外。

## 2. Current evidence

- `src/lib/remoteHandoff.ts` 使用 `isCodexSession()` 并返回 `codex_only`。
- `src/stores/terminalStore.ts::resumeSessionFromRemoteHandoff()` 固定准备 Codex Provider 并执行 Codex resume。
- `src-tauri/src/commands/cc_connect.rs::CcConnectAgent` 仅有 Claude/Codex，项目加载把所有非 Codex归为 Claude。
- `resolve_handoff_target()`、预检和 Provider 文案固定 Codex。
- `inject_handoff_session()` 固定写入 `"agent_type": "codex"`。
- `RemoteHookEvent::belongs_to()` 固定要求 `source == "codex"`。
- 本机 cc-connect `v1.5.0-beta.3` 配置示例确认支持 `claudecode`、`codex`、`pi`、`opencode`；Pi RPC 需 `rpc = true`。

GitNexus MCP 未暴露，CLI 索引因缺失 `tree-sitter-kotlin` 无法建立；本设计使用契约、`rg`、真实源码、本机 cc-connect 输出和后续可执行测试复核。

## 3. Shared contract

### 3.1 Agent type

前端复用 `AgentRuntimeKind`，托管入口再收窄为：

```ts
type RemoteHandoffAgent = "claude" | "codex" | "pi" | "opencode";
```

Rust 扩展：

```rust
enum CcConnectAgent {
    Claude,
    Codex,
    Pi,
    Opencode,
}
```

`CcConnectHandoffStartRequest`、`CcConnectHandoffInfo` 与 `PersistedHandoffRecord` 均携带 `agent`。前端不得只根据状态返回值反推 Agent。

### 3.2 Single resolver

新增/复用一个纯函数解析托管 Agent：

1. 先解析项目登记的 `cli_tool`。
2. 再解析会话 `startupCmd` 作为兼容证据。
3. 项目已明确登记支持 Agent 时以项目为准；启动命令明确指向另一个 Agent 时返回 `agent_mismatch`。
4. 两处都无法解析、解析为 Grok 或普通 Shell时返回 `unsupported_agent`。

桌宠候选、主窗口协调器和恢复流程必须消费同一解析结果。

## 4. Data flow

```text
TerminalSession + registered Project
  -> resolveRemoteHandoffAgent
  -> eligibility (agent/environment/state/session ID)
  -> StartRequest(agent + platform + target identity)
  -> Rust resolve_handoff_target (revalidate agent/project/path)
  -> agent-specific preflight/provider preparation
  -> managed cc-connect config + injected existing session
  -> persisted handoff schema v2
  -> Hook/cc-connect messages
  -> cancel -> agent-specific local resume
```

每个边界重新校验输入；后端不信任 WebView 提交的 Agent、路径或 Provider。

## 5. cc-connect configuration

`CcConnectAgent` 提供集中映射，避免散落 match：

| Agent | config type | safe mode | YOLO mode | extra |
| --- | --- | --- | --- | --- |
| Claude | `claudecode` | `default` | `bypassPermissions` | optional managed wrapper |
| Codex | `codex` | `suggest` | `yolo` | `backend=app_server`, `app_server_url=stdio://` |
| Pi | `pi` | `default` | `yolo` | `rpc=true` |
| OpenCode | `opencode` | `default` | `yolo` | capability warning |

`ManagedAgentOptions` 增加可选 `rpc` 与必要的可选启动字段；只在 Pi 时序列化 `rpc=true`。项目加载用共享 CLI 类型解析器，不允许非 Codex 默认落到 Claude。

## 6. Provider ownership

### Codex

完全保留当前 `prepare_remote_codex_launch()`、profile/config override、app-server proxy 和密钥环境注入。

### Claude

- 后端调用 `provider::scope::prepare()`，传入 `appType=claude`、项目、Worktree 和记录 Provider。
- 跟随全局时无快照，使用真实 Home；存在覆盖时取得 `claude_settings_path`。
- 使用 CLI-Manager 受管 `claude` wrapper，在 cc-connect 启动 Claude 时添加 `--settings <snapshot>`；wrapper 不包含密钥，路径经过参数安全校验。
- 托管记录保存可选 `provider_snapshot_id`，启动失败/取消/成功恢复后释放；快照 GC 把活动托管记录视为持有者。
- Provider 快照创建后、cc-connect 获得所有权前失败时立即释放。

### Pi/OpenCode

- 不调用 Native Provider 域，不设置 Claude/Codex Provider 环境。
- `provider_id = null`，显示名由 Agent 与语言生成：“跟随 Pi 配置”/“跟随 OpenCode 配置”。
- 保留项目显式环境变量，但过滤 CLI-Manager/平台/Hook 保留键，继续沿用现有密钥隔离规则。

## 7. Handoff persistence and compatibility

`HANDOFF_SCHEMA_VERSION` 升级为 2，增加：

```text
agent
provider_snapshot_id? (Claude override only)
```

读取规则：

- v2：严格反序列化并验证 Agent。
- v1：在内存迁移为 `agent=codex`，其余字段保持原值；下一次原子写入时升级 v2。
- 其他版本：继续拒绝。

`CcConnectHandoffInfo` 暴露 Agent，但不暴露快照路径/密钥。cc-connect Session 注入接收 Agent 参数并写对应 `agent_type`。

## 8. Preflight and process ownership

- 公共预检：平台 ready、项目存在、Agent 一致、工作目录边界、Session ID、可执行文件、无活动托管。
- Codex：沿用 app-server 实际启动探针。
- Claude/Pi/OpenCode：解析真实 launcher 并运行无副作用版本/帮助探针；不得 resume、创建会话或写项目。
- Pi 同时验证受管配置会生成 `rpc=true`。
- 预检完成后才关闭/暂停原 PTY；写 Session 文档和 handoff 记录保持快照回滚。
- 子进程继续由 `silent_command`/Windows hidden window 启动。

## 9. Cancel and recovery

扩展 `detectCliResumeKind()` 与 `buildCliResumeStartupCommand()`，或收敛到现有 `buildHistoryResumeCommand()` 的共享 Agent 恢复构造器：

| Agent | resume command |
| --- | --- |
| Claude | `claude --resume <id>` |
| Codex | `codex resume --no-alt-screen <id>` |
| Pi | `pi --session <id>` |
| OpenCode | `opencode --session <id>` |

本地恢复按记录 Agent 重新解析当前项目/Worktree Provider。Claude重新准备 Provider 快照；Pi/OpenCode 不准备 Native Provider。新 PTY 创建成功后才解除锁并清理旧托管快照；失败保持 `recovery_failed`。

SSH 分支在 Agent 非 Codex 时后端直接返回稳定错误，现有 Codex SSH proxy 不泛化。

## 10. Hook and notification

`RemoteHookEvent::belongs_to()` 使用标准化 source 与 `record.agent` 一一匹配，并继续校验 `tab_id` 和可选 `cli_session_id`。托管身份哈希增加 Agent，避免相同 ID 的不同 Agent 事件误归属。

Claude/Pi/OpenCode Hook 环境沿用当前 daemon 注入；没有匹配 Hook 时不启动虚假进度。Pi 交互通过 cc-connect RPC；OpenCode 在桌宠卡片/确认处显示 capability warning。

## 11. Discovery list

### Must change

- [ ] `src/lib/remoteHandoff.ts`：共享 Agent 类型、请求/状态、资格原因。
- [ ] `src/lib/desktopPet.ts`：候选 Agent、能力元数据。
- [ ] `src/hooks/useRemoteHandoffCoordinator.ts`：请求传 Agent、错误映射、取消恢复。
- [ ] `src/stores/terminalStore.ts`：多 Agent 本地恢复与 Provider 分支。
- [ ] `src/lib/historyResumeCommand.ts`：补 OpenCode 并复用安全 ID/参数处理。
- [ ] `src/lib/i18n.ts`：zh-CN/en-US 文案与兼容回退。
- [ ] `src-tauri/src/commands/cc_connect.rs`：Agent 枚举、项目解析、配置和启动准备。
- [ ] `src-tauri/src/commands/cc_connect/handoff.rs`：目标、预检、Provider、记录和回滚。
- [ ] `src-tauri/src/commands/cc_connect/handoff_session.rs`：schema v2 与动态 `agent_type`。
- [ ] `src-tauri/src/commands/cc_connect/handoff_notification.rs`：按 Agent 匹配 Hook。
- [ ] 专项 TypeScript/Rust 测试、`CHANGELOG.md`、`docs/功能清单.md`。

### Inspect and change only if required

- [ ] `src/lib/agentCapabilities.ts`：优先复用，避免新建第二套 CLI 识别。
- [ ] `src-tauri/src/provider/scope.rs`：复用现有 API；仅在活动托管快照生命周期确需时做最小扩展。
- [ ] `src-tauri/src/commands/hook_settings.rs`、`opencode_hook.rs`：确认现有 Claude/Pi/OpenCode source，不复制 Hook。
- [ ] 桌宠菜单组件：只有需要展示 Agent/限制文案时调整，不改变既有平台选择交互。

### Confirmed unrelated/out of scope

- [x] cc-connect 源码与全局二进制。
- [x] 平台私有 API、凭据格式和 allow_from 规则。
- [x] SSH Agent 协议与非 Codex SSH恢复。
- [x] WSL 启动链路、历史索引、文件浏览、Git 面板。
- [x] Native Provider 数据库 schema（Pi/OpenCode 不进入该域）。

## 12. Risks

- HIGH：`CcConnectAgent` 和 `resolve_handoff_target()` 位于所有托管启动主链路，错误映射会回归现有 Codex。
- HIGH：取消恢复会关闭/重建 PTY，Agent 命令或 Provider 不一致会造成用户无法回到原会话。
- HIGH：Claude Provider 快照有密钥与生命周期边界，必须覆盖失败清理和重启 GC。
- MEDIUM：OpenCode 审批能力取决于 cc-connect/本地版本，只能做能力提示，不能在 CLI-Manager伪造审批。

控制方式：按 Agent 表驱动、后端重校验、schema 兼容测试、失败原子回滚、Codex 回归测试、逐 Agent 专项测试。
