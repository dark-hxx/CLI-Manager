# 08-02-key 交接说明

更新时间：2026-08-03
任务状态：`in_progress`，不要归档或标记完成。

## 目标

把 CLI-Manager 从 CCS 供应商运行时依赖逐步迁移到自有供应商域，覆盖：

- `providers.db` 独立数据边界；
- Claude / Codex / Grok Build 供应商目录与多 Key；
- 完整配置文档、类型级通用配置；
- 全局 Home 应用与恢复；
- 项目 / Worktree 作用域解析；
- Home 环境诊断；
- CCS 只读导入、冲突与修复。

## 当前代码状态

当前分支：`feat/native-provider-management`。基线提交是：

```text
b37c8a4e feat(provider): complete native key management flow
```

本次交接提交会包含当前工作树中的文档编辑器和交接资料，并推送到：

```text
origin/feat/native-provider-management
```

`AGENTS.md` 与 `CLAUDE.md` 的本地修改是用户已有修改，不要覆盖、回退或加入本任务提交。

## 已完成

### Phase 0：数据库与兼容边界

- 独立 `providers.db` opener、WAL、foreign keys、busy timeout、迁移前备份。
- CCS 兼容的供应商核心表、通用配置、手动 Key、Home 偏好、导入引用、repair issue、apply journal 表。
- 复合 `(id, app_type)` 身份、启用/当前约束、active key 唯一约束和数据库测试。
- 旧 `cli-manager.db` 的历史迁移注册保留，生产供应商命令尚未把旧 CCS 数据库作为运行时数据源。

### Phase 1：目录、Key、通用配置与完整文档

- 原生目录 list/get/create/update/duplicate/delete/enable/current/reorder。
- Key create/update/delete/reorder/activate/reveal、启停、当前 Key 替换确认；替换、投影和删除在同一事务内完成。
- Claude 通用 JSON；Codex/Grok Build 通用 TOML；供应商配置覆盖通用配置并生成脱敏 effective preview。
- 完整配置文档：
  - Claude：`claude.settings` / `settings.json`；
  - Codex：`codex.auth` / `auth.json` 与 `codex.config` / `config.toml`；
  - Grok Build：`grokbuild.config` / `config.toml`。
- 后端负责 JSON/TOML 语法校验、嵌套 TOML 摘要、敏感字段脱敏、密钥字段保留和禁止通过原始文档新增/修改托管密钥。
- 前端按职责拆分 catalog、card、editor、key section、form、document editor、common config hook/section；新增文案同时有 `zh-CN` / `en-US`。
- 供应商切换会清理文档草稿，CLI 类型切换会确认并保护通用配置和文档未保存草稿。

### Phase 2：Home、诊断与全局应用（主体已实现）

