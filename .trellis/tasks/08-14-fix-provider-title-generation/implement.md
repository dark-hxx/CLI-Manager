# Provider 配置后智能标题生成失败 · 实施计划

## 实施前检查

- [x] 重新确认 `git status --short`，隔离当前工作区已有的父任务、Trellis 和无关改动。
- [x] 检查当前分支 upstream；不在脏工作区上做 pull/reset/checkout。
- [x] 读取 `trellis-before-dev` 约束和 Phase 2.1 细节。
- [x] 对每个将修改的函数/模块执行 GitNexus upstream impact；共享 `configure_builder`/`load_codex_runtime_config` 为 CRITICAL，已保持不改；新/脏符号由源码校验补足。

## 实施步骤

1. [x] 新增 `src-tauri/src/provider/auxiliary_text.rs`：集中端点拼接、OpenAI Responses/Chat 请求体、Anthropic Messages 请求体、统一响应体上限和网络请求错误分类；注册到 `provider/mod.rs`。
2. [x] 将 `src-tauri/src/commands/command_suggestion.rs` 的 OpenAI 请求构造与响应体读取改为调用 helper；保持其 Tauri command 签名、返回数据、调试日志和既有错误行为。
3. [x] 将 `src-tauri/src/commands/history_title.rs` 的 `request_title` 改为调用 helper，尤其把 Responses `input` 改为已验证的字符串形态；保留标题专用文本提取、tool/finish 校验、清洗和 CAS。
4. [x] 为 helper 和标题适配补回归测试：端点去重、三协议请求体不含工具/推理、Responses 字符串 input、响应体上限、文本提取和稳定错误码。
5. [x] 更新 `HistoryWorkspace` 的智能标题错误映射和 `src/lib/i18n.ts` 的 zh-CN/en-US 文案，使超时、限流、HTTP 状态、响应不兼容与 Provider readiness 可区分；不显示原始 response/body。
6. [x] 检查 `historyStore` payload、Provider 选择、CAS/revision 和现有来源 fallback 未被改变；只在发现直接回归时修正相关测试。

## 验证命令

```powershell
npx tsc --noEmit
cd src-tauri
cargo fmt -- --check
cargo check
cargo test --lib commands::command_suggestion
cargo test --lib commands::history_title
cargo test --lib
```

必要时补跑既有前端历史纯函数测试；不使用真实 Provider key 发起收费请求。人工验证使用本地 mock HTTP server 检查请求体和错误映射，再由用户在自己的 Provider 上点击一次确认。

## 实际验证结果

- `rustfmt --edition 2021 --check`（本任务涉及的 4 个 Rust 文件）：通过。
- `cargo fmt --all -- --check`：仅剩工作区中父任务已有的 `request_logs.rs`、`lib.rs`、`usage.rs`、`usage_schema.rs` 格式差异；本任务文件无格式差异。
- `cargo check`：通过。
- `cargo test --lib commands::command_suggestion`：12 passed。
- `cargo test --lib commands::history_title`：4 passed。
- `cargo test --lib provider::auxiliary_text`：5 passed。
- `cargo test --lib`：1038 passed，1 ignored。
- `npx tsc --noEmit`：通过。
- 未调用真实 Provider；配置、密钥和原始响应未进入日志或前端。

## 风险与回滚点

- `command_suggestion.rs` 是已有功能：先用原有测试锁定行为，再做 helper 接线；若出现行为差异，只回滚接线，不改变 helper 的标题需求。
- Provider 协议字段差异可能导致部分网关只接受某种 Responses input；测试固定字符串 input，并保留稳定错误码，不做隐式协议降级。
- UI 文案新增属于用户可见行为，必须同步 zh-CN/en-US 并检查 zh-TW fallback。
- 不执行 Git reset/checkout，不覆盖父任务已有改动；提交前由 `gitnexus_detect_changes` 确认只包含本子任务预期符号/流程。
