# 方案评审记录

## 第一轮评审

- 评审代理：两名独立子代理
- 结论：FAIL
- 评审时间：2026-08-16
- 未启动 Trellis task，未创建业务分支，未修改业务代码。

### 主要问题

- OpenCode 事件字段优先级和 `parentID` 位置不够明确。
- root/child 状态机未覆盖子会话先到、乱序、迟到、多根会话、tombstone 和清理。
- Hook 缺少可执行行为测试。
- 历史恢复未明确 `session_id` 与 SQLite locator 的边界。
- OpenCode 参数过滤、Ctrl+V/Ctrl+Shift+V 传播和重复处理边界不完整。
- OpenCode 上下文识别、独立模块生命周期、输入选择状态和 Tauri 剪贴板复用不够明确。
- Windows 路径契约、跨 CLI 自动化矩阵、GitNexus 具体影响对象和手工验收证据不足。

## 第二轮

- 状态：待执行
- 修订文件：`prd.md`、`design.md`、`implement.md`
- 目标：逐项回应第一轮必须修改项；PASS 后才允许 `task.py start`。

## 第二轮评审

- 结论：FAIL
- 两名子代理均确认第一轮大部分问题已补足，但以下项目仍未闭环：
  1. `review.md` 未记录逐项闭环证据；
  2. root 建立条件与 unknown/unresolved 规则冲突；
  3. 子会话“归一发布或丢弃”存在二义性；
  4. `session.deleted` 生命周期未明确；
  5. Windows 路径支持范围和失败行为未形成最终决策；
  6. unresolved child 补齐动作未定义；
  7. 前端 `handleCliHookEvent` 是否防御未确定；
  8. OpenCode CLI 版本/`--help` 兼容性需要写入验收。

## 第三轮修订目标

- 明确只有 root `session.created` 建立新 root；root `session.updated` 仅在已知 root 或无 active root 的受控条件下建立。
- 明确所有 child 事件均不发布状态；`session.deleted` 只清理和写 tombstone，不发送 Hook。
- 明确 unresolved child 补齐要递归更新所有已知后代。
- 明确 Windows 支持 `%USERPROFILE%\.config\opencode` 与 `%USERPROFILE%\.local\share\opencode\opencode.db`，不隐式扫描 APPDATA/LOCALAPPDATA；缺失时返回既有 notInstalled/database_not_found。
- 明确本次不改 `handleCliHookEvent`，新版 Hook 安装是验收前置；若必须防御需重新 impact。
- 明确 `opencode --help`/版本和 Hook status/install 是 Windows 阻断验收项。
- 补充本轮逐项闭环表后再提交第三轮子代理评审。

## 第三轮评审结果

- 评审代理：两名独立子代理
- 结论：PASS
- 评审意见：第二轮提出的全部未闭环项已在最新 `design.md`、`implement.md`、`review.md` 中明确，未发现新的阻断问题。
- 允许进入：`task.py start`、创建功能分支、实施前 GitNexus 影响分析。
- 仍需遵守：任何业务 symbol 修改前先完成对应 impact；实现后代码复核、`detect_changes`、测试和 Windows 手工验收。


## 第三轮评审前闭环对照表

| 第二轮未闭环项 | 修订证据 | 状态 |
|---|---|---|
| `review.md` 无逐项证据 | 本表逐项记录；第三轮结论待代理填写 | 已补记录，待复核 |
| root 建立条件与 unknown 冲突 | `design.md` §2.2 规则 1：仅 `created` 明确建 root；`updated` 仅受控建 root；status/idle/error 不建 root | 已修订 |
| child 事件发布语义二义性 | `design.md` §2.2 规则 2/9：所有 child 事件均不发布 | 已修订 |
| `session.deleted` 生命周期 | `design.md` §2.2 规则 7：child/root tombstone、后代清理、active root 清空、不 post；implement 阶段有 fixture | 已修订 |
| Windows 路径决策不确定 | `design.md` §3：明确 `%USERPROFILE%\.config\opencode`、`%USERPROFILE%\.local\share\opencode\opencode.db`；不扫描 APPDATA/LOCALAPPDATA；缺失返回既有错误 | 已修订 |
| unresolved child 补齐不完整 | `design.md` §2.2 规则 3：递归父链、更新所有已知后代 `rootBySession`、移除 resolved entries；implement 有对应验收 | 已修订 |
| 前端防御是否临时决定 | `design.md` §2.3、implement 阶段 3：本次默认不改 `handleCliHookEvent`，旧插件必须重装；若例外先 impact | 已修订 |
| CLI 兼容性未落到验收 | `design.md` §4、implement 阶段 6：版本、`opencode --help`、`-s/--session`、Windows 启动方式为阻断验收 | 已修订 |

第三轮评审代理需要确认：上述状态机无二义性、路径决策与项目现有行为一致、且任务可以在 PASS 后启动。

## 实施前 GitNexus 影响记录

| Symbol | Upstream impact | Risk | 处理 |
|---|---:|---:|---|
| `plugin_source` | 2（安装命令与现有 Rust 测试） | LOW | 将内嵌 JS 拆为 `include_str!` 资源并增加可执行 Node fixture |
| `buildHistoryResumeCommand` | 5；直接调用者 `HistoryWorkspace.resumeSession` | LOW | 仅新增 `source=opencode` 分支和 OpenCode 参数过滤 |
| `createTerminalCliContext` | 8；影响 `XTermTerminal` 流程 | LOW | 不改变返回结构，只新增独立 OpenCode 判定函数 |
| `XTermTerminal` | 1；直接调用者 `PaneLeafView` | LOW | 仅增加 OpenCode listener 的初始化/cleanup 接入 |
| `handleCliHookEvent` | 索引上游 0，LOW，但结果不视为无风险证明 | LOW | 本次不修改；依赖重装后的 root-only Hook |

