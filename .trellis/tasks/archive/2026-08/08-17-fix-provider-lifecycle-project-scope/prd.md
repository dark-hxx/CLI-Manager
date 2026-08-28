# 修复供应商生命周期与项目级配置

## Goal

修复原生供应商停用、删除和项目/Worktree 切换的作用域错误：供应商生命周期只受真实项目/Worktree 引用约束，项目级切换不得改写全局 Home，并按 Claude/Codex 各自支持的启动参数在新终端中生效。

## Changelog Target

`V1.3.6`

## Confirmed Facts

- 当前分支为 `master`，与 `origin/master` 同步（领先 0、落后 0）；工作区已有 4 个无关未跟踪研究目录，本任务不触碰。
- `providers.db.provider_import_refs` 记录外部供应商导入来源和指纹，不是项目/Worktree 运行时引用；其外键已声明 `ON DELETE CASCADE`。
- `src-tauri/src/provider/repository/catalog.rs:317` 的 `provider_reference_count` 错把 `provider_import_refs` 当作项目/Worktree 引用，因此任何带导入来源的供应商都会被误判为“仍被使用”。
- 真实用户库还存在旧版 CCS 覆盖；它不能解析为原生 schema-v2 供应商。生命周期扫描若将此解析错误向上传播，会让删除、停用统一退化为通用失败，因此扫描只把有效 schema-v2 精确匹配计为引用。
- 删除与停用共用上述错误检查；前端错误映射还缺少 `provider_referenced_cannot_delete`，因此删除失败退化成通用“供应商操作失败”。
- 项目/Worktree 的真实选择存放在 `cli-manager.db` 的 `projects.provider_overrides` / `worktrees.provider_overrides`，当前 schema-v2 引用包含 `source=cli-manager`、`appType` 和 `providerId`。
- `src/components/ProviderSwitchModal.tsx:322` 当前直接调用 `provider_global_preview` / `provider_global_apply`；这会改写真实 CLI Home，并绕过文件中已经存在的 `withOverride` 和 `updateTargetProviderOverrides`。
- 该回归由提交 `22c8b8b6` 的 Home 切换改造引入；此前 Claude/Codex 项目切换会持久化项目/Worktree override。
- 后端 `provider_scope_prepare` 已具备作用域物化能力：Claude 写隔离 `settings.json` 并由启动命令追加 `--settings`；Codex 在真实 `CODEX_HOME` 旁写非密钥 profile 并追加 `--profile`，密钥只进入进程环境。
- GitNexus 精确影响分析为 LOW：`provider_reference_count` 直接影响 `delete_provider`、`set_provider_enabled` 及两个 Tauri command；`ProviderSwitchModal` 直接由 Sidebar 使用。GitNexus FTS 修复因本机缺少 LadybugDB FTS 扩展失败，已按规约降级为精确符号上下文、契约和源码检查。
- Pi `agent_start` 会等待 Extension 回调完成，而当前 CLI-Manager 生成的 Pi Hook 在该回调中 `await fetch(...)` 上报本地 bridge，且没有超时；慢 bridge 会直接阻塞 Pi 开始处理消息。
- 当前用户已安装 `pi-mcp-adapter`，其 `~/.pi/agent/mcp.json` 保存 `mcpServers`，但能力发现对 Pi 没有注册任何 MCP 配置源，因此快照 MCP 列表为空并显示 `pi_mcp_extension_observability_unknown`。

## Requirements

### R1：正确校验供应商引用

- 停用或删除供应商前，检查 `cli-manager.db` 中真实的项目和 Worktree schema-v2 override，不得把 `provider_import_refs` 当作运行时引用。
- 未被项目/Worktree 使用且不是当前全局供应商时，允许停用和删除，包括从外部导入的供应商。
- 被真实项目或 Worktree 引用时继续阻止停用和删除，避免留下悬空供应商引用。
- 当前全局供应商仍不得停用或删除。

### R2：准确呈现生命周期错误

- 停用和删除分别映射可识别的错误码，不得将预期业务错误降级成通用失败。
- 所有新增或调整文案同时支持 `zh-CN` 与 `en-US`。

### R3：恢复项目/Worktree 级供应商切换

- 项目切换只更新该项目的 `provider_overrides`；Worktree 切换只更新该 Worktree 的 `provider_overrides`。
- 项目/Worktree 切换不得调用全局 preview/apply，不得改写真实 Home 中的全局供应商配置。
- Claude 新终端通过 `provider_scope_prepare` 生成隔离 settings，并以 `--settings <path>` 启动。
- Codex 新终端在真实 Codex Home 中生成非密钥 profile，并以 `--profile <name>` 启动；不得覆盖用户基础 `config.toml` 或 `auth.json`。
- “跟随全局”只清除目标项目或 Worktree 对应 app type 的 override。
- 已运行终端不热切换；新建或按既有恢复规则重新解析的终端使用最新 override。

