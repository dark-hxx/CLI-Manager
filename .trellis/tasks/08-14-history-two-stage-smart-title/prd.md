# Issue #184 · 历史会话两阶段智能命名

关联 Issue：https://github.com/dark-hxx/CLI-Manager/issues/184

## Goal

在不修改 Claude、Codex 等第三方原始会话文件、不阻塞历史索引和终端主流程的前提下，为历史会话提供“即时可读、可选增强、失败无损、人工命名优先”的两阶段标题：继续以首条真实用户输入作为零成本来源标题，并允许用户通过独立 Native Provider/模型生成一次短语义标题，降低大量历史会话的辨认和回溯成本。

## Background and confirmed facts

- Issue #184 阶段 A 已完成：历史详情默认“对话”视图已精简正文，“原文”保留完整审计能力。现有阶段任务记录在 `.trellis/tasks/08-13-history-auto-title-raw-view/prd.md`。
- 当前本地/WSL/SSH 历史解析已优先以首条真实用户输入推导 `HistorySessionSummary.title`；它是可重建的来源标题，不应被模型结果原地覆盖。
- CLI-Manager 已支持会话手动别名，当前展示优先级是 `alias.trim() || summary.title`（`src/stores/historyStore.ts:1416`）。人工别名必须继续是最高优先级。
- `session_meta` 是 CLI-Manager 自有 SQLite 元数据，适合保存用户/模型派生状态；历史 catalog 是可删除重建的派生缓存，按契约不能成为智能标题真源（`.trellis/spec/backend/history-index-contracts.md:17-28`）。
- Native Provider 域由后端独占 `providers.db`，密钥不得返回或持久化到 Zustand/WebView；供应商复合身份必须是 `(provider_id, app_type)`（`.trellis/spec/backend/ccs-provider-domain-contracts.md:9-19`）。
- 当前 provider 类型包括 Claude、Codex、Grok Build；不同类型可能使用 Anthropic Messages、OpenAI Responses 或 Chat Completions 协议，标题生成必须复用 provider 域的配置解析和网络策略，不能让前端提交明文 API Key。
- 参考实现研究已固化到 `research/reference-title-implementations.md`：Codex 开源本地链路用首条用户输入作零成本标题；Cherry Studio 用首轮内容异步覆盖；DeepSeek Harness 提供 fallback、provenance、revision、pin、输入/输出限制和安全清洗的完整并发模型。

## Confirmed product decisions

以下产品决策已在规划阶段确认：

- 自动智能命名默认关闭；关闭时完全保持当前标题行为且不产生外部请求或费用。
- 自动命名开关必须同时出现在历史会话工作区顶部工具栏的常驻便捷入口与“设置 → 会话历史”正式设置入口；两个入口绑定同一持久化设置，状态和禁用原因实时一致。历史页入口在配置缺失时显示原因并可跳转正式设置。
- 用户选择一个独立的 Native Provider 与模型后才能开启自动命名；首版不跟随当前 CLI 会话模型，避免凭据/路由不可调用或来源不确定。
- 自动模型输入默认只包含首条真实用户正文，不包含助手回答、工具、reasoning、系统/开发者注入、路径元数据或完整历史。
- 自动处理只覆盖启用后的新会话；已有历史仅允许用户显式“生成智能标题”。
- 自动失败每个会话/源正文指纹只尝试一次，不后台循环重试；关闭再重新开启自动命名也不会重试既有失败会话，用户只能显式手动重试。
- 用户手动别名会 pin 自动标题并使晚到自动结果失效；显式手动“生成/重新生成”仍允许执行且不删除别名，模型结果保存为备用层但继续被别名遮盖，清空别名后才显示。
- 本任务一次性完整交付手动生成/重试/清除与新会话自动队列生成，包括元数据、Provider 请求、revision/CAS、失败恢复和场景验证；不拆分后续自动化任务。
- 首版覆盖 Native Provider 中所有具备应用侧凭据且可安全执行纯文本请求的 Claude、Codex、Grok Build 类型，适配 Anthropic Messages、OpenAI Responses 与 Chat Completions；external-CLI/OAuth-only 配置排除。
- SSH 首版不升级 Agent 协议；仅当远端在线且桌面端已取得可信会话 detail 时允许自动/手动生成，summary-only 缓存或离线会话不触发，远端始终只读。

## Requirements

### R1 · 标题来源与展示优先级

- 标题来源明确分为：
  - `source`：历史解析器从第三方会话内容推导的来源标题；
  - `generated`：CLI-Manager 调用模型生成的智能标题；
  - `manual`：用户保存在 `session_meta.alias` 的手动别名。
