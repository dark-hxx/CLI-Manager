# 设计阶段验证

日期：2026-10-15。用户已授权实施并指定 V1.4.4；按当前会话工作流，任务状态保持 planning。

## 交付范围

- `prd.md`：已收敛为目标、背景、需求、可验收标准、范围外和技术约束，删除临时待细化项。
- `design.md`：布局、主题、模板、动态行、补全、草稿/JSON、脱敏、保存和场景矩阵。
- `implement.md`：明确依赖、定向验证、人工验收和回滚，等待用户评审后实施。
- `research.md`：代码触点、平台官方来源、已执行 Git 操作和证据边界。
- `work/mcp-form-preview.html`：用于对话中评审的独立交互草图，非产品组件。

## 草图检查

用已安装的 Python Playwright 和无头 Microsoft Edge 打开本地 standalone 包装，仅检查草图，没有启动 CLI-Manager/Tauri。

通过的交互检查：

1. 环境变量输入 `ht` → ArrowDown → Enter，填入 HTTP_PROXY。
2. 参数写入 JSON，JSON 添加自定义嵌套字段后往返保留。
3. 无效 JSON 阻止切换且保持原文。
4. 平台模板预填正确示例地址，保留自定义名称，撤销恢复旧草稿。
5. stdio → HTTP → stdio 恢复命令。
6. HTTP 请求头输入 `au` 出现 Authorization，键盘选择生效。
7. 360px 视口无横向溢出。
8. 运行时 JavaScript 错误：0。

已查看 light/dark/narrow 截图；深色截图等待主题过渡结束后重新捕获，避免把过渡中颜色当最终样式。

## 评审修订：模板下拉框

按用户要求将横排模板按钮改为“配置模板”下拉框，并同步需求、设计和实施计划。独立草图使用原生 select 演示，正式产品使用现有 Mantine Select。

重新生成 standalone 后，通过无头 Edge 定向检查：默认通用及五个选项顺序、平台预填、跨平台清除旧凭据、撤销同步恢复选中项和内容、切回通用保留内容、无效 JSON 阻止切换并恢复选中项、方向键选项切换。运行时 JavaScript 错误为 0。

已查看 `template-dropdown-light.png`、`template-dropdown-dark.png`、`template-dropdown-narrow.png`；浅深主题显示正常，360px 视口无横向溢出。此轮没有修改产品代码。

## 未宣称完成的事项

- 没有修改 src/、src-tauri/、package.json 或既有业务规范。没有运行无关全量编译/产品测试。
- 草图使用示例值，不读写真实 CLI 配置、不保存用户密钥、不连接平台。
- 草图不覆盖真实 Monaco、Rust 密钥恢复、完整 JSON 重复键校验、真正 Modal 内滚动/portal、完整双语与全部主题；这些均列入实施计划和人工验收。
- 产品代码与真实服务兼容性尚未实现/验证，CHANGELOG 和功能清单不在设计阶段宣称功能完成。实现交付使用用户已指定的 V1.4.4。
- 没有运行 task.py start，没有提交或推送。

## 实施前核查补充

用户补充 Esc/浮层要求后，已只读核查设置 Esc 归属、MCP Modal 层级、Mantine 捕获监听与 Combobox 保护、焦点陷阱和已有隔离浏览器用例。结果记录于 research.md；对应要求 R8/R9、验收 AC8/AC9 和执行清单已补齐。此轮没有新增或运行产品测试，也没有更新草图；不将源码核查当作真实界面验收。


## 实施验证（2026-10-15，当前会话）

状态：代码实现完成，自动验证通过；任务保持 in_progress，等待桌面及真实平台人工验收。未提交、未推送、未启动 Tauri/CLI-Manager 服务、未写入真实 CLI 配置。

### 已实现

- 默认通用表单及 stdio/HTTP/SSE 字段；动态参数/env/headers、名称建议、显式空值、行身份与焦点处理。
- 通用/百智/魔搭/Smithery/Composio 下拉框、官方接入说明、模板清凭据与内存撤销。
- JSON/form 转换、独立 transport 缓存、未知字段/元数据保留、重复属性与脱敏路径保护。
- 保存沿用 validate → onBeforeSave → upsert；关闭确认、saving 同步锁、菜单/编辑器/确认/设置的 Esc 归属与焦点返回。
- 中英文文案、局部主题样式、固定页脚及窄窗口布局。同步 V1.4.4 CHANGELOG、功能清单与两份 owning spec。

### 自动验证证据

| 检查 | 结果 | 证明范围 |
| --- | --- | --- |
| extensionsMcpForm + extensionsJsonEditor + extensionsManagementUi + extensionsMcpSaving + extensionsImportSources + extensionsI18n + extensionsSettingsLayout | 41/41 通过 | 实际草稿/解析/模板模块、既有保存/导入/布局合同与双语完整性 |
| node --test scripts/settingsEscape.browser.test.mjs | 9/9 通过（父测试 + 8 子组），pageerror 为空 | 真实 SettingsModal、Mantine、MCP 编辑器及 Monaco；IPC 隔离 |
| npx tsc --noEmit | 通过 | TypeScript 类型 |
| npm run check:architecture -- --strict | 1330 个源文件，0 超 2000 行，0 新违规 | 文件长度与导入边界 |
| npm run build | 已通过；最终复核记录见本节后续补充和 work/build.log | 前端生产打包，不等同桌面验收 |
| git diff --check | 通过 | 空白/补丁格式；仅已有 Windows LF→CRLF 提示 |
| GitNexus detect_changes(scope=all) | 返回 low，12 个 tracked 文件、1 个测试符号，无关联流程 | 索引对业务符号缺失，不能覆盖未跟踪新文件；已人工逐文件复核 |

