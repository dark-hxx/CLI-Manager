# 08-02-key 验收收尾清单

更新时间：2026-08-04
任务性质：只做验收、缺陷修复和发布收尾，不再扩展需求。
CHANGELOG Target：[TEMP]（用户尚未提供正式版本号）

## 一、执行规则

- 本清单是新会话的唯一工作入口；先读本文件，再读 HANDOFF.md、acceptance.md、implement.md、prd.md、design.md。
- 当前实现主体已经完成，禁止从头重写或做无关重构。
- 每项必须记录：PASS、FAIL 或 BLOCKED，并附命令、截图、日志或复现步骤。
- 发现代码缺陷时，先说明根因；修改函数、类或方法前运行 GitNexus upstream impact。HIGH/CRITICAL 必须先人工复核影响面。
- 修复后先跑相关测试，再跑完整质量门禁；不要用“代码看起来没问题”替代验收证据。
- 不修改或回退用户已有的 AGENTS.md、CLAUDE.md 变更；不执行 git reset --hard、git checkout --、提交或推送。
- 未得到用户明确要求，不运行 npm run dev、npm run build、npm run tauri dev、npm run tauri build。
- WSL 不可用时，把相关项目标记为 BLOCKED（环境限制），不要伪造通过。

## 二、执行基线

- 历史自动检查结果只作参考；新会话必须重新执行 TypeScript、Rust 格式/编译/测试、diff check 和 i18n parity。
- WSL、真实 UI、真实 Home 文件写入等场景不能用历史自动测试结果替代人工证据。

## 三、验收清单

### 0. 环境与工作树

- [ ] 当前目录为 F:\github\CLI-Manager，分支为 feat/native-provider-management。
- [ ] git status --short 已记录；没有误改、误删或无关生成文件。
- [ ] AGENTS.md、CLAUDE.md 的用户修改未被覆盖。
- [ ] WSL 可用性已记录；不可用则登记 WSL 项目为 BLOCKED。
- [ ] 未运行 dev/build 命令。

### 1. Gate 2：供应商维护编辑器

- [ ] 供应商列表具备 Claude、Codex、Grok 三个类型 Tab、当前供应商区域、搜索、拖拽排序、卡片、导入、环境诊断、新增入口。
- [ ] 卡片显示 API URL、模型、Key 状态，并能区分当前供应商。
- [ ] 编辑器先展示请求地址、当前 Key/Key 管理、模型选择，再展示高级配置和原始文档。
- [ ] Claude 的 API 格式是下拉框；认证字段是下拉框，至少验证 ANTHROPIC_AUTH_TOKEN 与 ANTHROPIC_API_KEY。
- [ ] Claude 支持完整 URL 偏好、Sonnet/Opus/Fable/Haiku/Subagent 五类模型映射、显示名称、实际请求模型、1M 标记、默认兜底模型、一键设置。
- [ ] Claude 可编辑完整 settings.json；非法 JSON 保存失败时草稿不丢失，错误定位到当前文档。
- [ ] Codex 可编辑完整 auth.json 与 config.toml，验证 model、model_provider、model_providers、projects、MCP、hooks、features 和未知字段 round-trip。
- [ ] Grok Build 可编辑完整 config.toml 及模型/供应商映射。
- [ ] Key 默认脱敏，仅允许在 Key 编辑器中 reveal；列表、Toast、诊断、预览不泄露明文。
- [ ] 通用配置按类型独立保存，不挂在单个供应商下；common < provider < active key 的 effective 合并顺序正确，数组替换、JSON null 覆盖语义正确。
- [ ] source/common/provider/effective/live diff 能识别字段来源；没有自动轮换、健康度、配额、重试、有效性或 failover 控件。
- [ ] 供应商切换会清理文档草稿；CLI 类型切换会保护未保存的通用配置和文档草稿。

### 2. Gate 3：全局 Home 写入与恢复

- [ ] Claude 写入 <Home>/.claude/settings.json，保留 hooks、permissions 和未知字段。
- [ ] Codex 同时正确写入 <Home>/.codex/auth.json 与 <Home>/.codex/config.toml。
- [ ] Grok 写入 <Home>/.grok/config.toml，保留允许保留的无关配置。
- [ ] Codex 任一目标写入失败时，已写入文件全部恢复，DB current 保持旧状态，journal 留下可恢复失败记录。
- [ ] 模拟 stage/replace 后崩溃，重启能发现并完成或修复 journal；界面不虚报当前供应商。
- [ ] active Key 变化只提示重新 apply，不自动偷偷写全局文件。
- [ ] 已运行终端的环境、配置和进程不变，只有后续启动使用新状态。
- [ ] preview 后修改 live 文件再 apply 会阻止并提示 diff/reload/overwrite，不静默覆盖。
- [ ] restore/recovery 不覆盖失败期间用户新写入的内容；只恢复仍匹配预期指纹的目标。
- [ ] 成功、恢复、失败后均清理临时备份和空目录；apply/recovery 共享锁，busy contention 返回稳定错误。

