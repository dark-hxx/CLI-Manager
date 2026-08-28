# 修复 Provider 配置后智能标题生成失败

## Goal

修复配置有效的 Native Provider 与模型后，用户点击历史会话“智能生成标题”仍失败的问题，使标题请求复用已验证的 Provider 协议/网络约定，并保留来源标题兜底与安全错误分类。

## Background and confirmed facts

- 本任务是 `.trellis/tasks/08-14-history-two-stage-smart-title/` 的子任务，范围限定为智能标题 Provider 请求失败。
- 用户确认 Provider、模型和网络配置正确，但前端仍显示“请检查 Provider、模型和网络配置后重试”。
- 这是跨前端操作、Tauri IPC、Provider runtime 解析、协议请求和网络客户端的行为性故障，必须走根因修复。
- 当前前端 `HistoryWorkspace` 已把 `history_title_provider_*` 映射为配置提示；其余请求/协议失败统一落到笼统 toast，后端错误码没有丢失，但用户无法判断真实失败边界。
- 后端 `src-tauri/src/commands/history_title.rs` 单独实现了 Anthropic Messages、OpenAI Responses、Chat Completions 请求；现有 `src-tauri/src/commands/command_suggestion.rs` 已有经过验证的 OpenAI 请求体、端点拼接、响应读取和错误分类实现。
- 当前本地脱敏配置选择为 Codex Native Provider：Provider 已启用、active key 存在、模型为 `gpt-5.6-luna`，effective base URL 为 `https://ai.clim.asia/v1`，wire API 为 `responses`。本地配置本身不是“未选择 Provider”的证据。
- 两套 Responses 实现存在协议请求体差异：命令建议发送字符串 `input`，智能标题发送带 `input_text` 块的消息数组；这对标准 Responses API 都可能合法，但对现有兼容网关会形成真实兼容性风险，也是当前最优先验证的根因候选。

## Requirements

- 智能标题必须通过 Provider 后端保存的 `(appType, providerId, modelId)` 解析 active key、effective endpoint、协议和模型；前端不传密钥或完整配置。
- OpenAI Responses、Chat Completions 和 Anthropic Messages 的请求体、端点拼接、超时、响应体上限、错误码和文本提取必须遵循单一后端协议约定，不能继续出现同协议分叉。
- 对兼容 OpenAI Responses 的 Provider，请求必须采用现有可工作的最小文本输入形态，并保留 `store=false`、无工具、有限输出等标题约束。
- 保留智能标题的 revision/CAS、别名 pin、来源标题 fallback、自动失败不循环重试和敏感信息不出前端/日志行为。
- 手动失败 toast 至少能区分 Provider readiness、HTTP/限流、超时、响应格式/空文本和协议不支持；错误信息不得包含 API Key、用户正文、完整响应或敏感 URL 查询参数。
- 不重做 Provider 域、不改变历史标题存储结构、不扩大到自动队列策略或其他 LLM 功能。

## Acceptance Criteria

- [ ] 使用当前有效 Codex Responses Provider 和已配置模型点击“智能生成标题”时，请求体与现有兼容请求约定一致，成功后保存并显示生成标题。
- [ ] Anthropic Messages、OpenAI Responses、Chat Completions 各有请求体/响应解析回归测试；至少覆盖当前 Codex 兼容网关使用的 Responses 字符串输入形态。
- [ ] Provider、模型、协议、网络、HTTP 429/5xx、非法 JSON、空文本和超时均返回稳定安全错误码；前端不再把可区分的请求失败全部压成同一“检查配置”原因。
- [ ] Provider 无效、active key 缺失、模型无效、无合格正文和 stale revision 仍保持来源标题/已有标题，不泄露秘密、不污染历史源文件。
- [ ] `npx tsc --noEmit`、`cd src-tauri && cargo check`、相关 Rust 单元测试和 `cargo test --lib` 通过。

## Out of scope

- 不修改用户 Provider、模型、网络配置，不替用户测试或重置密钥。
- 不实现新的 Provider 类型、OAuth/外部 CLI 凭据支持或自动批量重试。
- 不把 API Key、用户正文或完整上游响应写入前端状态、toast、任务元数据或日志。

## Planning status

- 根因已由请求体回归测试确认：智能标题原先发送结构化 `input_text` 消息数组，而现有兼容请求链路使用字符串 `input`；当前 Responses 网关对两者处理不一致，导致 Provider 配置正确时标题请求失败。
- 修复已落在共享 `provider::auxiliary_text` 协议边界；未修改 Provider 数据、密钥、历史标题表或自动队列策略。