浏览器覆盖：普通/零时长关闭；模板菜单先关、确认取消、丢弃后焦点回触发按钮；repeat 不穿透、IME 不关闭；800×600 深色候选实际点击命中、方向键/Enter/Escape、Tab 循环、无整页横向溢出；saving 锁；真实 Monaco 无效 JSON/重复属性阻止切换和模板替换；保存失败保留草稿，成功保留空参数和未知字段。既有设置层中英文及浅深模式用例保留。

### 已知验证边界与人工步骤

1. 使用本 checkout 构建的桌面应用进入“设置 → MCP & Skills → 添加 MCP”，在中/英文及 warm-paper、apple-pure、night-indigo、github-dark 下操作；确认时间仍为 24 小时制。浏览器夹具使用 Mantine 浅深主题，不代表全部应用主题预设已人工验证。
2. 800×600、1280×800、150% 缩放/大字号：增加多行，检查页脚可达、菜单边缘翻转、正文滚动跟随、Tab/Shift+Tab、增删行焦点和弹层遮挡。
3. 编辑已保存资源，对未改脱敏值、显式替换/删除、改名重填、JSON 往返逐项核验；验证原生保存的 Home 变化、部分失败与新会话加载。自动测试未读写真实用户配置。
4. 窗口失焦、最小化/托盘、分屏/Workspan、WSL/Worktree、Hook 装/未装下确认草稿保持与现有应用边界。
5. 使用有授权的账号在 Claude/Codex/Grok 实际验证平台与对应 transport；SSE 不兼容仍应由既有能力校验拒绝。

| 平台 | 官方配置契约复核 | 本次实现 | 实际账号/CLI 联通 |
| --- | --- | --- | --- |
| 百智 | 固定 HTTP 地址 + 自己的 Bearer Key | URL 预填，Authorization 必填 | 未测 |
| 魔搭 | 逐服务给定地址/transport/鉴权 | 空 URL 待填写，方式可切换 | 未测 |
| Smithery | namespace MCP endpoint + OAuth/连接配置 | URL 占位提示与授权说明 | 未测 |
| Composio | Connect MCP URL + 按需应用授权 | 固定 URL 与授权说明 | 未测 |

这些未测项不记录为兼容性通过，不以浏览器夹具或原独立草图代替桌面/平台验收。


### 最终复核补充

- 生产构建再次通过，work/build.log 已保存结果（Vite 既有 WorktreeFinishDialog 静态/动态混用及大 chunk 提示保留，无构建错误）。
- 补充空白新建直接切换 JSON 的往返用例；不要求先填写临时名称，未改原文可返回未完成表单。该最后一项由新的类型检查与真实组件浏览器构建/回归覆盖。
- 不运行 cargo test：本次未修改 Rust、数据库或 IPC；不启动桌面应用做自动验收。

### 截图反馈修正复核（2026-10-15）

- 新增/删除行、Tab 聚焦不自动展开候选；点击、输入、方向键仍可展开。候选扩充并支持滚动，环境变量和请求头保持独立。样式和响应式分组按用户反馈调整。
- 41/41 定向测试通过；浏览器 10/10 通过（父测试 + 9 子组），pageerror 为空。新增真实 Mantine 用例覆盖浅色英文 1200×800 与深色中文 520×800，候选点击选择、过滤、Esc、键盘展开及增删/Tab 聚焦；截图 work/mcp-form-light.png、work/mcp-form-dark.png 已检查，无横向溢出。
- npx tsc --noEmit、strict 架构检查（1330 源文件、0 违规）、git diff --check 通过。桌面主题、实际平台联通与用户字体仍保留前述人工验收边界，截图来自隔离浏览器夹具。
- 本轮生产构建通过（Vite 1m57s），完整输出更新至 work/build.log；保留既有大 chunk 与 WorktreeFinishDialog 静态/动态导入提示。

### Authorization 候选反馈复核（2026-10-15）

- 后续反馈覆盖旧候选分类要求：环境变量和请求头仍保存到各自字段，但环境变量候选也包含 Authorization 等请求头风格名称。更新 PRD、设计、契约及 V1.4.4 交付记录。
- `extensionsMcpForm.test.mjs` 7/7 通过；真实组件浏览器 10/10 通过，包含 env 中输入 au 并选择 Authorization，pageerror 为空。
- TypeScript、strict 架构（1330 源文件、0 违规）、git diff --check 通过。本轮仅候选数据扩充，浏览器夹具重新构建；未重复全量生产打包或启动桌面，人工验收边界不变。

### 顶部工具栏反馈复核（2026-10-15）

- 删除模板撤销按钮、state 和快照，双语关闭确认同步清理撤销历史说明。240px 模板下拉框与表单/JSON 并排，空间不足时换行。
- 表单数据/双语测试 9/9，浏览器 10/10；实际 bounding box 验证模板宽度与同行对齐，应用模板后无撤销按钮。Esc、菜单、未保存确认、JSON 切换和候选回归均通过，无 pageerror。
- TypeScript、strict 架构（1330 文件、0 违规）及 diff --check 通过。浅色英文与深色中文截图已重新生成并检查；未启动桌面，未重复全量生产构建。

### 提交记录（2026-10-15）

- 用户明确授权关联 issue 并进行代码提交。核对任务来源与公开 issue #281 标题/内容一致，提交使用 Refs #281；不推送、不自动关闭 issue，人工验收未完成的 task 保持 in_progress。
- 提交范围包含本任务实现、回归测试、双语文案、架构契约、V1.4.4 变更记录及任务设计/验证资料；构建日志由既有 ignore 规则排除。
