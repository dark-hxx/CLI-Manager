# 实施计划（已获用户授权）

状态：in_progress。2026-10-15 后续会话按用户要求启动；沿用已评审方案及 V1.4.4。验证结果以 verification.md 实施部分为准。

## 1. 实施前

- [x] 用户已评审下拉框方案与交互草图，并明确表示“可以开始”；新增 Esc 和弹层要求已补齐。
- [x] 用户指定 CHANGELOG 版本 V1.4.4；实现交付时同步更新功能清单 MCP 章节。
- [x] 本次启动核查 master 与 origin/master 为 0/0，仅本任务目录未跟踪；结果已告知用户。
- [x] 再检查分支、上游和工作区；读取 trellis-before-dev、相关架构/组件/类型/质量契约。
- [ ] 首批平台仅含平台模板，候选百智、魔搭、Smithery、Composio；逐项复核官方配置与授权路径，记录实际 CLI 验证矩阵。至少多个平台才算完成本期。
- [x] 使用 GitNexus 对将修改的每个已有函数运行 upstream impact 并报告范围；HIGH/CRITICAL 先告知。已调用 MCP；索引未找到或错配目标，已报告 UNKNOWN/异常风险并用契约及直接引用复核，见 research.md。
- [x] 明确旧契约“仅 JSON/禁止 basic form”按此次用户新需求更新；其余存储、脱敏与原生应用合同保留。

## 2. 按依赖实施

### A. 草稿与转换

- [x] 增加 typed draft、稳定 rowId、未编辑空行/显式空值区分、键冲突检测。
- [x] 实现单服务 snapshot ↔ draft ↔ resource 无损转换；保留未知字段、revision/source 和其他 CLI 扩展。
- [x] 增加 transport 草稿缓存和有效字段投影；不改变 Rust schema、IPC 或数据库。
- [x] 处理已脱敏值保留、替换、删除、改名需重新输入；不保存遮罩为新值。
- [x] 识别 JSON 重复键并在切换/保存前拒绝；无效 JSON 保留原文。

### B. 默认通用表单

- [x] 用现有 Mantine 控件实现命令/参数/env/cwd 与 URL/headers 分组。
- [x] 动态行新增删除、自然焦点、半填错误、键名提示；敏感值状态明确。
- [x] 建立名称补全本地候选、位置区分、IME/键盘/portal/重复候选处理。
- [x] 接入现有 Monaco，保持稳定 model，不在按键时来回序列化覆盖输入。

### C. 平台模板

- [x] 用 Mantine Select 实现“配置模板”下拉框，默认通用；顺序为通用、百智、魔搭、Smithery、Composio，复用现有主题和键盘行为，不增加搜索/清空按钮。
- [x] 静态模板数据 + 官方来源/复核日期 + zh/en 说明，不引入模板执行引擎。
- [x] 固定地址/用户专属地址/平台授权模式分别处理；占位符不可保存为有效配置。
- [x] 预填同一表单，保留自定义名称；跨模板清凭据；按最新反馈移除撤销按钮与快照。
- [x] 普通模式解除模板约束，保留现有可编辑内容；已存资源不随模板更新自动变化。
- [x] 无效 JSON 拒绝切换时保留原文和原选中项，避免选项与草稿不同步；模板缩短为 240px，与表单/JSON 同行。

### D. 集成、主题和文案

- [x] 沿用 validate → onBeforeSave → upsert；列表 CLI 选择、native preview/apply 保持原来职责。
- [x] 处理 blur/submit 错误、loading、防重入、关闭守卫和草稿保存生命周期。
- [x] 复用设置页已有 Esc 子层识别；编辑器所有关闭入口统一处理，菜单展开/关闭确认/保存中显式暂停底层关闭。保留标准 Combobox 目标 props，不仅依赖冒泡 stopPropagation。
- [x] 设置层 50 → 编辑器 80 → 局部菜单 85 → 确认 90；菜单 portal、flip/shift、焦点捕获与返回统一配置；确认前关闭局部菜单，防止默认 popover 300 遮住确认。
- [x] 固定头尾、唯一正文滚动、小窗口堆叠、候选浮层、主题 token、字号、reduced-motion。
- [x] 同步 extensions zh-CN/en-US；更新 owning spec、CHANGELOG 对应版本、功能清单 MCP 章节。

