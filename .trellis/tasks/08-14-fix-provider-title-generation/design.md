# Provider 配置后智能标题生成失败 · 技术设计

## 根因陈述

当前失败发生在后端辅助文本请求边界：智能标题服务重复实现了 OpenAI Responses 请求构造，使用结构化 `input_text` 消息数组，而现有命令建议链路对同一兼容 Provider 使用字符串 `input`；当前本地 Codex Provider 正是 Responses + 自定义 `/v1` 网关场景，因此两条链路的协议形态分叉会让 CLI/已有请求可用而智能标题失败。修复应落在共享协议请求层，同时改善前端对稳定失败码的分类展示。

这是基于源码和当前脱敏运行配置的根因候选，实施时用请求体回归测试确认；不通过在前端继续增加 fallback 掩盖错误。

## 数据流与边界

```text
HistoryWorkspace
  -> historyStore.generateSmartTitle
  -> history_title_generate IPC（只含稳定会话身份、候选摘要哈希、Provider 复合身份、模型）
  -> history_title.rs
  -> provider runtime（providers.db + active key，仅 Rust）
  -> provider::auxiliary_text + network_client
  -> Provider 协议端点
  -> 受限响应文本
  -> CAS/revision 提交
  -> HistoryGeneratedTitleMeta / displayTitle
```

- WebView 不接触 API Key、完整 Provider 文档、有效 endpoint 查询参数或原始响应。
- Provider 身份始终是 `(app_type, provider_id)`；Codex 运行时继续复用 `load_codex_runtime_config`。
- 请求 helper 只负责端点、请求体、HTTP/响应体边界；标题服务继续负责候选限制、标题清洗、工具/异常完成拒绝和 CAS。
- 命令建议保留现有公开命令签名和输出行为，只把 OpenAI 请求构造/响应体读取下沉到 helper，避免同协议再次分叉。

## 设计决定

1. 新增后端内部 `provider::auxiliary_text`，集中 OpenAI Responses、Chat Completions 和 Anthropic Messages 的非流式文本请求构造、端点拼接、超时和响应体上限。
2. Responses 的标题输入采用现有兼容链路验证过的字符串 `input` 形态；不得携带工具、MCP、Web Search、reasoning 或源 Agent 配置。
3. 统一端点规则：根 URL 加 `/v1/<path>`，`/v1` 不重复追加版本段，已带完整 endpoint 不重复追加。
4. 后端保留稳定失败码，HTTP body 只用于判定状态/JSON，不进入错误字符串或日志。前端按错误码映射安全的中文/英文提示，未知码仍回退通用文案。
5. 不改变 `history_generated_titles` 表、revision/CAS、别名 pin、自动队列和源标题逻辑。

## 发现清单

- [x] `src/components/HistoryWorkspace.tsx:1192-1230`：错误码到 toast 的最终展示；当前只有 Provider readiness 被细分。
- [x] `src/stores/historyStore.ts:3407-3478`：手动/自动请求入口、候选和 Provider 选择校验、IPC payload。
- [x] `src-tauri/src/commands/history_title.rs:300-730,1108-1134`：Provider runtime、协议判定、请求体、响应提取和 CAS 完成。
- [x] `src-tauri/src/provider/runtime.rs:14-70, parse_runtime_config`：Codex effective base URL/model/wire API/key 解析。
- [x] `src-tauri/src/provider/network_client.rs:95-142`：统一代理/网络客户端配置。
- [x] `src-tauri/src/commands/command_suggestion.rs:496-707`：已有 OpenAI endpoint/body/response-body 实现，必须保持兼容。
- [x] `src-tauri/src/provider/repository/*`：active key、common config、复合 Provider 身份和 secret projection；不改存储契约。
- [x] `src-tauri/src/lib.rs:1407-1410`：智能标题命令注册；仅在命令签名变化时触及。
- [x] `src/components/settings/pages/HistorySourceSettingsPage.tsx:455-505`：Provider/model 选择与启用；当前配置入口不是本次根因。
- [x] SSH/WSL/Worktree/Hook：请求本身与来源解耦；继续由现有候选与远程 detail gate 控制，不新增远端写入或扫描。

## 场景矩阵

| 维度 | 必须验证 |
|---|---|
| 协议 | Codex Responses（当前复现优先）、Codex/Grok Chat Completions、Claude Messages |
| Base URL | 根 URL、`/v1`、已带完整 endpoint；无重复 `/v1` |
| Provider 状态 | ready、禁用、无 active key、模型缺失、协议不支持、Provider 被删除/选择变更 |
| 网络/HTTP | 连接失败、超时、429、401/403、404、5xx、响应过大 |
| 响应 | 合法文本、多个文本块、空文本、非法 JSON、tool call、异常 finish/status |
| 生命周期 | 手动/自动、重复点击、alias pin、删除会话、stale revision、应用重启 pending |
| 来源 | Local/WSL/SSH 在线 detail、SSH summary-only/offline、Worktree/父子/同 ID 不同 source instance |
| 安全/国际化 | 不泄露 key/正文/原响应；zh-CN/en-US 新提示，zh-TW 回退，保持标题优先级 |

## 回滚与兼容

- 共享 helper 变更可整体回滚；`history_generated_titles` additive migration 和已有标题记录不受影响。
- 若某 Provider 明确不接受无工具文本请求，返回 `history_title_provider_protocol_unsupported` 或响应格式错误，不猜测降级为另一协议。
- 关闭智能标题仍保持零请求；已有生成标题和来源标题展示不变。
