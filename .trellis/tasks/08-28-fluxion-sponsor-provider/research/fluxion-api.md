# Fluxion API 接入研究

来源：Fluxion AI 官网 `https://fluxionai.space/`（检索日期 2026-08-28）。

## 关键事实

* Claude Code / Anthropic SDK 可使用 `https://www.fluxionai.space` 作为 Anthropic Base URL，并通过 `ANTHROPIC_AUTH_TOKEN` 认证。
* OpenAI SDK 兼容地址为 `https://www.fluxionai.space/v1`，支持 Chat Completions、Responses、Images、Embeddings 与 `/v1/models`。
* 官网列出 `claude-*`、`gpt-*`、`o* / codex-*`、`gemini-*` 等模型族；具体模型应由用户注册后按账户可用性选择，不适合在默认供应商里硬编码单一模型。

## 对本项目的映射

* Claude 默认项可写入 `ANTHROPIC_BASE_URL=https://www.fluxionai.space`，认证字段选择 `ANTHROPIC_AUTH_TOKEN`，模型留空以避免误导。
* Codex 默认项可使用 `https://www.fluxionai.space/v1` 作为 request/base URL；模型留空，待用户填写。
* Grok Build 的协议/配置约定在官网未明确，默认项应保留空配置或沿用项目现有 Grok 配置格式，不推断专用 endpoint。
* 供应商目录的 websiteUrl、赞助商注册卡片和“获取 API Key”动作统一使用用户指定注册链接；API 调用 Base URL 与注册链接是两个不同字段。

## 约束

* 不在前端运行时依赖官网图片或文档；合作商展示使用仓库已有 `docs/img2` 素材。
* 默认供应商种子必须幂等，且不得覆盖已有用户配置或 Key。