### 3. Gate 4：Home、环境、Hook、History

- [ ] 验证本地自动 Home、手动 Home、绝对路径、reset-to-auto、WSL UNC Home、两个 WSL 发行版的独立保存/切换/恢复。
- [ ] .claude、.codex、.grok 根目录、相对路径、文件、无权限路径、只读路径均给出明确错误和修复建议。
- [ ] 保存前预览三个派生目录、live target 和 history 路径。
- [ ] 诊断显示 CLI 可执行文件/版本、配置语法、目标可访问性、当前 provider/key 是否存在、冲突指纹、Home 来源、Hook/History 对齐；不显示明文 Key。
- [ ] 无显式根时 Hook/statusline/Claude/Codex/Grok history 自动根跟随 active Home；显式根不被静默修改，并提供显式 Adopt。
- [ ] Home 变化只刷新诊断和绑定预览，不自动安装、卸载、移动或删除 Hook/History 文件。
- [ ] 保存 Home 后重启，active Home identity 仍正确恢复。

### 4. Gate 5：项目、Worktree、终端

- [ ] 无 override 使用 global；project override 不改变 global；Worktree > project > global，reset 按顺序回退。
- [ ] Claude、Codex、Grok 本地启动均使用隔离 materializer，Key 不拼入 shell 命令。
- [ ] CCS DB 改名后 provider 设置、项目选择器、badge、terminal create、session restore、CC Connect 仍可工作。
- [ ] 可映射旧引用转为 v2 native reference；不可映射引用生成 repair issue，不能按同名或第一个供应商猜测。
- [ ] SSH 项目启动不发送本地 provider secret/config；多会话、多 pane、多 Workspace 的 snapshot 不因之后的 Key/global/scope 变化而漂移。
- [ ] 关闭会话和重启恢复按 ownership manifest 正确清理/恢复 snapshot。

### 5. Gate 6：CCS 只读导入

- [ ] 本地和 WSL CCS DB 缺失、空库、损坏、Python/SQLite/发行版异常时，预览有明确结果/超时；native catalog 仍可打开。
- [ ] 主线路供应商导入 metadata、documents、common config、current candidate；显式 Key 同意后可发现 active Key。
- [ ] 多 Key 保留 label、notes、tags、order、enabled、active；忽略 cooldown、usage、failover。
- [ ] 空 Key、OAuth、未知 credential layout 变为带标签的 draft/skipped，不能生成空 active Key。
- [ ] 相同 source identity/fingerprint 重复导入幂等；source 变化有 update/conflict preview；仅 display name 相同不能合并。
- [ ] 导入不修改 CCS；全局写入是独立确认操作；默认 sync/backup/export 不含明文 Key，restore 要求重新录入。

### 6. Gate 7：UI、无障碍、国际化

- [ ] 1024px 和 1440px 下列表/编辑器独立滚动，关键控件不丢失，无水平溢出。
- [ ] 鼠标和键盘均可完成创建、选择、排序、编辑、激活 Key、切换全局、打开通用配置、Home、导入。
- [ ] 类型 Tab 支持方向键、Home/End、循环切换、roving focus；删除/关闭后焦点回到合理卡片；破坏性操作有确认。
- [ ] 状态同时有文字和图标/颜色；按钮有标签；编辑器与解析错误有正确 ARIA 关联。
- [ ] zh-CN / en-US 无 fallback key、无硬编码新增文案；英文环境仍为 24 小时制。
- [ ] 对照 CCS 截图确认卡片、endpoint/key/model、多 Key、完整 raw 配置、通用配置、全局切换均具备。

### 7. 自动质量门禁与发布

- [ ] npx tsc --noEmit
- [ ] cd src-tauri; cargo fmt --all -- --check
- [ ] cd src-tauri; cargo check
- [ ] cd src-tauri; cargo test --no-fail-fast --quiet
- [ ] git diff --check 与 i18n parity 通过。
- [ ] GitNexus detect_changes --scope unstaged 和 detect_changes --scope compare --base-ref master 已执行并记录人工复核结论。
- [ ] 生产路径不再调用 CCS runtime 的 list/prepare/reset/switch；只保留只读 import reader/adapter 和 legacy profile 兼容。
- [ ] 更新 docs/功能清单.md、相关 spec、HANDOFF.md；CHANGELOG.md 的 [TEMP] 替换为用户提供的正式版本，未提供时标记为发布阻塞。
- [ ] 所有 Gate 0–5 为 PASS，Gate 6 无未解释失败，Gate 7 无阻塞项，才允许标记完成。