- `CliHomeResolver` 已覆盖本地/WSL 自动与手动 Home、按发行版偏好、reset-to-auto 及派生目标。
- Hook/statusline/history 默认根、显式目录优先级和 Home 诊断已接入；诊断不返回明文 Key，并输出冲突指纹。
- Claude/Codex/Grok owner-aware global writer、preview/apply/current/repair、外部修改冲突、补偿和 journal recovery 已实现。
- 本轮补强了 apply/restore 的外部修改保护：补偿只恢复仍匹配预期指纹的目标，避免覆盖用户在失败期间的新内容；非法 app type 不再静默降级为全量诊断。
- 全局应用成功后会刷新原生目录当前 provider/detail，避免当前徽标和活动 Key 状态停留在旧快照。
- Claude 供应商维护已补齐 CCS 兼容的 API 格式/认证字段下拉、完整 URL 偏好、五类模型映射、显示名称、回退模型和 1M 标记；供应商卡片同时展示 API URL 与模型；恢复 journal 与同一 Home/CLI 类型共用 apply 锁，避免恢复和应用并发覆盖。
- WSL stage 写入的 stdin 失败分支会主动终止并回收子进程，避免全局应用异常时遗留悬挂 `wsl.exe`。
- stage 失败会清理临时备份并将 journal 标记为 `failed`，避免无效事务长期阻塞后续全局应用。
- 全局应用或恢复成功后会清理 journal 临时备份文件及空目录，避免长期累积旧配置副本。
- 启动恢复会扫描已完成的 journal，回收进程在提交成功后崩溃遗留的备份文件；清理路径限制在应用自己的 provider backup 根目录内。
- Home 编辑区新增非持久化目标预览；未保存 Home 草稿时会清空旧全局预览并禁用全局应用，避免误写旧 Home。
- 环境诊断接收当前 Home 草稿并复用 resolver；未保存的本地/WSL auto/manual Home 不再诊断旧持久化路径。
- 修复 Home 页 reset-to-auto 后诊断仍读取旧手动草稿的问题；重置后的诊断显式传递 auto Home 输入，避免 React 状态更新时序造成路径回退。
- 修复 Home Adopt 的 Grok 历史绑定参数：传入 `.grok` 配置根，由 history store 统一派生 `.grok/sessions`，避免生成重复的 `sessions/sessions`。
- Home 保存现在会在 `providers.db.settings` 持久化当前 active Home identity；应用启动恢复该 Home，所有无显式根的默认 Hook/statusline/history 解析都会跟随它，显式目录仍保持更高优先级；各本地/WSL 环境的 Home 偏好仍独立保存。
- 修复 Hook 设置页把后端自动解析出的 Claude/Codex/Grok 目录回写为显式配置的问题；自动 Home 目录只保留在状态快照中，只有用户手动选择/粘贴的目录才会成为显式覆盖。
- 历史来源自动发现改为复用 active Home，并识别 WSL UNC 路径；显式历史目录仍保持优先。
- Grok 历史来源自动候选改为直接指向 `<Home>/.grok/sessions`，避免把配置根误保存为会话根。
- CCS 多 Key 导入改用内存哈希去重，避免短 Key 的统一脱敏值 `***` 把不同凭据错误合并。
- CCS 多 Key 导入遇到相同标签时，会在扫描阶段按稳定顺序追加数字后缀，避免本地标签唯一约束覆盖不同凭据；预览与提交共用该结果。
- CCS 多 Key 导入在扫描阶段按 `sort_index` 稳定排序，避免无序 SQLite 查询导致预览/落库顺序漂移。
- Grok 全局 writer 在复制多 profile 模型表后会清理所有未选 profile 的旧凭据，避免源配置中的
  其他 `api_key` 被带入 Home 文件。
- Codex 全局 writer 同时清理兼容形态下 `auth.json` 顶层和嵌套对象中的旧凭据，再写入当前 Key。
- 历史来源 Claude/Codex 形状检查统一复用 WSL-aware 存在性探测，避免 UNC Home 被宿主机 `Path` API 误报。
- CCS WSL 导入的数据文件存在性探测改用统一的有超时子进程执行器；发行版异常时返回导入错误，不再让导入调用无限等待。
- CCS WSL 导入的只读 SQLite 快照同样复用有超时执行器；Python/SQLite 或发行版异常时不会因裸 `wait_with_output` 阻塞设置页。
- Home/全局操作的稳定错误码补齐本地化映射，数据库、供应商、Key、预览快照错误不再统一落到泛化提示。

本轮审计确认：global apply、Home 预览、环境诊断以及无显式根的 Hook/statusline/history
默认解析均使用当前 active Home；active identity 在保存 Home 时持久化，重启后恢复。各环境
偏好仍按 `local:host` / `wsl:<distro>` 独立存储；显式 Hook/history 根继续优先，只有 Home 页
的 adopt 才会显式修改这些绑定。

### Phase 3：项目 / Worktree / 终端（主体已实现）