未出现 HIGH/CRITICAL 风险。实现完成后仍需执行 `gitnexus detect-changes` 和基线比较。

## 实施后第一轮代码复核

- 评审代理：两名独立子代理
- 结论：FAIL
- 时间：2026-08-17

### 阻塞项与修复

1. **旧根会话迟到事件会覆盖当前根**（`cli-manager-hook.js`）：修复后仅在事件为 `lastRootId` 时发布；根切换后旧根迟到 `session.status/idle/error` 不再 rebind。
   - 已增加测试：`root switching does not let late old-root status rebind the tab`。
2. **删除根后，迟到无 parent 的 child `session.updated` 会被提升为新根**（`cli-manager-hook.js`）：修复后 `observeRootCandidate` 先检查 tombstone；删除根时对已知后代写 tombstone 并清理映射。
   - 已增加测试：`root deletion tombstones descendants so late parent-less child updates cannot become root`。
   - 已增加测试：`deleted root cannot be revived by a late session.updated`。
3. **OpenCode 判定 OR 可能误伤 Codex/Claude/Grok/Pi**（`TerminalCliContext.ts`）：修复后 sessionTool 明确时以其为准；仅在未保存 session 级分类时回退 project/startup。
   - 已增加测试：`explicit sessionTool takes precedence over project/startup OpenCode hints`、`CC/cx/grok/pi contexts never match OpenCode when session classification is explicit`。
4. **规范 `sessionID` 存在但无效时错误回退 `info.id`**（`cli-manager-hook.js`）：修复后仅当 canonical 字段缺失时回退 `info.id`。
   - 已增加测试：`canonical sessionID present but invalid does not fall back to info.id`。
5. **Map 容量/TTL/递归深度不足**（`cli-manager-hook.js`）：增加 `MAX_PARENT_DEPTH`、`rootBySession`/`unresolvedChildren`/`tombstones`/`lastStatus` 统一容量清理，父链解析和后代 rebind 使用 BFS/深度上限。
   - 已增加测试：`parent cycles are bounded ...`、`capacity eviction does not break the active root`。
6. **OpenCode 剪贴板未区分 macOS**（`OpenCodeTuiClipboard.ts`）：新增 `isMac` 并由 `XTermTerminal.tsx` 根据 `osPlatformRef`/`navigator.platform` 传入；macOS 下模块 inert，Ctrl+C 保持原通用语义。
   - 已增加测试：`macOS Ctrl+C and Cmd+C are not intercepted by the OpenCode module`。
7. **测试覆盖不足**：补齐 Hook 乱序/删除/tombstone/环路/容量、OpenCode 上下文跨 CLI 冲突、剪贴板 inactive/hidden/unfocused/dispose/macOS 矩阵；Hook 测试改用每测试独立 bridge/identity。

### GitNexus 变更检测（修复后）

- `npx gitnexus detect-changes --scope all`：12 文件、21 symbols、9 执行流、Risk high。
- `--scope compare --base-ref master`：同上。
- 说明：HIGH 由大型组件 `XTermTerminal` 的调用流触发生成，与实施前 symbol 级 impact（LOW）一致；本次仅新增 OpenCode 专用 listener 的初始化/cleanup 接入，未改共享 keydown 逻辑。最终行为以自动化回归 + Windows 手工验收为准。

## 实施后第二轮代码复核

- 评审代理：两名独立子代理
- 结论：PASS
- 时间：2026-08-17
- 复核要点：
  - 第一轮 7 项阻塞均已闭环（root 迟到事件、tombstone 防 child 升级、OpenCode 判定优先级、canonical 字段回退、容量/深度、macOS 剪贴板、测试覆盖）。
  - 未发现新的阻断项。
  - 第二位评审补充建议：容量测试 ID 合法性注意事项（已在 PASS 前修复为 `ses_filler${i}`）；`lastStatus` 模块级去重在测试间共享属非阻塞；Rust/cargo 环境缺失需在正式环境验证；OpenCode listener 若分类晚于挂载需 Windows 手工验收留意。

### 正式测试验收

- 新增测试：`node --test scripts/opencodeHook.test.mjs scripts/historyResumeCommand.test.mjs scripts/openCodeTuiClipboard.test.mjs` → 23/23 PASS。
- 相关回归：terminalHookBinding、historyResumeProject、agentTerminal、terminalMouseInteraction、terminalNewlineShortcut、resumeCliArgs、cliArgsHistory、terminalCliSession → 49/49 PASS。
- 全量 scripts：436 tests，428 PASS / 8 FAIL；8 个 FAIL 均为既有环境/基线问题（缺失 `src/lib/terminalCursorMovement.ts`、XTermTerminal 快照断言与当前主版本签名不一致、FileEditorPane 等），与本 diff 无关。
- `npx tsc --noEmit`：PASS。
- `npm run build`：PASS。
- `git diff --check`：PASS。
- Rust：`cargo check`/`cargo test` 因环境无 `cargo` 无法执行；变更仅 `opencode_hook.rs` 改用 `include_str!`，需真实 Rust 环境验证。
- GitNexus：
  - `npx gitnexus detect-changes --scope all`：12 files / 21 symbols / 9 flows / Risk high。
  - `--scope compare --base-ref master`：相同结果。
  - HIGH 由 `XTermTerminal` 大型组件触发生成；实施前 symbol 级 impact 为 LOW，本次未改共享 keydown 分支。需 Windows 手工验收最终确认。