## 三-A、本次逐项验收记录（2026-08-03）

状态说明：`PASS` 仅表示有可复核的静态/自动化证据；需要真实 WSL、真实 Home 文件写入或运行中的 Tauri UI 的项目，在当前环境统一记为 `BLOCKED`，不把单元测试替代为人工通过。

### Gate 0：环境与工作树

| 编号 | 状态 | 证据 |
|---|---|---|
| 0.1 | PASS | `Get-Location` 为 `F:\github\CLI-Manager`；`git branch --show-current` 为 `feat/native-provider-management`。 |
| 0.2 | PASS | 初始检查记录 84 个既有修改/新增路径；2026-08-04 复核为 86 个，其中新增的 2 个仅是本轮修正的测试断言，无生成物。 |
| 0.3 | PASS | `AGENTS.md`、`CLAUDE.md` 保持工作区既有修改，验收期间未编辑、未回退。 |
| 0.4 | BLOCKED | `wsl.exe --status` 返回退出码 50，`wsl.exe --list --quiet` 返回退出码 1；当前无可用发行版，所有 WSL 项目见 WSL-01。 |
| 0.5 | PASS | 本轮未运行 `npm run dev/build`、`npm run tauri dev/build`，未执行 reset/checkout/commit/push；仅执行检查、测试和文档更新。 |

### Gate 2：供应商维护编辑器

| 编号 | 状态 | 证据 |
|---|---|---|
| 2.1 | PASS | `NativeProviderCatalog`、`NativeProviderTypeTabs`、`NativeProviderHomeSection`、`NativeProviderImportSection` 已覆盖三类 Tab、搜索、排序、导入、诊断和新增入口；`npx tsc --noEmit` 通过。 |
| 2.2 | PASS | `NativeProviderCard` 展示 URL、模型、Key 状态和 current 标记；源码审阅通过。 |
| 2.3 | PASS | `NativeProviderEditor`/`NativeProviderFormModal` 的请求地址、Key 管理、模型和高级/raw 文档顺序可见；源码审阅通过。 |
| 2.4 | PASS | `NativeClaudeConfigSection.tsx` 使用下拉框提供 API format 与认证字段，包含 `ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_API_KEY`。 |
| 2.5 | PASS | Claude 源码包含完整 URL、Sonnet/Opus/Fable/Haiku/Subagent、display name、actual model、fallback、1M 与 quick-set 逻辑。 |
| 2.6 | BLOCKED | JSON 校验、草稿保留和 ARIA 关联有源码与 TypeScript 证据，但未启动 Tauri UI 进行真实保存失败/视觉定位验收。 |
| 2.7 | BLOCKED | Codex `auth.json`/`config.toml` 与 round-trip 后端覆盖存在，但 MCP/projects/hooks/features/未知字段的真实编辑器交互未启动 UI 验收。 |
| 2.8 | BLOCKED | Grok 完整 TOML 与映射源码存在，未启动 UI 做真实 round-trip。 |
| 2.9 | PASS | `PasswordInput`、脱敏 DTO、diagnostic/preview 审计均不主动暴露明文；相关 Rust provider 测试通过。 |
| 2.10 | PASS | common/provider/active-key 合并、数组替换、JSON null 覆盖与来源视图在后端/编辑器源码中实现；`provider::global` 18 项测试通过。 |
| 2.11 | PASS | 未发现自动轮换、健康度、配额、重试、failover 控件；source/common/provider/effective/live 视图存在。 |
| 2.12 | BLOCKED | 草稿保护代码存在，但供应商/CLI 切换及确认焦点需要真实 UI 操作，当前未启动 UI。 |

### Gate 3：全局 Home 写入与恢复

| 编号 | 状态 | 证据 |
|---|---|---|
| 3.1 | BLOCKED | Claude writer 的目标、保留字段和测试存在；真实 `<Home>/.claude/settings.json` 写入未执行。 |
| 3.2 | BLOCKED | Codex 双文件 writer/补偿单测存在；真实 `<Home>/.codex` 写入未执行。 |
| 3.3 | BLOCKED | Grok writer/保留字段单测存在；真实 `<Home>/.grok/config.toml` 写入未执行。 |
| 3.4 | BLOCKED | `provider::global` 补偿测试 18 项通过，覆盖部分写入恢复、current 保持和 journal；真实文件验收仍未执行。 |
| 3.5 | BLOCKED | journal recovery/锁相关自动测试通过；真实崩溃重启恢复未执行。 |
| 3.6 | PASS | active Key 仅触发显式 apply 语义，未发现自动偷偷写全局文件的路径；源码审阅通过。 |
| 3.7 | BLOCKED | snapshot 固化逻辑存在，运行中的真实终端不变性未执行。 |
| 3.8 | BLOCKED | preview 指纹、外部修改保护和 recovery 条件在 `global.rs` 中实现并有测试；真实外部编辑流程未执行。 |
| 3.9 | BLOCKED | 备份清理、共享锁、busy contention、恢复保护有自动测试；真实文件生命周期仍未执行。 |