- v2 native reference、Worktree > project > global 解析、三类本地 materializer、SSH 禁止注入本地 provider 已接入。
- terminal create、项目/Worktree 启动、session restore、CC Connect 和稳定会话快照已接入；快照按 `generated/<app-type>/<snapshot-id>` 存放，关闭/启动时按 ownership manifest 回收。

## 已验证

最近一次验证结果：

```text
cargo fmt --all -- --check: passed
cargo check: passed, no warnings
cargo test --no-fail-fast --quiet: 824 passed, 0 failed, 1 ignored (825 tests)
cargo test provider::import --lib --no-fail-fast: 11 passed
cargo test provider::global --lib --no-fail-fast: 18 passed
cargo test ccswitch_db --lib --no-fail-fast: 0 passed, 0 failed, 1 ignored (WSL test)
cargo test process_timeout_tests --lib --no-fail-fast: 1 passed
cargo test provider::grok --lib --no-fail-fast: 7 passed
cargo test history_sources --lib --no-fail-fast: 4 passed
npx tsc --noEmit: passed
git diff --check: passed
i18n key parity: zh=3421, en=3421, missing_en=0, extra_en=0
GitNexus detect_changes(unstaged): 66 files, 83 symbols, 299 affected processes, critical
GitNexus detect_changes(compare master): 106 files, 133 symbols, 299 affected processes, critical
```

GitNexus 当前索引已重新分析，但 FTS 仍不可用；`detect_changes` 将与供应商无关的
PTY/诊断流程扩散到当前工作树，属于图谱误报，不能作为低风险证据。对部分前端
符号的 impact 也会产生明显跨模块误报。compare scope 虽已返回结果，仍需结合人工
触点复核。继续修改符号前仍需先执行 upstream impact，若结果为 HIGH/CRITICAL，
先人工复核并记录，不直接忽略。

不要运行 `npm run dev`、`npm run build`、`npm run tauri dev` 或 `npm run tauri build`，除非用户明确要求。

## 剩余任务（按优先级）

### Phase 2：剩余验收

- 手动验证本地/WSL 多发行版 Home、只读/文件/非法路径、派生路径、Hook/history 显式覆盖与 adopt 行为。
- 手动验证三个 global writer 的真实文件写入、Codex 双文件补偿、崩溃恢复、busy contention、外部修改冲突，以及现有终端不受全局切换影响。
- 手动验证 active Home 的多环境语义：保存 WSL Home 后无显式 Hook/statusline/history 根跟随，重启后仍保持；验证切换本地/不同 WSL 发行版只改变 active 默认，不覆盖其他环境偏好。

### Phase 3–5：代码实现已完成，剩余验收

- 原生 scope/materializer、CCS import/repair、Home/Environment、global preview/apply/current/repair 及维护 UI 已接入；需按 acceptance.md 做人工回归。
- 类型 Tab 已补齐方向键、Home/End 循环切换和 roving focus；仍需人工验证 1024/1440 宽度、独立滚动、完整键盘流、焦点回归、ARIA、双语切换和 24 小时格式。
- Provider 卡片已将选择焦点区与排序/启停/复制/删除控件拆开，避免 `role=button` 嵌套交互元素；仍需人工验证焦点顺序和删除后的焦点回归。
- 继续确认 `.cc-switch` 缺失、空库、损坏库、本地/WSL 导入，以及重复导入和 source fingerprint 冲突。

### Phase 6：切换、回归与清理

- 代表性旧 CLI-Manager DB 与 CCS DB 的迁移验证。
- 已完成当前可达旧 `ccswitch_*` runtime 触点清理；保留只读 CCS import reader/adapter 及 legacy profile 字段兼容。
- 补充 crash recovery、busy contention、外部修改、WSL、Worktree、多 pane、session snapshot、显式目录覆盖回归。
- 最终更新文档、功能清单、备份警告、规则与 `[TEMP]` changelog；执行 `detect_changes({scope:"compare", base_ref:"master"})`。

