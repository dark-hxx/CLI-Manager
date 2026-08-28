# 历史会话智能命名自定义 Prompt

## Goal

让用户在“设置 → 会话历史 → 历史会话智能命名”编辑一份全局 Prompt 指令，使所选 Native Provider 按用户的命名偏好生成历史会话标题。

## Background and confirmed facts

- 当前内置标题指令是 Rust 的 `BUILTIN_PROMPT` 回退值，由 `request_title` 传入 Provider 请求。
- `provider::auxiliary_text::post_text_request` 已把系统指令适配为 Anthropic `system`、Chat Completions system message 和 Responses `instructions`（`src-tauri/src/provider/auxiliary_text.rs:21-75`）。
- 首条真实用户消息已独立筛选并作为用户输入发送，工具、推理与注入上下文不会成为候选（`src/lib/historyTitle.ts:49-76`）。
- `historySmartTitle` 是本机持久化的全局设置；现有字段覆盖启用状态、Provider、模型与自动生成水位（`src/lib/types.ts:907-913`、`src/stores/settingsStore.ts:521-527,794-827`）。
- 设置页已有智能命名卡片；手动与自动生成复用同一个 `history_title_generate` 请求（`src/components/settings/pages/HistorySourceSettingsPage.tsx:456-584`、`src/stores/historyStore.ts:3414-3485`）。
- Rust 已从同一份 `settings.json` 读取 Provider 选择以校验请求（`src-tauri/src/commands/history_title.rs:354-410`），因此 Prompt 应由后端读取，而不是新增前端可任意传入的 IPC 参数。
- `historySmartTitle` 被设置同步显式排除（`src/lib/syncSettings.ts:26`），所以该 Prompt 默认保持本机私有。
- `settingsStore.update` 会等待 Tauri Store 写入完成后才更新 Zustand 状态（`src/stores/settingsStore.ts:1759-1767`），因此保存成功反馈可准确放在该 Promise 完成之后。
- 修复前，`history_title_generate` 是同步 Tauri command，并以 `tauri::async_runtime::block_on` 等待内部的异步 Provider 请求；Provider 等待会占用同步 IPC handler。现已改为 async command，等待专用 blocking worker；项目已有网络型 `#[tauri::command] async fn` 模式可复用（`src-tauri/src/commands/command_suggestion.rs:100-147`）。

## Decisions

- 使用一份全局 `customPrompt`，不按 Provider、项目或会话分别保存；切换 Provider/模型不改变它。
- 非空 Prompt 完全替换内置标题指令；清空或“恢复默认”重新使用内置指令。
- 编辑器内容仅是系统指令，不支持 `{{message}}` 等变量；真实用户消息仍由程序独立传入。
- 非空值移除首尾空白、不得包含 NUL、最大 4096 UTF-8 字节。
- 不增加预览/测试 Provider 调用；不改变候选提取、Provider 协议、生成队列、标题持久化或设置同步范围。
- 显式保存 Prompt 仅在本地设置持久化完成后显示成功提示；保存失败不得显示成功。
- 保持 IPC 名称和请求/响应结构不变，但让 Tauri 异步 command 将长请求交给专用 blocking worker；不再在同步 handler 中 `block_on`。

## Requirements

1. 在既有智能命名设置卡片中提供可发现、可访问的多行 Prompt 编辑器，以及保存和恢复默认操作；保存完成后显示本地化成功提示，持久化期间阻止重复保存。
2. `HistorySmartTitleSettings` 持久化 `customPrompt: string`，缺失、空白或无效旧值安全归一化为内置 Prompt 模式。
3. 手动生成和自动新会话生成均从后端读取同一份已保存 Prompt，并将其作为当前 Provider 协议的系统指令。
4. Provider 请求仍将候选用户消息作为单独 user/input 字段；继续沿用现有请求超时、响应校验、标题清洗和无敏感内容日志规则。
5. 编辑器在保存前对超长/NUL 输入给出本地化反馈；恢复默认无需额外网络请求。
6. 新增用户可见文案、提示和无障碍标签同时覆盖 `zh-CN` 与 `en-US`，且不影响既有 `zh-TW` 回退和 24 小时制。
7. 手动与自动智能命名继续使用同一 IPC 名称、请求与响应，但长时间 Provider 请求不得由同步 Tauri command handler 阻塞桌面界面；生成请求被接纳后，详情按钮和对应列表行必须立即显示本地化的生成中反馈，并阻止重复操作直到该请求结束。