### Gate 4：Home、环境、Hook、History

| 编号 | 状态 | 证据 |
|---|---|---|
| 4.1 | BLOCKED | 本地静态路径可验证；WSL UNC、双发行版保存/切换/恢复因 WSL-01 无法验收。 |
| 4.2 | BLOCKED | Home 校验器覆盖根目录/相对路径/文件/不可写错误；实际权限与只读路径矩阵未执行。 |
| 4.3 | BLOCKED | 三个派生目录、live target、history 预览源码存在；真实 Home 预览 UI 未执行。 |
| 4.4 | BLOCKED | 诊断字段和脱敏实现存在；真实 CLI/目标/冲突/Hook/History 诊断未启动 UI。 |
| 4.5 | BLOCKED | active Home 到 Hook/History 的解析链路和 explicit Adopt 存在；真实本地/WSL 环境切换未执行。 |
| 4.6 | PASS | 源码审阅确认 Home 变化只更新绑定/诊断，不自动安装、卸载、移动或删除 Hook/History。 |
| 4.7 | BLOCKED | active Home identity 的持久化/恢复代码存在；重启后的真实应用验证未执行。 |

### Gate 5：项目、Worktree、终端

| 编号 | 状态 | 证据 |
|---|---|---|
| 5.1 | BLOCKED | `scope.rs` 明确 Worktree > project > global，reset 回退和无 heuristic fallback；真实项目/Worktree 终端矩阵未执行。 |
| 5.2 | BLOCKED | Claude/Codex/Grok 使用隔离 materializer，Key 通过环境/快照注入而非 shell 命令；真实本地启动未执行。 |
| 5.3 | BLOCKED | native provider runtime 已移除生产 CCS list/prepare/reset/switch 调用；CCS DB 改名后的真实项目选择器、terminal create、restore、CC Connect 未运行。 |
| 5.4 | BLOCKED | 可映射旧引用与 repair issue/fail-closed 逻辑存在；真实迁移与 repair UI 未执行。 |
| 5.5 | BLOCKED | SSH `resolvePtyLaunch` 显式清空本地 provider snapshot/config/secret；真实 SSH/多 pane 漂移未执行。 |
| 5.6 | BLOCKED | ownership manifest 清理/恢复代码存在；关闭会话和重启恢复的真实矩阵未执行。 |

### Gate 6：CCS 只读导入

| 编号 | 状态 | 证据 |
|---|---|---|
| 6.1 | BLOCKED | 本地异常/空库/损坏由导入测试覆盖；WSL 异常与发行版超时因 WSL-01 无法验收。 |
| 6.2 | PASS | `cargo test provider::import --lib --no-fail-fast --quiet`：11 passed；metadata/documents/common/current candidate 逻辑源码审阅通过。 |
| 6.3 | PASS | 多 Key 的 label/notes/tags/order/enabled/active 与 digest 去重由导入实现覆盖；忽略 usage/cooldown/failover。 |
| 6.4 | PASS | 空 Key/OAuth/未知 layout 的 draft/skipped 路径存在，禁止生成空 active Key；导入测试通过。 |
| 6.5 | PASS | source identity/fingerprint、幂等、变化预览和 display-name 不合并逻辑存在；导入测试通过。 |
| 6.6 | PASS | CCS 仅作为只读 import reader；生产路径未发现 `ccswitch_list/prepare/reset/switch` 调用，备份/导出 DTO 不含明文 Key。 |

### Gate 7：UI、无障碍、国际化

| 编号 | 状态 | 证据 |
|---|---|---|
| 7.1 | BLOCKED | 1024px/1440px 真实窗口布局、独立滚动和无溢出未启动 Tauri UI。 |
| 7.2 | BLOCKED | 关键操作源码有鼠标/键盘入口；创建、排序、激活、全局切换、Home、导入的真实操作未执行。 |
| 7.3 | BLOCKED | roving tab、方向键/Home/End 与确认焦点源码存在；删除/关闭后的真实焦点验收未执行。 |
| 7.4 | BLOCKED | ARIA 属性和状态图标源码存在；真实辅助技术/焦点可见性未执行。 |
| 7.5 | BLOCKED | i18n parity 静态检查为 zh=3421/en=3421/missing=0/extra=0，macOS 窗口控件静态脚本通过；中英文运行时切换与 24 小时制 UI 未执行。 |
| 7.6 | BLOCKED | 未启动 UI，无法完成 CCS 截图对照。 |