## 2026-08-03 验收收尾记录

- 已重新执行 `npx tsc --noEmit`、`cargo fmt --all -- --check`、`cargo check`、`cargo test --no-fail-fast --quiet`、provider focused tests、`git diff --check` 和 i18n parity；结果分别为通过，Rust 全量为 825 passed、0 failed、1 ignored。
- 已检查 macOS 窗口控件静态脚本，结果通过；Windows 环境无法替代 macOS runtime/build 验收。
- WSL 阻塞：`wsl.exe --status` 退出码 50，`wsl.exe --list --quiet` 退出码 1；WSL Home、WSL CCS import、双发行版和 WSL History/Hook 项目必须保持 BLOCKED。
- 未启动 Tauri dev/build，因此 真实 Home 三 writer 写入/补偿/journal/外部修改保护、1024/1440、键盘/焦点/ARIA、双语运行时和 CCS 截图对照仍未完成。
- 广义 `node --test scripts/*.test.mjs` 为 339/340 通过；已同步 ssh-agent `0.1.7` 断言和 native provider v2 resume fixture，剩余 1 个失败是重构后已删除的 terminalCursorMovement 模块仍被旧测试引用。
- 本轮只更新验收清单、HANDOFF、相关 backend/frontend spec、功能清单和 `[TEMP]` CHANGELOG；未修改函数/类/方法，未执行 commit/push，任务继续保持 `in_progress`。
- 测试基线修正后最终 `GitNexus detect_changes`：unstaged 为 68 files、86 changed symbols、299 affected processes、`critical`；compare master 为 108 files、157 changed symbols、299 affected processes、`critical`。已人工核对主要 provider/Home/scope/terminal/history 触点；索引 FTS 缺失并存在跨模块扩散，不能把 critical 结果解释为低风险。

## 2026-08-04 增量验收

- WSL 状态未改变：`--status` 退出码 50、`--list --quiet` 退出码 1。
- 仅修正两个测试基线断言：ssh-agent 实际版本 `0.1.7`、native v2 provider reference 不持久化派生 Codex profile；两个定向脚本 17/17 通过。
- 广义 Node 测试为 339/340；剩余失败引用 `4511f916` 已删除的 `src/lib/terminalCursorMovement.ts`，不恢复无调用旧模块。
- 未修改生产函数/类/方法，未提交、未推送，Gate 27 仍等待 WSL、真实 Home/UI/macOS 验收。

## 2026-08-04 UI 调整输入

用户基于原生供应商目录截图补充了四项验收要求：

- 导入后的 project/Worktree 修复引用必须显示对应项目或 Worktree 名称，不能只显示 UUID；稳定 ID 保留为辅助诊断信息。
- 导入流程改为由目录 Import 按钮打开的 modal/drawer，不在原生供应商目录永久内嵌完整导入模块。
- 将现有 CLI Home/环境诊断/全局应用区域移到独立的 `CLI Home` 设置 surface，目录主视图只保留入口。
- 供应商列表限制在与详情相同的容器高度内，列表和详情独立滚动；修复截图中详情空白/错位、列表随供应商数量无限增长的问题。

已将上述内容写入 `prd.md`、`design.md`、`implement.md` 和 `acceptance.md` 的 Phase 7/UI criteria；生产实现已完成，真实 UI/WSL/macOS 手动验收仍阻塞。

## 另一台机器的接续提示词

可以直接发送以下内容：

