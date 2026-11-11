# 设计证据与边界

核查日期：2026-10-15。代码基线：`4fbd7c03`。

## 已执行

- 用户授权先拉代码；原工作区干净，master 与本地 origin/master 0/0。
- `git pull --ff-only` 成功：677338c5 → 4fbd7c03。随后 status 干净、上游 0/0。
- `.codegraph/` 不存在；本会话无 GitNexus MCP 工具。通过 owning contract 与定向源码阅读定位，不声称做过图谱 impact。
- 已读取 trellis-start（本会话前文）、trellis-brainstorm、ui-ux-pro-max、gitnexus-exploring；用 UI 技能搜索表单、焦点、键盘、校验、稳定列表 key。
- UI 技能泛化生成的 landing/大色块方案不适合现有桌面设置页；只采用焦点、就地校验、无布局位移和语义控件原则，项目主题优先。
- 用户已同意创建任务，并确认第一版只做平台模板。memory/fetch 截图只作为动态行交互参考。

## 代码发现清单

| 文件与位置 | 事实 / 决策 |
|---|---|
| `src/features/extensions/components/McpEditorDialog.tsx:14,22,50,74` | 单资源会话快照，JSON-only，保存先 Rust validate、onBeforeSave、upsert；底部固定。保留保存与生命周期，替换默认编辑视图。 |
| `src/features/extensions/lib/mcpJsonEditor.ts:24,36` | 单服务 mcpServers；parse 保留原身份、source、其他 CLI extensions；新资源 CLI 默认全 false。重点无损转换边界。 |
| `src/features/extensions/components/GlobalMcpPanel.tsx:149,232` | 原生保存属于列表按钮；编辑器的 onBeforeSave/onSaved 接回现有状态。无需把 CLI 开关复制进新表单。 |
| `src/shared/types/extensions.ts:1,7,25,46` | 仅 claude/codex/grok；stdio/sse/streamableHttp；资源有 env/headers/secretRefs/timeout/perCliExtensions。不能根据截图扩充支持列表。 |
| `src-tauri/src/features/extensions/model.rs:257,293,342` | Rust 校验和脱敏是权威；stdio 禁 url/headers；网络禁 command/args/cwd。保持后端边界。 |
| `.trellis/spec/backend/extensions-management-contracts.md:23,40,43,46,47` | Home/投影/原生保存、pending、单服务和 Monaco 契约。第46行“禁止 basic form”由本轮明确用户需求取代；其余保持。 |
| `src/shared/ui/MantineThemeProvider.tsx:15,27,75` | 多种浅/深配色，cliPrimary、用户字体字号、统一 radius。复用而非固定橙色。 |
| `src/styles/themes.css:299` | surface、text、primary、interaction 等主题 token 已有映射。新特有样式跟随。 |
| `.trellis/spec/frontend/component-guidelines.md:1248,2000` | 设置页面 Mantine；浅色选中依赖文字/边缘/表面多重区分。 |
| `src/features/settings/components/providers/providerModelCandidates.ts:113` | 已有允许自由文本的 Autocomplete 设计模式；可借鉴模式，避免跨功能导入内部 UI。 |
| `.trellis/spec/frontend/quality-guidelines.md:246` | 产品桌面 UI 由人工验收，AI 不启动 CLI-Manager/Tauri 做验收。草图单独检查不代替它。 |

无关边界：不改 PTY、Hook、终端分屏、项目持久化、数据库迁移、provider Home 解析、WebDAV 或远端平台账号管理。

## 用户授权及 Esc / 层级补充核查