### 自动质量门禁与发布记录

| 项目 | 状态 | 精确结果 |
|---|---|---|
| TypeScript | PASS | `npx tsc --noEmit`，退出码 0。 |
| Rust fmt | PASS | `cd src-tauri; cargo fmt --all -- --check`，退出码 0。 |
| Rust check | PASS | `cd src-tauri; cargo check`，退出码 0，无 warning。 |
| Rust tests | PASS | `cargo test --no-fail-fast --quiet`：825 passed、0 failed、1 ignored。 |
| focused provider tests | PASS | import 11、global 18、grok 7、timeout 1、history_sources 4 passed；`ccswitch_db` 为 0 passed/0 failed/1 ignored（WSL 条件测试）。 |
| diff/i18n | PASS | `git diff --check` 退出码 0（仅既有 CRLF 警告）；i18n parity zh=3421、en=3421、missing=0、extra=0。 |
| GitNexus | PASS（人工复核有风险提示） | 测试基线修正后最终重跑：unstaged 为 68 files、86 changed symbols、299 affected processes、`critical`；compare master 为 108 files、157 changed symbols、299 affected processes、`critical`。已人工核对 provider/Home/scope/terminal/history 主要触点；索引 FTS 缺失且图谱把既有 PTY/诊断路径扩散进来，不能把该结果当作低风险证明。 |
| macOS | PASS（静态）/BLOCKED（真实） | `node scripts/verify-macos-window-controls.mjs` 通过；Windows 环境不能执行 macOS runtime/build。 |
| broader Node tests | FAIL | `node --test scripts/*.test.mjs`：340 tests 中 339 passed、1 failed；失败为重构后已删除的 `src/lib/terminalCursorMovement.ts` 仍被旧测试引用，详见 S-01。 |
| CHANGELOG | BLOCKED | 已补充 `[TEMP]` 收尾记录，但用户未提供正式版本号，不能替换为发布版本。 |

## 三-B、缺陷与环境阻塞记录

### [FAIL] S-01：仓库广义 Node 测试仍存在 1 个失败

- 现象：`node --test scripts/*.test.mjs` 为 339/340 通过。
- 根因：`gitStoreRemote.test.mjs` 的版本断言已同步实际 ssh-agent `0.1.7`；`resumeCliArgs.test.mjs` fixture 已同步 native v2 契约，生成 profile 是派生物，不再写入项目引用；剩余 `terminalCursorMovement.test.mjs` 仍引用 `src/lib/terminalCursorMovement.ts`，该文件在 `4511f916 refactor: split xterm terminal subsystems` 中已删除。
- 影响触点：仅终端光标旧测试；未发现本任务生产 provider 代码的编译或 Rust 回归失败。
- GitNexus impact：未修改函数/类/方法，未触发符号修改前置条件；GitNexus 当前 FTS 缺失，相关新符号查询不可用。
- 修复：仅更新两个与当前 manifest/native v2 契约不一致的测试断言；未改生产函数，也未恢复已删除的无调用旧模块。
- 回归测试：`node --test scripts/gitStoreRemote.test.mjs scripts/resumeCliArgs.test.mjs` 为 17/17 通过；广义 Node 套件仍为 339/340，该条保持 FAIL。

### [BLOCKED] WSL-01：WSL 不可用

- 原因：`wsl.exe` 存在，但 `--status` 退出码 50、`--list --quiet` 退出码 1，未提供可执行发行版。
- 已尝试：状态检查、发行版列表检查；`ccswitch_db` 的 WSL 测试被条件忽略。
- 不影响的替代验证：本地 provider import 11 项、global 18 项、Grok 7 项、Rust 全量 825 项通过；WSL 分支不伪造 PASS。
- 解除条件：安装并启动可用 WSL 发行版，且发行版内 `python3` 可用并能运行 SQLite 只读备份。

### [BLOCKED] UI-01：真实 Tauri UI 与 macOS runtime 未执行

- 原因：验收明确禁止 `tauri dev/build`，当前环境为 Windows，不能替代 1024/1440、焦点、ARIA、中英文运行时及 macOS runtime 验收。
- 已尝试：源码审阅、TypeScript、i18n parity、macOS 窗口控件静态脚本。
- 解除条件：在允许启动应用的 Windows 环境完成 UI 手测，并在 macOS 主机完成兼容性运行/构建检查。

## 三-C、Release gate 结论