### R4：Grok 项目级行为

- Grok 项目或 Worktree 打开供应商切换时，直接提示暂不支持，不展示可选择供应商，也不执行任何写入。
- 保留设置页中的 Grok 全局供应商维护与应用能力。
- 保留后端对历史 Grok override 的兼容读取，不做破坏性迁移或自动清理；UI 不再新建或修改 Grok 项目/Worktree override。

### R5：终端 Tab 与预览入口

- 终端会话 Tab 和 Workspan Tab 支持鼠标中键关闭，必须复用现有关闭确认与清理路径，并在拖拽或重命名时忽略中键。
- 已配置 CLI 工具的终端始终显示右上角 Markdown 预览按钮；没有可读历史或未绑定会话时按钮保持可见但不可用。
- Pi 通过既有 `pi` 历史来源和 Hook 绑定的 `cliSessionId` 打开对应会话预览；不得为此改写终端启动或历史 IPC。

### R6：Pi 响应性与 MCP 能力观测

- Pi 生命周期 Hook 的本地 bridge 上报必须脱离 Pi 的同步 Extension 回调，并设置短超时；bridge 失败或超时不得阻塞 Agent 启动、停止或会话绑定。
- 保留 `session_start`、`agent_start`、`agent_settled` 与既有 SessionStart/UserPromptSubmit/Stop 的一对一映射，不重新启用 `before_agent_start`。
- Agent 能力卡片必须读取 Pi MCP Adapter 的已知全局和项目配置源，按 Adapter 优先级展示已激活及禁用 MCP；静态配置仍保持健康状态未知。
- 本地、WSL 和 SSH Agent 都复用相同的 Pi 配置发现语义；不得执行 MCP 配置中的命令、URL、Header 或环境变量。

## Acceptance Criteria

- [ ] 外部导入但未被任何项目/Worktree 引用的非当前供应商可以停用，也可以删除。
- [ ] 被项目引用或活动 Worktree 引用的供应商无法停用/删除，并显示准确的本地化原因。
- [ ] 删除供应商后，其密钥和导入来源映射按现有外键级联清理。
- [ ] Claude 项目与 Worktree 选择供应商后只更新各自 override；全局 Home 保持不变，新终端启动命令包含 `--settings`。
- [ ] Codex 项目与 Worktree 选择供应商后只更新各自 override；全局 Home 保持不变，新终端启动命令包含 `--profile`，且密钥不写入 profile。
- [ ] 项目 override 与 Worktree override 相互隔离，Worktree 优先于项目，清除 Worktree override 后回落项目或全局。
- [ ] 自定义 `startup_cmd` 保持现有不自动改写规则，并继续显示提示。
- [ ] 本地与 WSL Home 不因项目级切换被全局改写。
- [ ] Grok 项目或 Worktree 打开供应商切换时直接显示中英文“不支持”提示，不列出供应商且不写入 override 或全局 Home。
- [ ] 会话 Tab 与 Workspan Tab 的鼠标中键复用既有关闭路径，不影响重命名和拖拽。
- [ ] 配置 Pi 等 CLI 工具启动终端后，右上角预览入口保持可见；已绑定且有已登记历史来源的会话可以打开预览。
- [ ] Pi 的本地 Hook bridge 变慢或不可用时，不会延迟 Agent 开始处理消息。
- [ ] Pi MCP Adapter 的 `mcpServers` 出现在 Agent 能力卡片，`disabled: true` 不计入激活数；已发现配置时不显示 `pi_mcp_extension_observability_unknown`。
- [ ] `npx tsc --noEmit`、相关前端测试、`cargo test`、`cargo check` 通过。
- [ ] `CHANGELOG.md` 的 `V1.3.6` 与 `docs/功能清单.md` 记录本次修复。

## Out of Scope

- 不升级 Tauri、React、Rust 或任何依赖。
- 不修改全局供应商 apply 的 Home 选择和写入字段语义。
- 不更改已运行终端的供应商，不实现热切换。
- 不连接、启动或探测 Pi MCP Server；本次只读取脱敏配置元数据和既有会话证据。
- 不清理与本任务无关的旧供应商代码或研究目录。

## Key Decisions

- Grok 暂不支持项目/Worktree 级供应商切换；入口保留用于明确提示，不静默隐藏。
- 历史 Grok override 只做兼容读取，不自动删除用户数据。