- 展示优先级固定为：`manual alias > generated title > source title > session ID`。
- 模型结果只写 CLI-Manager 自有元数据，不修改第三方 JSONL、Codex session index、Claude 历史文件、SSH 远端文件或可重建 history catalog。
- 来源标题继续按现有解析器规则即时可用；智能标题尚未生成、生成中或失败时，列表无空白和闪烁回退。
- 清除智能标题后立即恢复来源标题，并为当前会话/源正文指纹保留自动抑制状态；未来自动事件不得再次生成，只有用户显式手动“生成智能标题”才能解除抑制并发起新请求。清除手动别名后显示智能标题（若有），否则显示来源标题。

### R2 · 配置与隐私披露

- 在历史会话相关设置中增加：自动智能命名开关、标题供应商、标题模型和简明隐私/费用说明。
- 自动开关默认关闭；没有可用供应商、active key、请求 URL 或模型时不得启用，并提供可操作的错误提示和前往供应商设置入口。
- 供应商选项来自 Native Provider 域，只列出已启用且具备可调用凭据和支持文本生成协议的条目；身份使用 `(appType, providerId)`，不能只存 provider ID。
- 模型允许从供应商配置/已拉取模型中选择，也允许保留有效的手输模型 ID；供应商被删除、禁用、失去 active key 或模型配置失效时设置保持可诊断，但自动任务不发请求。
- API Key、OAuth token 和完整有效配置只在 Rust 后端解析与使用，不返回前端，不写入 settings store、toast、日志或标题元数据。
- 文案明确说明：发送首条用户正文到所选外部供应商，可能产生费用；工具调用、工具返回、思考过程和系统上下文不发送。
- 新增用户可见文案同步覆盖 `zh-CN`、`en-US`，并兼容现有 `zh-TW` 覆写/回退；时间仍使用 24 小时制。

### R3 · 标题输入提取与 Prompt

- 只选择第一条符合当前 Conversation 视图语义的真实用户文本：优先结构化 `parts.kind === text`，排除 system/developer 注入、tool、reasoning、metadata、技能/AGENTS/权限/环境上下文和附件-only 记录。
- 源消息身份必须稳定，至少由 `source + sourceInstanceId + sourceSessionId + transportKind + raw pointer/message identity` 组成；不能只用可因重解析变化的前端数组下标。
- 标题请求使用 JSON framing 或同等结构化封装，避免用户文本破坏 prompt 分隔符。
- 首版使用内置固定系统指令，不开放自定义 Prompt、变量或模板设置；指令要求沿用输入语言，只返回单行自然语言标题，禁止解释、引号、Markdown、XML、代码和终端控制字符，目标约 5 个非 CJK 词或 10~20 个 CJK 字符。
- 默认最大模型可见输入为 4096 UTF-8 bytes，超限在 Unicode code point 边界安全截断，并在本地记录“已截断”诊断但不记录正文。
- 输出上限建议 64 tokens；模型调用不得携带 MCP、Web Search、知识库、工具定义或来源 Agent 配置，reasoning/thinking 显式关闭或设为最低无推理模式。

### R4 · 后端模型请求边界

- 新增后端标题生成服务/命令，输入只包含会话稳定身份、期望 revision 和显式操作类型；前端不得传 base URL、API Key 或完整 provider 配置。
- 后端根据保存的 `(appType, providerId, modelId)` 从 provider repository 读取并校验最新 provider、active key、endpoint、协议和模型。
- 复用统一 network client/proxy/TLS 策略与已有协议构建/响应解析能力；不得复制一套只服务于标题的裸 `reqwest` 和错误处理分支。
- 支持当前 Native Provider 可真实调用的文本协议；某协议无法安全构造无工具、无推理请求时应明确标记不支持，而不是猜测降级。
- 请求必须有连接/总超时、响应体大小上限、非 2xx 分类、JSON 解析校验、text-only 提取和可取消机制。
- 日志只记录 session key 哈希/安全身份、provider/model、耗时、状态与错误码；不记录用户正文、API Key、完整 endpoint query 或模型原始响应。

### R5 · 持久化、revision 与人工 pin