当前不能标记完成：Gate 3/4/7 存在环境阻塞，Gate 5/6 含 WSL/真实运行时阻塞，广义 Node 测试仍有 1 个旧测试失败，CHANGELOG 仍为 `[TEMP]`。本任务保持 `in_progress`，不归档、不提交、不推送。

## 三-D、2026-08-04 增量记录

- 环境复核：分支仍为 `feat/native-provider-management`，工作区为 86 个路径（初始 84 个既有路径加本轮 2 个测试断言）；`wsl.exe --status` 退出码 50、`--list --quiet` 退出码 1，WSL-01 未解除。
- 最小基线修正：`scripts/gitStoreRemote.test.mjs` 的 ssh-agent 版本断言改为实际 `0.1.7`；`scripts/resumeCliArgs.test.mjs` 改为 native v2 reference，并确认不会重新注入派生 `--profile`。两项修改前已运行 GitNexus upstream impact，但测试符号未被当前索引解析，结果为 `UNKNOWN/not found`，无 HIGH/CRITICAL 结果。
- 回归结果：两个定向脚本 17/17 通过；广义 Node 测试从 337/340 改善为 339/340，唯一失败是历史终端光标测试引用已在 `4511f916` 删除的模块。本轮不恢复无调用旧模块，不扩展 provider 任务范围。

## 三-E、2026-08-04 用户 UI 复核新增问题

### [FAIL] UI-02：导入模块永久内嵌且修复引用不可读

- 证据：用户截图显示导入面板直接占用原生供应商目录主体；修复行显示
  `project:<UUID> -> <provider>`，无法直接辨认项目。
- 根因触点：`NativeProviderSettingsPage` 永久渲染
  `NativeProviderImportSection`；`NativeProviderImportSection` 的 issue 行
  直接拼接 `scopeKind:scopeId`。
- 目标修复：目录只保留 Import 入口；导入完整流程放入 modal/drawer；修复
  行通过 project/Worktree 查询显示名称，命令仍使用稳定 ID。
- 状态：FAIL，尚未改生产代码。

### [FAIL] UI-03：CLI Home 与供应商目录职责混在同一长页面

- 证据：用户要求将 CLI Home 移到独立设置 surface，不在目录内直接占用主
  内容区。
- 根因触点：`NativeProviderSettingsPage` 永久渲染
  `NativeProviderHomeSection`。
- 目标修复：增加 `CLI Home` 入口/视图，复用现有 Home、诊断、全局应用和
  Adopt 状态，不复制后端逻辑。
- 状态：FAIL，尚未改生产代码。

### [FAIL] UI-04：供应商列表与详情高度不一致

- 证据：用户截图显示详情区域出现异常空白/错位，同时供应商列表会随数量
  增长；要求列表高度与详情一致并各自滚动。
- 根因触点：外层 provider grid 只有 `min-h`，目录自身使用 `min-h`，详情
  使用独立 `max-h`，三者没有共享的明确 viewport height contract。
- 目标修复：给列表/详情共享 bounded responsive height；两侧独立滚动，覆盖
  loading、empty、error、many-provider、long-document 和 no-selection 状态。
- 状态：FAIL，尚未改生产代码。

## 四、缺陷记录模板

~~~text
[FAIL] 编号：G-xx / S-xx / UI-xx
现象：
复现：
根因：
影响触点：
GitNexus impact：
修复：
回归测试：
证据：
~~~

环境阻塞：

~~~text
[BLOCKED] 编号：WSL-xx
原因：
已尝试：
不影响的替代验证：
解除条件：
~~~

## 五、最终报告格式

最终只输出：

1. PASS/FAIL/BLOCKED 汇总；
2. 修复过的缺陷及回归测试；
3. 自动检查的精确结果；
4. 未完成项及阻塞原因；
5. 是否满足 Release gate。

不要把“自动测试通过”写成“全部验收通过”。

## 六、2026-08-04 UI 调整实现收尾

历史 FAIL 记录保留作为问题发现证据；以下为本轮实现后的静态验收结果。

| 项目 | 状态 | 证据 |
|---|---|---|
| UI-02 导入入口/引用可读性 | PASS（静态） | `NativeProviderCatalog` 仅提供 Import action；页面按需挂载 modal；作用域显示名解析 project/Worktree 名称，未知记录显示本地化标签和 ID。 |
| UI-03 CLI Home 独立 surface | PASS（静态） | `NativeProviderSettingsPage` 使用 `catalog/home` surface；Home section 只在 Home surface 渲染，复用既有 `useNativeProviderHome`。 |
| UI-04 等高与独立滚动 | PASS（静态） | provider grid 在 `lg` 使用共享 bounded height；目录 Card 使用 `h-full min-h-0`，详情 Stack 使用 `h-full min-h-0 overflow-y-auto`，目录 ScrollArea 独立滚动。 |
| UI-02 引用名称回归 | PASS | `node --test scripts/nativeProviderImportDisplay.test.mjs`：3 passed、0 failed，覆盖 project、Worktree、缺失 ID fallback。 |
| UI-02/03/04 真实运行时 | BLOCKED | 未启动 Tauri dev/build；1024/1440、焦点/ARIA、双语运行时、截图对照仍需手动验证。 |