## 3. 定向验证

- [x] 增加真实转换/状态测试，不仅匹配源码字符串：往返保留、transport 缓存、JSON 错误、动态行空值、重复键、模板替换、脱敏改名。
- [x] 扩展现有 `scripts/extensionsJsonEditor.test.mjs`，把旧“不能有表单”的断言更新成用户新合同；不删除与元数据/密钥保护相关断言。
- [x] 新增 `scripts/extensionsMcpForm.test.mjs`、`scripts/extensionsMcpTemplates.test.mjs`（模板与转换测试最终合并在 extensionsMcpForm.test.mjs 的独立用例中）。
- [x] 运行相关既有测试：`node --test scripts/extensionsJsonEditor.test.mjs scripts/extensionsManagementUi.test.mjs scripts/extensionsMcpSaving.test.mjs scripts/extensionsImportSources.test.mjs scripts/extensionsI18n.test.mjs scripts/extensionsSettingsLayout.test.mjs`。
- [x] 运行 `node --test scripts/settingsEscape.browser.test.mjs`；使用脚本支持的 SETTINGS_TEST_PLAYWRIGHT/SETTINGS_TEST_BROWSER 环境变量定位已安装运行时，不为此新增产品依赖。
- [x] 在现有隔离浏览器夹具模式下补真实 MCP 编辑器用例：模板与补全菜单 → 编辑器 → 设置的连续独立 Esc，确认取消、saving、IME、Monaco 焦点、repeat、零/普通动画及重开。隔离 IPC/服务，只用示例值。
- [ ] 浏览器断言菜单可见且可点击、顶部和底部翻转、滚动跟随、确认覆盖关系、Tab/Shift+Tab 循环与关闭后焦点返回；不能仅匹配源码或断言 z-index 数字。
- [x] `npx tsc --noEmit`。
- [x] 独立运行 `npm run check:architecture -- --strict`。
- [x] UI 新增并集成后 `npm run build`；若 Rust 未改，不无差别启动全量 cargo test。
- [ ] 若必须更改 Rust validation/adapter，补对应模块定向测试与 cargo check，并更新发现清单。

## 4. 人工验收

- [ ] 在本 checkout 的桌面应用中切换中/英文及至少两种浅色/两种深色主题；时间仍为 24 小时制。
- [ ] 800×600、1280×800、150% 缩放/大字号：页脚可达、补全不被裁、长 URL/英文不撑宽。
- [ ] 所有功能用键盘可完成，IME Enter 不误选/提交，删除/新增后焦点合理。
- [ ] Esc 关闭 MCP 弹窗后设置仍可见；再次独立按 Esc 才进入设置关闭流程。展开候选时优先关闭候选；关闭确认和保存中不得连带关闭底层。
- [ ] 已存资源编辑与 JSON 往返；新 Key/原脱敏值/改名/删除分别核验。
- [ ] 分别验证 Claude/Codex/Grok 的支持路径；SSE 不支持目标不能显示已成功启用。
- [ ] 原生文件保存、部分失败、Home 切换与新会话加载/移除；模板选择本身不联网。
- [ ] 在有授权和测试账号的前提下验证各平台实际配置；记录未测的平台/CLI/运行环境，不把草图检查当服务兼容证明。

## 5. 回滚和交付

- [x] 新表单仅改变编辑入口，资源仍遵循原 schema；保留 JSON 编辑作为兼容路径。
- [ ] 高风险回归集中于 `mcpJsonEditor`、`McpEditorDialog` 的输入生命周期及 mask 保存；出现数据丢失时停止交付，回滚 UI 接线并保留原模型。
- [x] 不回滚用户已保存的资源/原生配置，不删除 native backups，不修改与本任务无关代码。
- [x] 提交前执行 gitnexus_detect_changes 或可用等价 CLI 检查实际影响范围；提交需用户明确授权。

本任务是一个完整编辑流程，当前不拆独立子任务；A → B → C → D 是显式实现依赖。