- 在 `cli-manager.db` 的用户元数据层新增智能标题持久化，不能放在可重建 catalog。推荐新增专用表而不是继续扩宽混合职责的 `session_meta`：
  - `session_key`（主键/外键语义）；
  - `generated_title`；
  - `generation_state`：`idle | pending | succeeded | failed`；
  - `generation_revision`；
  - `trigger_kind`：`automatic | manual`；
  - `source_message_identity` 和内容指纹；
  - `provider_app_type/provider_id/model_id`；
  - `failure_code`（脱敏、可枚举）；
  - 当前源正文指纹的自动抑制标记；
  - `requested_at/completed_at/updated_at`。
- 历史 migration 只增不改；新表/列通过新的 Tauri SQL migration 注册。
- 每次任务先以事务/CAS 将 revision 加一并写 `pending`；结果只有在以下条件同时成立时才能提交：session 仍存在、当前 revision 等于请求 revision、源消息身份/指纹仍匹配、没有新的手动别名 pin、当前任务未被取消。
- 用户保存非空 alias 时使现有自动请求失效；即使 HTTP provider 忽略取消，晚到结果也不能覆盖当前状态。
- 用户清空 alias 不自动触发模型调用，只按优先级恢复智能/来源标题；该会话后续仍仅遵循既有自动尝试/抑制状态，重新生成必须由显式手动操作触发。
- 应用崩溃或关闭时遗留的 `pending` 在下次加载时归一化为 `failed/interrupted`，UI 对自动失败保持静默，且不自动重复计费。

### R6 · 自动触发、队列与去重

- 自动触发不依赖 CLI Hook；以历史索引/详情确认首条真实用户正文已持久化、身份与内容指纹稳定为共同边界，不等待助手回答，覆盖 Hook 安装与未安装、本地/WSL/SSH 来源。
- 只对设置启用后首次观察到的新会话自动生成；启用前已有历史不批量请求模型。
- 使用应用级有界单队列（推荐并发 1），同一稳定 session key + source fingerprint 只允许一个自动任务；列表刷新、catalog generation 变化和重复文件事件不能重复计费。
- 自动任务在用户手动别名、清除/重新生成、会话删除、供应商切换/失效、应用退出时根据所有权规则取消或失效；清除后写入当前指纹的自动抑制，关闭再开启开关也不会解除。
- 远程 SSH 历史只有在在线并已按需取得可信 detail 正文时才可生成，结果仅写本地元数据；summary-only 缓存和离线会话不请求，且绝不对远端执行写操作。
- Worktree、同 session ID 的不同来源实例/路径、父子会话必须由稳定 session key 隔离，不能共享 revision 或标题。

### R7 · 手动操作与反馈

- 历史列表会话右键菜单与当前会话详情标题区都提供一致的智能标题操作：
  - `生成智能标题`：没有智能标题时；
  - `重新生成智能标题`：已有成功/失败记录时；
  - `清除智能标题`：已有智能标题时。
- 两个入口消费同一状态与命令，不复制生成逻辑；生成中、不可用原因和操作结果保持一致。
- 保留现有会话别名编辑入口；别名是显式人工 pin，始终优先。
- 手动生成可用于旧会话，但同样要求有效 provider/model、可提取的真实用户正文和隐私披露。
- 列表在具体会话行显示轻量生成中状态图标与 tooltip，不占用主标题空间；自动失败完全静默，不显示徽标、行级错误或 toast，只写安全日志并允许用户从右键/详情显式重试；手动操作失败才显示明确 toast。
- 快速切换列表、搜索、分组、父子树或关闭历史工作区不影响后台任务正确归属；成功后只刷新对应 session view/title，不重置当前筛选、滚动或选中态。

### R8 · 删除、快照、同步与兼容

- 删除历史会话时同步删除其智能标题元数据；批量删除和父子树删除沿用现有 session key 作用域。
- 收藏快照仍保存来源详情；显示标题在 hydrate 时叠加本地 alias/generated 元数据，避免把智能标题误写成第三方来源 title。
- 智能标题沿用当前 `session_meta` 的设备本地边界，本任务不纳入 WebDAV 备份/恢复；不进入远端历史源缓存，也不污染跨主机 source identity。未来若同步，必须另行升级版本化 snapshot/恢复白名单并设计冲突合并。
- 旧数据库无新表、旧快照无新字段、旧远端 agent 不认识智能标题时均保持现有标题行为。
- provider 被删除/模型被改名后，已成功生成的标题继续展示；仅新的生成/重试被阻止并显示配置失效。

### R9 · 可观测性和安全