### 本轮缺陷根因与影响触点

- UI-02 根因：导入模块由 `NativeProviderSettingsPage` 常驻挂载，且
  `NativeProviderImportSection` 直接把 `scopeKind:scopeId` 作为修复行主文案。
  影响触点是设置页目录布局、项目/Worktree 名称展示和修复行可读性；修复
  仅改变展示层，`issueId`、`scopeId` 和 `providerId` 命令参数不变。
- UI-03 根因：`NativeProviderHomeSection` 与目录、通用配置在同一页面流中
  常驻渲染。影响触点是设置页垂直空间和目录信息层级；修复复用现有 Home
  hook/commands，不复制或改变 Home 写入逻辑。
- UI-04 根因：外层 grid、目录 Card、详情 Stack 各自只有 `min-h`/`max-h`，
  没有共同 viewport 合同。影响触点是多供应商列表增长、详情长文档和空选择
  状态；修复建立共享高度并让两侧分别滚动。
- GitNexus upstream impact：已对目标页面、目录和导入组件执行三次；索引
  刷新后仍无法解析 TSX 导出函数，均返回 `UNKNOWN/not found`，无可用 HIGH/
  CRITICAL 结果。已人工复核设置页唯一挂载点、目录回调、项目 Store 读取和
  导入修复命令的稳定 ID 触点。

### 自动检查增量结果

- `npx tsc --noEmit`：退出码 0。
- `cargo fmt --all -- --check`：退出码 0。
- `cargo check`：退出码 0，无 warning。
- `cargo test --no-fail-fast --quiet`：825 passed、0 failed、1 ignored。
- `node --test scripts/nativeProviderImportDisplay.test.mjs`：3 passed、0 failed。
- `node --test scripts/*.test.mjs`：342 passed、1 failed（总计 343）；唯一失败
  仍为既有 `terminalCursorMovement.test.mjs` 引用了已删除的
  `src/lib/terminalCursorMovement.ts`，本轮未恢复无调用旧模块。
- i18n parity：zh=3428、en=3428、missing_en=0、extra_en=0。
- `git diff --check`：退出码 0，仅既有 LF/CRLF 警告。
- GitNexus `detect_changes(compare master)`：108 files、0 affected processes、
  risk `low`；changed-symbol 数量会随工作树文档/未跟踪文件重算，工作树包含
  既有任务改动，非本轮 UI 独占范围。

Release gate 仍为 BLOCKED：静态 UI 修复已完成，但 WSL、真实 Tauri UI、
macOS runtime、人工布局/键盘/ARIA/双语验收及旧测试失败尚未解除，不能标记
任务完成。

## 三-F、2026-08-04 UI 编辑器与详情布局增量

| 项目 | 状态 | 证据 |
|---|---|---|
| UI-05 通用配置编辑器 | PASS（静态） | `NativeProviderCommonConfigSection` 使用可折叠 Monaco 编辑器；Claude 使用 JSON 语言与对象校验，Codex/Grok 使用 TOML 编辑模式并调用非写入 `provider_common_config_validate` 校验。 |
| UI-06 CLI 类型图标 | PASS（静态） | `NativeProviderTypeTabs` 已为 Claude/Codex/Grok Build 提供对应图标；本轮未重复改动已有图标实现。 |
| UI-07 导航顺序 | PASS（静态） | `供应商目录 / CLI Home` surface 切换位于 CLI 类型 Tab 之前，Home 不再进入目录主体流。 |
| UI-08 详情完整性 | PASS（静态） | 详情卡片、Key 区、原始文档区增加 `min-w-0`/溢出保护；信息网格在窄宽度降为单列，操作组与字段来源允许换行，父详情保持独立滚动。 |
| 通用配置校验回归 | PASS | Rust 新增 JSON 对象、TOML 合法/非法 4 项单测；本轮全量 Rust 测试 829 passed、0 failed、1 ignored。 |
| UI-05~08 真实运行时 | BLOCKED | 未启动 Tauri dev/build；1024/1440 视觉、Monaco 实际焦点/ARIA、中文/英文运行时及 macOS runtime 仍需手动环境验收。 |