> 继续处理 `D:\github\CLI-Manager\.trellis\tasks\08-02-key`，当前分支是 `feat/native-provider-management`。先阅读 `HANDOFF.md`、`acceptance.md`、`implement.md`、`prd.md`、`design.md` 和相关 `.trellis/spec`，不要回退已有提交，也不要修改或提交用户已有的 `AGENTS.md` / `CLAUDE.md` 改动。当前 Phase 0 和 Phase 1（目录、Key、通用 JSON/TOML、Claude/Codex/Grok 完整文档编辑器）已完成，先做一次 review 和质量校验；然后按顺序继续 Phase 2：CliHomeResolver、Home 诊断、global preview/apply、owner-aware writers、补偿与 journal recovery。每完成一个子项都必须 review，发现问题立即修复并重新验证；前端组件按职责拆分，新增可见文案同步 `zh-CN`/`en-US`。修改函数/类/方法前先运行 GitNexus upstream impact，HIGH/CRITICAL 先停下报告；提交前运行 `detect_changes`。不要运行 dev/build 命令，除非用户明确要求。每个阶段完成后报告剩余阶段，不要把任务标记完成，直到 acceptance gates 全部通过。

## 继续前的最小命令

```powershell
git switch feat/native-provider-management
git pull --ff-only origin feat/native-provider-management
git status --short
npx tsc --noEmit
cd src-tauri
cargo check
cargo test --no-fail-fast
```

## 2026-08-04 UI 调整实现

- `NativeProviderSettingsPage` 新增 `catalog/home` surface；CLI Home 复用
  原有 Home hook/section，只在 Home surface 渲染。
- `NativeProviderCatalog` 的 Import action 打开 modal；导入 section 只在
  modal 打开期间挂载，因此目录不再永久占用导入面板空间。
- 导入修复行通过 `nativeProviderImportDisplay.ts` 从项目 Store 解析项目和
  Worktree 名称；修复命令仍提交稳定 issue/provider ID。新增 Node 回归测试
  覆盖项目、Worktree 与缺失记录 fallback，3/3 通过。
- provider grid 在 `lg` 使用共享 `min(68vh, 760px)` bounded height；目录
  Card 和详情 Stack 各自 `min-h-0`，目录 ScrollArea 与详情 Stack 独立滚动。
- 新增文案已同步 `zh-CN`/`en-US`；i18n parity zh=3428/en=3428。
- 自动验证：`npx tsc --noEmit`、Rust fmt/check/test、`git diff --check` 通过；
  broad Node tests 为 342/343，唯一失败仍是旧 terminal cursor 测试引用已删除模块。
- WSL、Tauri 真实 UI、macOS runtime 仍 BLOCKED；不把静态实现结果替代手动验收。

## 2026-08-04 UI 编辑器与详情布局增量

- 通用配置区改为可折叠 Monaco 编辑器：Claude 使用 JSON 语法模式，Codex/Grok Build 使用 TOML 编辑模式；新增明确的 Validate 动作。TOML 校验调用 `provider_common_config_validate`，只做解析/敏感字段检查，不写数据库；保存仍复用同一验证函数。
- CLI 类型 Tab 已有 Claude/Codex/Grok Build 图标；`供应商目录 / CLI Home` surface 已移动到类型 Tab 上方。
- 详情编辑器、Key 区、完整文档区增加窄屏换行、最小宽度和横向溢出保护；信息卡在窄宽度改单列，详情外层继续独立滚动。
- 影响分析：相关 TSX/Rust 目标的 GitNexus upstream impact 均为 `UNKNOWN / Target not found`，已人工复核调用链；未发现 HIGH/CRITICAL 风险报告。
- 自动检查最新结果：`npx tsc --noEmit`、`cargo fmt --all -- --check`、`cargo check` 通过；Rust 全量 `829 passed / 0 failed / 1 ignored`。未运行 dev/build，未提交或推送。
- i18n parity：zh=3434、en=3434、missing_en=0、extra_en=0；GitNexus 最终 unstaged 为 `111 symbols / 75 files / 0 processes / low`，compare master 为 `170 symbols / 108 files / 0 processes / low`。
- 真实 UI 1024/1440、键盘/焦点/ARIA、双语运行时、WSL 和 macOS runtime 仍是 BLOCKED；任务不能标记完成。
