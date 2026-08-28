# Issue #184 技术设计（草案）

## 1. 结论

不把小模型当作标题的唯一来源。自动命名采用可选增强层：现有来源标题永远是无损兜底，手动别名永远最高优先。原文精简先建立结构化消息分段契约，再做前端折叠；禁止只在前端用字符串特征硬猜所有来源。

建议拆成两个可独立验收的变更：

1. 保留“原文”，新增独立“对话”视图，并修复列表整行单击打开详情。
2. 可选的小模型标题生成。

实施顺序先 1 后 2。标题生成可直接复用“首轮对话正文”的分类结果，避免把工具输出、系统注入或 AGENTS 指令送去命名。

### 阶段闸门

- 当前只允许实施阶段 A：消息 parts 契约、“对话”页签、保留“原文”页签、搜索/跳转接线、列表整行单击修复。
- 阶段 A 禁止修改 `session_meta` 标题字段、`settingsStore` 自动命名设置、cc-switch 模型请求或任何标题生成逻辑。
- 阶段 A 通过自动化检查和用户验收后，必须回到规划阶段重新确认阶段 B；不得在同一次实现中顺手接入自动命名。

## 2. 数据流

### 2.1 原文视图

```text
本地/WSL/SSH 原始历史
  → 各来源 parser 识别结构块
  → HistoryMessage.content（兼容）+ HistoryMessage.parts（新契约）
  → historyStore 归一化
  → 详情默认进入 conversation，用户可切换现有 transcript
  → 相邻非正文 part 聚合为可展开详情区
```

建议新增：

```typescript
type HistoryMessagePartKind =
  | "text"
  | "tool_call"
  | "tool_result"
  | "reasoning"
  | "system"
  | "metadata"
  | "unknown";

interface HistoryMessagePart {
  kind: HistoryMessagePartKind;
  content: string;
  name?: string | null;
  call_id?: string | null;
}

interface HistoryMessage {
  // 现有字段保留
  parts?: HistoryMessagePart[];
}
```

`content` 继续服务搜索、编辑、Diff、转换和旧快照。`parts` 只增加信息，不在第一步删除旧字段。混合 Claude assistant 行可同时包含 `text` 与 `tool_call`；Codex reasoning/tool response 不再被迫伪装成一条普通 assistant 文本。

### 2.2 自动标题（阶段 B 后置设计，阶段 A 不实施）

```text
历史列表刷新
  → 找到 created_at >= enabledAt 且首轮正文完整的候选会话
  → 检查 alias / generatedTitle / generationState
  → 单队列调用 history_generate_title(sessionRef, providerRef)
  → Rust 从 cc-switch 只读加载真实配置和密钥
  → 发送首轮正文并校验短标题
  → 前端写 session_meta 的 generated title 状态
  → displayTitle = alias || generatedTitle || sourceTitle || sessionId
```

自动触发绑定历史索引而不是 Hook。代价是应用未打开历史工作区时不会“秒级”命名，但下一次历史刷新会自动补做；换来 Local/WSL/SSH、Hook 未安装和不同 CLI 来源的一致语义。V1 不为“立刻命名”引入常驻后台调度器。

## 3. 持久化（仅阶段 B，阶段 A 不实施）

扩展 `session_meta`，建议字段：

- `generated_title TEXT NOT NULL DEFAULT ''`
- `title_generation_state TEXT NOT NULL DEFAULT 'idle'`
- `title_generation_basis TEXT NOT NULL DEFAULT ''`
- `title_generation_error TEXT NOT NULL DEFAULT ''`
- `title_generated_at TEXT`

`title_generation_basis` 保存首轮正文的稳定哈希，不保存额外原文；同一哈希失败后不再自动重试。手动重试显式重置状态。设置存储新增：

- `historyAutoTitleEnabled: boolean`，默认 `false`
- `historyAutoTitleEnabledAt: number | null`
- `historyTitleProviderAppType: "claude" | "codex" | null`
- `historyTitleProviderId: string | null`

## 4. 模型调用边界（仅阶段 B，阶段 A 不实施）

- 前端只提交 cc-switch DB 路径、app type、provider id 和稳定 session ref；不读取、不缓存、不传递 API key。
- Rust 校验 provider 仍存在并从 `settings_config` 解析 base URL、token、model 和 wire API。
- V1 只支持已有真实请求链路覆盖的 Claude 与 Codex provider。其他 app type 明确返回 `unsupported_app_type`。
- 请求内容只含首轮用户正文和首轮助手正文，分别设长度上限；不含 cwd、文件路径、工具 payload、system prompt、thinking。
- 单次请求、固定超时、低输出上限、temperature 取 0 或供应商支持的最低值；不做协议 fallback，不自动重试。
- 响应取首个非空文本，移除 Markdown 标题符、引号和换行，限制为 40 个 Unicode 字符；空白、模板套话或超限无法清洗时视为失败。
- 自动失败只更新状态；手动操作才显示 toast。日志记录错误码、耗时、HTTP 状态，不记录密钥和会话正文。

## 5. 视图与折叠交互