### 本轮新增缺陷根因与影响触点

- UI-05 根因：通用配置只使用普通 `Textarea`，且前端对 TOML 恒定视为有效，只有保存失败时才得到后端错误。影响触点是 Claude/Codex/Grok 三类通用配置的编辑、校验、保存按钮和未保存草稿保护。修复复用现有校验规则，抽出只校验不写盘的 repository 命令；保存路径继续先校验再写入。
- UI-07 根因：页面先渲染 CLI 类型 Tab，再渲染 `供应商目录 / CLI Home` surface，造成用户先切类型、后选职责视图。修复只调整页面渲染顺序，不改变 app type、Home 或 import 状态语义。
- UI-08 根因：详情卡片内部固定双列、若干 Group 禁止换行，长 URL、Key 标签和字段来源会把小块挤出详情 viewport。修复在详情边界增加最小宽度/横向裁剪保护，并让窄屏信息网格和操作行响应式换行；列表/详情数据和后端写入触点不变。
- GitNexus upstream impact：本轮先对页面、通用配置 section/hook、详情、Key、文档组件及 common repository/command 执行 upstream impact；TSX/Rust 目标均返回 `UNKNOWN / Target not found`，没有可解析的 HIGH/CRITICAL 结果。已人工复核 page→hooks→Tauri command→repository 链路及详情子组件的调用触点。

### 本轮自动检查

- `npx tsc --noEmit`：退出码 0。
- `cargo fmt --all -- --check`：退出码 0。
- `cargo check`：退出码 0。
- `cargo test --no-fail-fast --quiet`：829 passed、0 failed、1 ignored。
- `node --test scripts/nativeProviderImportDisplay.test.mjs`：此前 3 passed、0 failed；本轮未改该纯展示解析逻辑。
- `git diff --check`：退出码 0；仅有既有 LF/CRLF 转换警告。
- i18n parity：zh=3434、en=3434、missing_en=0、extra_en=0。
- GitNexus `detect_changes(scope:unstaged)`：111 changed symbols、75 files、0 affected processes、risk `low`；`detect_changes(scope:compare, base_ref:master)`：170 changed symbols、108 files、0 affected processes、risk `low`。工作树含本任务既有改动，未将该结果解释为本轮独占风险证明。

Release gate 仍为 BLOCKED：本轮静态实现和自动检查通过，但 WSL、真实 Tauri UI、macOS runtime、人工 1024/1440/键盘/焦点/ARIA/双语验收、旧 Node 测试失败与 `[TEMP]` 版本号阻塞仍未解除。

## 三-G、2026-08-04 Codex/Grok 维护反馈增量

### [PASS（静态）/ BLOCKED（运行时）] 高级维护与空配置生成

- 新增共享 Codex/Grok 高级配置区：上游/wire API、模型映射、User-Agent、Header/Body JSON 覆盖、Goal mode、远程压缩；新增文案已同步 `zh-CN`/`en-US`。
- 空或缺失供应商专属文档时，表单根据基础字段生成 Claude JSON、Codex TOML、Grok TOML；用户手动修改 raw 文档后进入 manual 状态，未知字段不被覆盖。
- 高级 metadata 保存在既有 provider settings envelope 的 `advanced` 字段；密钥仍由密钥管理区持有，未把代理字段伪装成官方 TOML 配置。
- 根因与影响触点：原表单没有 Codex/Grok 高级状态，也没有在缺失 nested `config` 时生成 CLI-specific 文档，导致新增/编辑时专属配置空白；影响表单状态、envelope 转换、TOML/JSON 展示与保存校验。修复后补充生成和 envelope round-trip 回归。
- GitNexus upstream impact：`NativeProviderFormModal`、`providerConfigDocumentFromSettings`、`settingsConfigFromProviderDocument` 当前索引均为 `UNKNOWN/not found`，未出现 HIGH/CRITICAL；已人工复核页面、表单、catalog update、repository merge/envelope 和 materializer 触点。

### 最新自动检查

- `npx tsc --noEmit`：PASS，退出码 0。
- `node --test scripts/nativeProvider*.test.mjs`：PASS，13/13。
- i18n parity：PASS，zh=3467、en=3467、missing_en=0、extra_en=0。
- GitNexus `detect_changes`：最终记录 unstaged changed=137、files=75、affected=0、risk=low；compare master changed=129、files=108、affected=0、risk=low。当前索引对部分 TSX/未跟踪符号解析不完整，重复调用的 changed symbol 计数有波动，已人工复核相关调用触点。
- WSL、真实 Tauri UI、macOS runtime、1024/1440、键盘/焦点/ARIA 和中英文运行时：BLOCKED；未运行 dev/build，未提交或推送。