- 用户已明确授权开始实现，并指定 V1.4.4；当前会话工作流仍限定 planning，记录授权而非重复申请评审。当前分支检查 master / origin/master 0/0，仅本任务目录未跟踪。
- `SettingsModal.tsx:248,317`：已有 hasOverlayAboveSettings，检查 composedPath 与可见 dialog/alertdialog，过滤隐藏 keepMounted；document 冒泡监听忽略 defaultPrevented 和 IME。当前不能断言“已有一次 Esc 连关两层”的缺陷，新增表单必须保护这条现有链路。
- `McpEditorDialog.tsx:74`：Mantine Modal zIndex=80；saving 禁止 Escape/遮罩/关闭按钮。`SettingsModal.tsx:365` 设置层为 50，`mcpSaving.tsx:110` 离开确认为 90。
- 已安装依赖 `node_modules/@mantine/core/esm/components/ModalBase/use-modal.mjs:14`：window 捕获监听先于字段事件，按目标 data-mantine-stop-propagation 决定是否关闭。`Combobox/use-combobox-target-props/use-combobox-target-props.mjs:57`：菜单展开时标准目标自动提供该标记；应保留默认接线，不能仅在冒泡时补阻止事件。
- 已安装 Mantine 默认 popover zIndex=300，见 `core/utils/get-default-z-index/get-default-z-index.mjs`；本项目编辑器/确认层为 80/90，局部菜单需显式处于二者之间，确认前关闭菜单，避免菜单盖住确认。
- `useFocusTrap.ts:20`：设置背景挂 document Tab 监听；新编辑器继续使用 Mantine 自身 trap/return-focus，需要覆盖父子焦点循环的实际行为。
- `scripts/settingsEscape.browser.test.mjs:105` 及 `scripts/fixtures/settingsEscapePage.tsx`：已有真实设置外壳/Mantine 隔离测试，涵盖普通与零时长关闭、隐藏抽屉、IME、消费事件。现夹具未覆盖 MCP 模板/候选/关闭确认链；实施时补场景，不能把已有用例当新增 UI 已验收。
- 本次为代码只读核查与规划补充，未执行符号修改、GitNexus impact 或产品浏览器回归；无已复现缺陷的根因声明。

## 平台官方资料

