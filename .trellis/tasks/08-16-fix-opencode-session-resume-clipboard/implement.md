# 实施计划

> 评审门禁：当前第一轮子代理评审为 FAIL。以下计划修订完成后必须再次由子代理评审；只有 PASS 后才允许 `task.py start`、创建分支和修改业务代码。

## 阶段 1：第二轮方案评审前

- [x] 固化三项根因、locator/session ID 边界、Windows 路径契约和 OpenCode 专用剪贴板边界。
- [x] 补足事件字段优先级、root/child 状态机、乱序/tombstone/多根会话规则。
- [x] 补足跨 CLI、自动化 Hook 行为测试和 Windows 手工证据清单。
- [x] 将本次评审 FAIL 与修订摘要写入 `review.md`，提交第二轮子代理评审。
- [x] 第二轮 PASS 后，执行 `python3 .trellis/scripts/task.py start .trellis/tasks/08-16-fix-opencode-session-resume-clipboard`。
- [x] 仅在 PASS 后创建 `fix/opencode-session-resume-clipboard` 分支。

## 阶段 2：实施前 GitNexus 影响分析

在修改每个现有 symbol 前执行并记录 `npx gitnexus impact <symbol> --direction upstream`；HIGH/CRITICAL 必须暂停并重新设计。候选清单：

- `plugin_source`
- `sessionIdOf`（若被拆为纯函数）
- `mappedEvent`
- `post`
- `handleCliHookEvent`
- `resolveCliSessionRebind`
- `buildHistoryResumeCommand`
- `appendResumeCliArgs`（仅在实际修改时）
- `createTerminalCliContext`
- 新增 `isOpenCodeTerminalContext`
- `attachPasteAndDrop` / `readClipboardPasteText`（仅在实际修改时）
- `XTermTerminal` 的初始化 effect/接入点

同时记录每项 direct callers、affected processes、risk；不凭“索引无上游”推断无影响。

## 阶段 3：OpenCode Session ID 根因修复

- [x] 将 Hook Bridge 的会话身份逻辑拆为可测试纯函数或提供可执行 JS fixture harness（`createOpenCodeSessionIdentity`）。
- [x] 按事件类型实现 `sessionID`/`info.id` 和 `parentID` 字段优先级。
- [x] 实现 child→parent→root 递归映射、最大深度/环检测、unresolved child、tombstone/TTL、Map 上限；父信息到达后遍历所有已知后代，递归更新 `rootBySession` 并移除已解析 unresolved entries。
- [x] 根会话事件允许切换当前 root；子会话、未知或未解析事件不得覆盖已有 root；明确 `session.updated` 缺 parent 只能按设计中的受控条件建立 root。
- [x] 保持已有 `SessionStart/UserPromptSubmit/Stop/StopFailure` 映射和 payload 格式；只对 OpenCode 来源生效。
- [ ] 增加根/子/多级/乱序/迟到/未知/多根 fixture；验证最终发送的只可能是已确认 root ID。
- [ ] 增加 `session.deleted` fixture：child/root 分别写 tombstone、清理后代/active root，不发布状态 Hook。
- [x] `handleCliHookEvent` 本次默认不修改：依赖新版 Hook Bridge 的 root-only 发布；对旧版插件/未知 OpenCode ID 的行为以“必须先重装 Hook”作为 Windows 前置条件。若实现发现旧插件兼容必须加 OpenCode 限定拒绝规则，先重新执行 impact 并补充验收，不临时改变通用 rebind。

## 阶段 4：OpenCode 历史恢复

- [x] 在 `buildHistoryResumeCommand` 前执行 impact，增加 OpenCode 分支。
- [x] 只使用 `session.session_id`；`file_ref.path` 和 `<db>#session=<id>` 不进入 command builder。
- [x] 实现 `^ses_[A-Za-z0-9]+$` 校验和 `opencode --session <id>`。
- [ ] 实现并测试 `--session value`, `--session=value`, `-s value`, `-s=value`, `--continue`, `-c`, `--fork`、引号和任意位置过滤；明确始终移除 `--fork`。
- [ ] 验证项目 CWD、`opencode`/`opencode.cmd` 由现有 shell 启动流程处理，不改变其他 CLI 的 command builder。

## 阶段 5：OpenCode TUI 专用剪贴板

- [x] 对 `createTerminalCliContext` 及新 `isOpenCodeTerminalContext` 执行 impact。
- [x] 新增 `src/terminal/browser/OpenCodeTuiClipboard.ts`，只复用既有 clipboard/read/paste/wrap 抽象。
- [x] 用 capture listener 接入：安装、卸载、session/terminal 切换、active/focus 保护必须有测试。
- [x] Ctrl+C 有 selection：copy→清理 xterm selection→清理 input selection→focus；失败不发送中断。
- [x] Ctrl+C 无 selection：不拦截，继续通用 PTY interrupt。
- [x] Ctrl+V：复用 `readClipboardPasteText`，空值不写入；Ctrl+Shift+V 复用 `wrapTerminalPasteTextForCtrlShiftV`；阻止重复事件。
- [x] XTermTerminal 只增加最小接入，不修改通用 keyboard branch、鼠标报告和其他 CLI 逻辑。
- [x] OpenCode/Claude/Codex/Grok/CC/CX/Pi context 与 listener active 矩阵测试。

## 阶段 6：代码复核、测试和 Windows 验收

- [x] 由主代理逐文件复核实现：根因是否闭环、是否误伤其他 CLI、是否引入路径/异步/焦点回归。
- [x] 运行 `npx gitnexus detect-changes` 和比较基线的变更检测，结果已写入 `review.md`。
- [x] 运行 `npx tsc --noEmit`、新增测试、相关回归、`npm run build`；`cargo check/test` 因环境缺 cargo 未执行（记录在 review.md）。
- [ ] OpenCode Windows 手工验收：记录 Windows/OpenCode 版本、`opencode --help` 中 `-s/--session` 结果、Hook 重装返回的配置路径、root/child 事件、顶部 ID、历史命令、三种快捷键及其他 CLI 回归；Linux 容器测试不能替代此项。
- [x] 实际更新 `CHANGELOG.md` 的 `1.3.7` 章节和 `docs/功能清单.md` 正确功能板块。
- [ ] 只有代码复核和测试验收通过后，才整理 PR 提交信息；不自动 push。

## 回滚点

- Session ID：回滚 OpenCode plugin root mapping 与对应 fixture。
- 历史恢复：回滚 OpenCode command builder 分支，不影响其他来源。
- 剪贴板：移除独立 listener 接入即可恢复原通用路径。