- 失败码至少区分：配置关闭、provider 缺失/禁用、active key 缺失、模型缺失、协议不支持、无合格正文、输入超限处理失败、超时、取消、HTTP、限流、响应过大、响应格式/空标题、stale revision、会话已删除。
- 自动失败不得造成未处理 Promise、无限重试、重复 toast 或历史索引失败。
- 规范化移除换行、引号包装、ANSI/OSC/CSI、C0/C1、零宽和双向控制字符，折叠空白，并按 UTF-8 bytes 安全限制最终标题长度。
- 所有数据库写入参数化；供应商密钥和用户正文不得进入错误字符串、审计标题表或前端持久化。

## Scenario matrix

| 维度 | 必须覆盖的行为 |
|---|---|
| 自动开关 | 默认关闭零请求；开启仅处理启用后的新会话；关闭后不再入队并使未开始任务失效 |
| 用户操作 | 无别名/有别名；生成中改名；生成中清除/重新生成；清空别名；删除会话 |
| 来源 | Claude/Codex/Grok/OpenCode/Pi 等当前历史来源；有结构化 parts/旧扁平消息；附件-only/系统注入 |
| 运行环境 | Local、WSL、SSH 在线/离线；主仓库、Worktree；目录已删除 |
| Hook | 已安装/未安装/仅一种 CLI 安装，触发结果一致 |
| 会话拓扑 | 单会话、多会话、父子/子任务、相同 session ID 不同 source instance |
| UI | 历史页打开/关闭、搜索、筛选、快速切换、批量选择、窗口最小化/托盘/退出 |
| Provider | Claude/Codex/Grok Build；Chat Completions/Responses/Messages；禁用/删除/失去 key/模型变化 |
| 网络 | 离线、代理、TLS、超时、429、5xx、响应过大、非法 JSON、空输出、tool call/非正常 finish |
| 生命周期 | 重复索引事件、应用崩溃时 pending、重启、并发手动重试、旧响应晚到 |
| 数据兼容 | 新旧 DB、新旧 favorite snapshot、WebDAV 备份恢复、只读 SSH、catalog 重建 |
| 国际化 | zh-CN、en-US、zh-TW 回退；CJK/emoji/混合语言标题；24 小时时间格式 |

## Acceptance criteria

- [ ] 默认安装及升级后自动智能命名为关闭；浏览、索引和打开历史不会发起任何标题模型请求。
- [ ] 没有智能标题时，所有会话继续立即显示现有首条真实用户输入来源标题。
- [ ] 配置有效 provider/model 并启用后，仅启用后的新会话在满足触发条件时自动生成一次；重复 catalog/index/list 事件不重复请求。
- [ ] 模型请求只包含首条真实用户文本及固定标题指令，不包含工具、reasoning、系统注入、API Key 或完整会话。
- [ ] 智能标题成功后，展示优先级为 `alias > generated > source > session ID`；清除智能标题后回退来源标题并抑制该指纹的未来自动生成，只有显式手动生成可解除。
- [ ] 生成过程中手动保存别名、重新生成、删除会话或产生新 revision 后，旧结果无法写回或覆盖。
- [ ] 模型超时、限流、非法响应、provider 删除/禁用、active key 缺失或应用重启均保留来源/已有标题，不循环自动重试。
- [ ] 旧会话可以通过右键手动生成/重试/清除智能标题；手动别名始终保持最高优先级。
- [ ] Local、WSL、SSH、Worktree、父子会话使用稳定身份隔离；SSH 不发生远端写入。
- [ ] 新增数据通过 additive migration 保存于用户元数据数据库；重建 history catalog 不丢智能标题，删除会话会清理对应记录。
- [ ] 所有新文案在 zh-CN/en-US 生效并兼容 zh-TW；键盘和 aria 可操作；切换语言后时间仍为 24 小时制。
- [ ] 前端 `npx tsc --noEmit`、Rust `cargo check`、相关 Rust 单元测试和历史数据层回归测试通过。
- [ ] `CHANGELOG.md` 使用规划确认的目标版本并包含 `Refs #184`；`docs/功能清单.md` 同步更新。

## Out of scope

- 在 CLI-Manager 内引入 Ollama、ONNX 或内嵌本地推理运行时。
- 实现完整的通用 AI 辅助任务框架或把标题生成扩展为摘要、标签、向量检索。
- 自动批量处理启用前的全部旧会话。
- 修改第三方历史文件、Codex Desktop 云端标题或 cc-switch 数据库。
- 根据完整工具调用、reasoning 或多轮历史持续重命名。
- 将 Codex Cloud 的 `has_generated_title` 当作可复制的公开算法。

## Changelog target

- `V1.3.6`，条目使用 `Refs #184`。