- [百智固定版本文档](https://github.com/chaitin/baizhi-agent-toolkit/blob/a643da3396721375132005f71227ff0f24d823b6/readme.md)：固定 Streamable HTTP 地址、自己的 Bearer Key，配置仓不含托管后端。
- [Smithery Connect](https://smithery.ai/docs/use/connect)：连接所需字段由服务 schema 决定；namespace MCP endpoint 可聚合连接，支持 OAuth；REST 管理入口不是 MCP 服务地址。
- [Composio Connect](https://docs.composio.dev/docs/composio-connect)：公开统一 Connect MCP 入口，按应用进行授权；不能假定只有 API Key 一种模式。
- [魔搭官方 MCP 教程](https://github.com/modelscope/ms-cookbook/blob/main/content/chapters/chapter-27.md)：MCP 广场中服务页面提供各自连接配置，云托管与自部署不同。按用户选定服务给出的真实 URL/transport 配置。
- [issue #281](https://github.com/dark-hxx/CLI-Manager/issues/281)：原提案只要求百智入口；本任务已按用户要求扩为通用表单和多平台模板。

官方文档证明接入形式，不证明 CLI-Manager 已验证兼容。正式模板必须在实现阶段记录支持的 CLI、授权步骤、日期与具体条件；不把站点宣传、免 Key 或免费额度作为统一承诺。

## 交互草图边界

用户评审补充：模板入口使用下拉框，默认通用，选项为通用、百智、魔搭、Smithery、Composio；不沿用 cc-switch 截图中的横排模板按钮。已同步 PRD、设计和实施计划。

交互草图只演示默认表单、平台预填、动态行、名称补全、JSON 切换和主题。没有真实服务请求、原生配置写入或持久化密钥。仅使用示例值。

用户已评审并授权实现，版本已明确 V1.4.4。进入实施阶段后按此更新 CHANGELOG 与功能清单；本轮规划文档不宣布功能已完成。

## 实施补充（2026-10-15）

- 已运行 task.py start；本轮为 inline 实现，没有派发子代理。
- CodeGraph 目录不存在。GitNexus query 报 FTS 缺失；对 McpEditorDialog、McpEditorSession、mcpEditorJson、parseMcpEditorJson、save、handleChange 运行 upstream impact 均未找到。对 isolatedSettings 未限定文件时返回 CRITICAL 但指向 Rust/PTY 无关符号，限定 scripts/settingsEscape.browser.test.mjs 后未找到。已告知用户，未把异常索引当可靠风险结论。
- 使用契约和直接引用核查：GlobalMcpPanel → McpEditorDialog → draft/JSON → validate → onBeforeSave → upsert；列表 CLI 选择及 native apply 只做回归，未修改。新增草稿、模板、补全、行组件均位于 extensions 内。SettingsModal 仅增加 Esc repeat 过滤，直接调用入口为 App 的延迟加载设置层。
- 明确无关：Rust/model/原生适配、数据库、IPC、PTY、Hook、WSL Home、Worktree 策略、WebDAV 均未修改。既有导入、保存、布局测试覆盖不变边界。
- 官方来源再次联网复核：百智固定版本 readme 的 Streamable HTTP URL 与 Bearer；魔搭教程的逐服务 URL；Smithery Connect 的 namespace MCP URL 与 OAuth；Composio Connect 的共享 MCP URL 与应用授权。无真实账号/密钥/平台工具调用，无 Claude/Codex/Grok 实际联通结论。
- Monaco 0.55.1 随包的 jsonc-parser main.js 未导出 parseTree；使用随包 impl/parser.js 的 visit 事件，不增加依赖。JSON.parse 先验证严格 JSON，visitor 再拒绝每个对象中的重复属性（包括 unicode 转义与数组内对象）。新增窄类型声明和实际打包执行测试防止导出漂移。

## Bug Analysis: Esc 菜单与设置的分层归属

### 1. Root Cause Category
- D/E（测试覆盖缺口、隐含假设）：Combobox 的 Escape 关闭不 preventDefault，不能假定所有子控件都会消费事件；SettingsModal 仅判断当前可见子层，没有区分一次独立按键与长按 repeat。
- 根因陈述：关闭归属位于 DOM 键盘事件与弹层生命周期边界，编辑器读取本次目标的菜单展开标记，设置入口过滤 repeat，才能在同步卸载后仍保持一次按键只作用一层。

### 2. Why Fixes Failed
- 只改为编辑器局部冒泡监听仍不足：Combobox 不阻止默认，菜单关闭与编辑器关闭发生于同次事件；真实菜单测试暴露。
- 旧夹具只等待 hidden，下一次键盘事件可能来自焦点尚未返回的退出动画输入框。改为等待真实焦点返回，未削弱关闭断言。

### 3. Prevention Mechanisms
| Priority | Mechanism | Specific Action | Status |
| --- | --- | --- | --- |
| P0 | 交互回归 | 真实 SettingsModal/Mantine/MCP/Monaco 隔离夹具，菜单→确认→编辑器→设置、repeat/IME、保存锁定 | 已加入 |
| P0 | 入口约束 | 设置监听忽略 repeat；编辑器局部处理并尊重菜单标记 | 已实现 |
| P1 | 契约 | hook-guidelines 与 extensions-management-contracts 记录消费行为与层级 | 已更新 |

### 4. Systematic Expansion
- 检查普通/零时长关闭、重新打开、保存中、确认取消、JSON 焦点、窄窗口；不扩改其他业务弹层。
- 窗口焦点/分屏/Workspan/WSL/Worktree/Hook 不影响全局表单数据链，原生运行仍列为人工验收。

### 5. Knowledge Capture
- 已更新 frontend/hook-guidelines.md 与 backend/extensions-management-contracts.md；浏览器夹具及数据测试保留回归。

### Monaco 快速切换回归补充

真实 Monaco 快速 JSON→表单测试产生 Canceled pageerror，堆栈为 Delayer.cancel → Delayer.dispose → WordHighlighter dispose / Emitter。源码 wordHighlighter.js 的 50ms runDelayer.trigger 未接取消 rejection。仅在本编辑器设置 occurrencesHighlight=off，避免该不需要的词引用高亮调度；不吞全局错误、不改 node_modules、不关闭 JSON 校验或折叠。使用零 pageerror 断言回归，最终结果见 verification.md。

### 用户截图反馈：聚焦候选与表单视觉

- 根因：动态行增删用 requestAnimationFrame 聚焦名称框，Mantine Autocomplete 默认 openOnFocus 同时展开菜单；Tab 与校验定位也经过相同焦点路径。应在控件入口区分聚焦与主动请求候选，不删除增删行的焦点恢复。
- 发现清单：环境变量仅有三个代理候选，请求头仅有四项，slice(0, 6) 还会截断扩充后的数据；表单全宽纵排和底部添加按钮增加滚动，输入/菜单缺少 feature 内统一视觉层次。
- 修复：openOnFocus=false，保留原生 click/change/ArrowDown；扩充本地名称候选，208px 菜单内滚动；名称/传输响应式并排，动态行分组及标题旁添加按钮，主题变量控制边框、焦点、删除按钮、菜单与圆角。不改用户字体。
- 影响分析：McpKeyValueRows、McpArgumentRows、McpConfigForm、McpEditorSession、mcpFieldSuggestions 的 GitNexus impact 均未找到符号，风险 UNKNOWN；按直接组件引用核对，范围在 MCP 编辑器，无 Rust、IPC、持久化或原生配置改动。
- 预防：真实 Mantine 浏览器用例验证新增/Tab/删除聚焦保持菜单关闭，主动点击/输入/方向键仍可选候选，浅深主题及中英文、520px 窄窗口均覆盖；名称候选单元测试防止只保留前六条。

### 名称候选范围再次澄清

- 用户指出仍缺 Authorization。根因是旧 R4/AC4 将请求头名称排除在 env 候选外，前次仅扩充各自列表，未满足用户在环境变量框查找这些名称的预期；不是过滤大小写或菜单限高问题。
- 按本轮要求更新 R4/AC4、设计和契约：env 提供 22 个常用变量名和共享的 19 个请求头风格名称；headers 使用同一份 19 项列表。只共享建议，不改变保存区域、重复校验大小写规则或敏感值遮罩。
- GitNexus mcpFieldSuggestions impact 仍返回 Target not found / UNKNOWN；既有直接调用仅为 McpKeyValueRows。改动局限静态候选与测试，不变更组件生命周期、IPC 或持久化协议。
- 浏览器回归在浅色英文/深色中文的环境变量行输入 au、点击 Authorization；数据测试覆盖 env/header 使用同一候选、排除已用名、env 大小写语义与保存位置，避免以后重新按类型过滤掉用户所需名称。

### 顶部布局收紧与删除撤销

- 用户最新截图明确要求删除“撤销模板替换”，缩短模板下拉框并与表单/JSON 同行；覆盖原有模板撤销及全宽下拉设计。
- 移除编辑器 undo state、快照赋值、按钮及双语翻译；关闭确认不再提模板撤销历史。跨模板凭据清除、JSON 解析失败阻止替换、未保存关闭保护保留。
- 顶部采用可换行 flex 工具栏，表单/JSON 左侧、240px 模板右侧，平台说明位于其下。小窗口空间不足自然换行，编辑既有资源仍不显示模板。
- McpEditorSession 的 upstream impact 返回 Target not found / UNKNOWN；按直接引用核对仅涉及 MCP 编辑器。浏览器增加同一行/宽度断言及应用模板后无撤销按钮检查，原有 Esc/焦点/JSON 回归继续执行。