## Acceptance criteria

- [ ] 用户可保存一份全局自定义 Prompt，并可在设置页恢复内置默认值。
- [ ] 后续手动和自动智能命名实际使用已保存的 Prompt，且 Anthropic、Chat Completions、Responses 都保持兼容。
- [ ] 空值、恢复默认、缺失旧设置或无效本地设置均回退到变更前的内置 Prompt 行为。
- [ ] 不新增 Prompt IPC 字段、数据库迁移、Provider 协议分支或设置同步内容。
- [ ] 超长/NUL 输入得到安全、本地化的编辑器反馈；日志不含 Prompt、候选文本、密钥或原始模型输出。
- [ ] Prompt 成功提示只会在本地设置写入完成后出现；保存期间不能重复提交，失败不会误报成功。
- [ ] 现有智能标题生成、Provider 选择、自动队列和手动错误提示不回归；约三秒的 Provider 等待不再冻结应用界面，生成按钮立即显示加载状态、列表同步显示生成中且不能重复触发。

## Scenario coverage

- 手动与自动触发、关闭自动命名、设置在队列等待期间更新、已在飞请求完成。
- Provider 快速响应、约三秒延迟、超时和失败；请求期间切换会话/设置页、再次点击生成和自动队列串行行为，以及手动请求替换自动请求时加载状态不会提前消失。
- Claude/Anthropic、Codex/Grok 的 Chat Completions 与 Responses 路径。
- 本地、WSL、SSH 会话的既有身份与候选筛选。
- 旧设置、空白、有效、多行、超长、含 NUL、恢复默认和 Provider/模型切换。
- 多窗口、分屏、Workspan、焦点/最小化、Worktree 与 Hook 安装状态下的全局设置语义不变。
- 已安装正式版与 `npm run tauri dev` 同时运行：两者按启动契约共享应用数据和 SQLite；智能命名必须把跨进程写竞争当作本地持久化问题，而非 Provider/模型/网络故障。
- `zh-CN` 与 `en-US` 设置页面、键盘/ARIA 操作和时间格式。

## Out of scope

- 按 Provider/项目/会话配置 Prompt，模板变量，Prompt 预览或测试请求。
- WebDAV/云同步 Prompt，改变候选消息、标题输出规则、Provider 密钥/协议、队列调度或历史数据库结构。

## Discovery list

- [x] `src/lib/types.ts`：设置类型。
- [x] `src/stores/settingsStore.ts`：默认值、迁移和本地持久化。
- [x] `src/components/settings/pages/HistorySourceSettingsPage.tsx`：智能命名设置 UI。
- [x] `src/stores/historyStore.ts`：已确认 IPC 请求无需扩展。
- [x] `src-tauri/src/commands/history_title.rs`：后端设置读取、默认回退和请求调用。
- [x] `src-tauri/src/provider/auxiliary_text.rs`：已确认可复用，无需修改。
- [x] `src/lib/syncSettings.ts`：已确认保持 `excluded`。
- [x] `src/lib/i18n.ts`：中英文文案。
- [x] `scripts/historySmartTitleIpc.test.mjs` 与 Rust 单测：回归覆盖位置。
- [x] `src-tauri/src/lib.rs`：已确认无需新增 command 注册。
- [x] `src/components/HistoryWorkspace.tsx`：手动智能命名错误分类与本地化 toast。
- [x] `src/stores/settingsStore.ts`：确认 `update` 在持久化完成后才更新前端状态。
- [x] `src-tauri/src/commands/command_suggestion.rs`：确认现有网络型 Tauri async command 模式可直接复用。
- [x] `src/lib/db.ts`、`src-tauri/src/commands/history.rs`：确认主数据库已启用 WAL，既有写入等待预算为 15 秒。
- [x] `.trellis/spec/backend/app-startup-contracts.md`：确认正式版与开发版共享应用数据是受支持场景，不拆分数据根目录。

## Planning evidence limitation

GitNexus FTS 扩展在当前环境不可用，且索引此前滞后；本 PRD 依据现有契约、任务记录和 `rg` 源码检查形成。实现前会按项目规则对实际修改符号运行 GitNexus impact；无法解析时记录契约 + `rg` 降级发现，而不依赖过期图谱结果。