- 新增顶层 `conversation` 页签并放在现有 `transcript` 前面；每次切换会话默认进入 `conversation`。
- `conversation`：`text` part 展开；其他 part 按连续区段折叠，摘要示例为“3 次工具调用 · 2 个工具结果 · 1 段思考”。
- 现有 `transcript`（原文）：继续渲染当前完整消息序列，保留长内容折叠和消息编辑操作；不再承担“精简模式”设置。
- 现有 Tools Tab 保留，它负责结构化诊断；原文详情区负责保留时间顺序，职责不重复。
- 搜索索引仍基于完整 `content`。命中隐藏 part 时将该区段临时强制展开。
- `message_index` 仍以现有消息数组为准，parts 不改变索引；Diff/时间线/工具跳转无需迁移坐标。
- 老快照没有 parts 时，以 `role` 做保守兼容，不阻断显示。

## 6. 兼容与回滚

- 只增加可选字段和 SQLite 默认列，不改变现有 IPC 必填字段。
- 关闭自动命名立即回到 `alias || sourceTitle`；已生成标题保留但不再用于展示，重新开启可恢复。
- 切到现有“原文”页签即可恢复当前视觉行为。
- 数据库迁移失败必须阻止新功能启用，但不得阻止历史列表使用旧字段。

## 7. 发现清单与影响

| 触点 | 作用 | GitNexus 影响 |
|---|---|---|
| `src-tauri/src/commands/history.rs` | 本地/WSL parser、HistoryMessage、标题资格 | `HistoryMessage` MEDIUM：4 个直接、42 个总影响；`parse_message` MEDIUM：8 个直接、46 个总影响 |
| `src-tauri/history-core/src/lib.rs` | SSH 结构化 parts 与相同分类语义 | 必须同步，否则远端与本地分叉 |
| `src/lib/types.ts` | TS IPC 类型 | 新字段必须保持 optional 兼容旧快照 |
| `src/stores/historyStore.ts` | meta schema、标题优先级、生成队列 | `toView` LOW：2 个直接、9 个总影响，影响列表加载流程 |
| `src/components/history/SessionDetailPane.tsx` | 对话/完整模式、折叠与跳转 | `HistoryMessageCard` LOW：1 个直接、2 个总影响 |
| `src/components/history/HistoryListPane.tsx` | 会话卡片整行点击与操作按钮事件隔离 | 当前外层卡片非选择模式无点击处理，只有内部正文按钮可打开，属于点击命中区域错误 |
| `src/components/HistoryWorkspace.tsx` | 搜索、分页、跳转和模式状态接线 | 需保持 message index 不变 |
| `src-tauri/src/commands/ccswitch.rs` | 后端读取供应商与协议适配 | 复用真实配置解析；不向前端暴露密钥 |
| `src-tauri/src/commands/command_suggestion.rs` | 现有共享 HTTP/响应解析候选 | 只抽最小共享能力，禁止让标题逻辑依赖“命令清洗” |
| `src/components/settings/pages/HistorySourceSettingsPage.tsx` | 自动命名开关、供应商选择、隐私/费用说明 | 产品设置入口 |
| `src/stores/settingsStore.ts`、`src/lib/i18n.ts` | 设置持久化与多语言 | 需覆盖三种现有语言行为 |
| `src-tauri/src/lib.rs` | command 注册与 SQLite migration | 只增量注册/迁移 |

没有触及 PTY、终端分屏、项目 CRUD、原始历史写回和供应商切换；这些触点确认无关。

## 8. 主要风险

- 最大风险不是模型失败，而是错误分类把正文隐藏。解决方式是 parts 显式分类、unknown 保守兼容、搜索强制展开和 Local/SSH 同契约测试。
- 自动触发若不限制启用时间会造成旧会话批量计费。必须持久化 `enabledAt`。
- 模型异步返回与手动别名存在竞态。展示优先级必须在单一 `toView` 入口决定。
- cc-switch provider 可被删除或改协议。每次请求都以只读 DB 当前配置为准，失败无损回退。
- 标题请求会发送会话正文到外部供应商。默认关闭并在开关旁明确披露。

## 9. 列表重复点击根因

根因位于列表组件的事件边界，不在后端或详情请求：

- 外层视觉卡片包含 padding、留白、树形缩进和操作区，但非批量模式下没有 `onClick`。
- 只有内部 `flex-1` 正文按钮调用 `onOpenSession`，点到视觉卡片的其他区域没有任何效果。
- 有效点击发生后，Store 会立刻设置 `activeSessionKey/loadingSessionDetail`，并以 `sessionDetailRequestSeq` 保证最后一次请求获胜。

修复方式：把打开行为绑定到外层卡片；内部树展开、删除及其他操作按钮统一 `stopPropagation`。正文不再嵌套第二个打开按钮，改为语义可聚焦的整行按钮或等效键盘交互，避免嵌套交互元素。

## 10. 阶段 B 待确认决策

阶段 A 验收完成后再决定是否采用“默认关闭的小模型增强层”。该决策不阻塞阶段 A，且阶段 A 不得提前创建阶段 B 的数据结构或空壳接口。
