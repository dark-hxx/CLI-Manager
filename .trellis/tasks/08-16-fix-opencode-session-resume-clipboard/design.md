# 技术设计：OpenCode 会话身份、历史恢复与 TUI 剪贴板

## 1. 根因陈述与评审修订

### D1：Session ID 错误

当前 OpenCode 插件把同一个 `CLI_MANAGER_TAB_ID` 下收到的所有 `session.*` 事件都上报，前端 `handleCliHookEvent` 使用最新的 `payload.sessionId` 更新 `TerminalSession.cliSessionId`。OpenCode 数据库中存在带 `parent_id` 的子会话，子会话与主会话共用终端环境，因此子会话 ID 可以覆盖主会话 ID。

本机只读检查确认：OpenCode DB 有根会话和大量 `parent_id` 子会话；这不是偶发脏数据，而是 OpenCode 正常的 Agent 行为。

**修订后的边界**：不让插件把子会话伪装成根会话；同时不把“未知 session”当作根会话，避免事件乱序时错误绑定。

### D2：历史恢复失败

`cliTools.ts` 已注册 `historySourceId: "opencode"`，但 `historyResumeCommand.ts` 未实现 OpenCode 分支，最终返回 `null`，HistoryWorkspace 因而提示来源不支持。

OpenCode 历史详情使用 `<db-path>#session=<session-id>` locator 定位数据库记录；命令恢复必须只使用 `HistorySessionSummary.session_id`，不能使用 `file_ref.path`。

### D3：OpenCode TUI 剪贴板失败

通用快捷键集中在大型 `XTermTerminal.tsx`。OpenCode TUI 的鼠标报告和输入链路会使选择复制/粘贴需要在通用 xterm handler 之前被专门截获。继续把 OpenCode 特例塞进通用 handler 会扩大其他 CLI 的回归面。

**修订后的边界**：新模块在 OpenCode terminal 容器上安装独立 capture listener；仅在 OpenCode 结构化上下文开启，通用 handler 和鼠标配置不改。

## 2. OpenCode Hook 事件字段与状态机

### 2.1 事件字段契约

当前 OpenCode SDK/事件 fixture 的字段契约：

| 事件 | 会话 ID | 父会话 |
|---|---|---|
| `session.created` | `properties.sessionID`；兼容 `properties.info.id` | `properties.info.parentID`；兼容 `properties.parentID` |
| `session.updated` | `properties.sessionID`；兼容 `properties.info.id` | `properties.info.parentID`；兼容 `properties.parentID` |
| `session.status` | `properties.sessionID` | 无，依赖已知映射 |
| `session.idle` | `properties.sessionID` | 无，依赖已知映射 |
| `session.error` | `properties.sessionID` | 无，依赖已知映射 |

规则：

1. 所有 ID 先 `trim`，拒绝空白、控制字符、含空格的值；历史/恢复命令当前只接受 `^ses_[A-Za-z0-9]+$`。
2. `session.created/updated` 优先规范字段 `properties.sessionID`；只有规范字段缺失时才回退 `properties.info.id`，且回退值必须满足同一 ID 校验。
3. `parentID` 优先 `properties.info.parentID`，再兼容 `properties.parentID`。
4. `session.status/idle/error` 只接受 `properties.sessionID`，不从 status/info 推导。
5. 如果规范字段与兼容字段同时存在但不一致，记录诊断并使用规范字段；不得用兼容字段覆盖。

### 2.2 可执行状态机

将纯逻辑拆为可测试的 `OpenCodeSessionIdentity`（可位于 Rust 单元测试可调用的 helper，或生成插件源代码时对应的 JS 纯函数），接口至少为：

```text
observeSessionInfo(sessionId, parentId, now) -> RootObservation
resolveEventSession(sessionId, eventKind, now) -> RootResolution
forgetSession(sessionId, now) -> void
```

内部状态：

- `parentBySession: childId -> parentId`
- `rootBySession: sessionId -> rootId`
- `unresolvedChildren: childId -> { parentId, firstSeenAt, lastSeenAt }`
- `tombstones: sessionId -> expiresAt`，只用于已确认的子会话/已结束会话，防止迟到事件复活为根会话
- `lastRootId` 与 `lastActivityAt`，用于同一终端内合法新根会话切换

规则：

1. **建立根会话的唯一入口**：`session.created` 且 `parentID` 缺失/为空时注册 `rootBySession[id]=id`，允许发布该根事件并更新 `lastRootId`。`session.updated` 缺少 parent 时，只有当 ID 已经是已知 root，或当前没有 active root 且该 ID此前没有 unresolved/child 记录时，才建立 root；否则标记 unknown，不切换 `lastRootId`。`session.status/idle/error` 永远不能建立 root。
2. **子会话**：`parentID` 存在时注册父关系；若父关系已知，递归追溯到 root 并将 child 映射到 root。子会话的 `created/updated/status/idle/error` 全部不发布状态 Hook（不把子 Agent 忙闲状态冒充主会话），只更新内部映射和生命周期；绝不发布 child ID 或 root 替代事件。
3. **子会话先到**：先保存 unresolved child，不发布任何事件；待父会话信息到达后执行补齐：递归解析父链、设置 child 及所有已知后代的 `rootBySession`、删除已解析的 unresolved entries、保留 child tombstone。父链仍未知时继续不发布；状态事件如果没有已知映射，保持未解析并丢弃，不把自身当 root。
4. **多级子会话**：递归追溯，设置最大深度（例如 16）；检测环时记录诊断并丢弃，不发布。
5. **迟到事件**：已确认 child 的映射和 tombstone 在短保留窗口内保留，迟到的 child 事件仍不发布；未知且已过期的 ID 不得覆盖已有 root。
6. **多根会话**：收到明确无 parent 的新 `session.created` 时，视为 OpenCode 主会话切换，允许更新 `lastRootId` 并发布新 root 的 SessionStart；已知 root 的 `session.updated/status/idle/error` 只更新/发布该 root；child、unknown、unresolved 不切换。
7. **`session.deleted`**：不映射为状态事件、不调用 `post`。删除 child 时写入 child tombstone 并清理其 unresolved 状态，保留 parent/root 映射至 TTL；删除 root 时写入 root tombstone、清理该 root 的后代映射，并仅当它等于 `lastRootId` 时清空 active root。
8. **清理**：子会话在 idle/error/deleted 后保留映射至少 5 分钟；Map 总量设置上限（例如 1024）并优先淘汰已过期 tombstone。根会话不因单个子事件清除；插件进程结束时自然释放。
9. **发布**：只有已确认根会话的 `session.created/updated/status/idle/error` 调用 `post`；子会话、deleted、`unknown|unresolved|cycle` 均不调用 `post`。

### 2.3 前端边界

优先在 Hook Bridge 完成归一化。对 `handleCliHookEvent` 仅做影响分析，不默认修改通用 rebind。若实现中必须加防御，规则必须严格限定为 `payload.source === "opencode"`，且只阻止未知/不合法 ID，不改变 Claude/Codex/Grok/Pi。

## 3. OpenCode Windows 路径契约

本次确定支持的路径契约如下，不迁移用户数据：

- **Hook 配置目录**：若设置了绝对路径 `XDG_CONFIG_HOME`，使用 `${XDG_CONFIG_HOME}/opencode/plugins/cli-manager-hook.js`；否则使用当前用户 Home 下 `.config/opencode/plugins/cli-manager-hook.js`。Windows 由 `HOME` 优先、`USERPROFILE` 回退；当前用户实际配置根为 `%USERPROFILE%\.config\opencode`。
- **历史 DB**：使用同一用户 Home 下 `.local/share/opencode/opencode.db`；当前 Windows 实际数据根为 `%USERPROFILE%\.local\share\opencode\opencode.db`。本次不改为 `%APPDATA%` 或 `%LOCALAPPDATA%`，也不自动扫描多个数据库，避免 Hook 与历史读取落到不同用户/实例。
- **失败行为**：Hook 目录不存在时 `status=notInstalled`，安装按既有流程创建目录；DB 不存在时历史来源返回空/`opencode_database_not_found`，不得猜测另一个数据目录。若两处 Home 根不一致，分别在 status/历史错误中保留实际路径，阻断“看似成功但绑定另一实例”的隐式行为。
- **实现前路径测试**：用纯 resolver 测试 `XDG_CONFIG_HOME`、`HOME`、`USERPROFILE` 优先级；覆盖 Windows 盘符、反斜杠、空格目录、大小写差异、locator `#session=`。
- 本机规划证据：已读取 `%USERPROFILE%\.local\share\opencode\opencode.db`，其 session 行使用 `ses_...` ID；Windows 手工验收必须记录 `opencode --version` 和 Hook status/install 的返回路径。

## 4. 历史恢复设计

- `buildHistoryResumeCommand` 入口只接收 `session_id` 与 `source`，不接收 locator。
- OpenCode ID 规范化：`^ses_[A-Za-z0-9]+$`；无效、带路径、带 `#session=`、带空格均返回 `null`。当前可用 OpenCode CLI 帮助验证 `-s, --session` 为“session id to continue”；Windows 验收仍必须实际执行对应版本的 `opencode --help`。
- 基础命令：`opencode --session <validatedId>`。
- 项目没有自定义 `startup_cmd` 且来源确实是 OpenCode 时，追加经过 OpenCode 专用过滤器的 `cli_args`。
- 过滤以下形态并删除相应值：`--session value`、`--session=value`、`-s value`、`-s=value`、`--continue`、`-c`、`--fork`；支持引号 token 和参数出现在任意位置。`--fork` 本次始终删除，因为历史“继续对话”语义必须恢复原会话，不应隐式创建 fork；未来如提供明确 fork 按钮另行建模。
- 不应用 Claude/Codex/Grok provider override 拼接；Windows 下 `opencode`/`opencode.cmd` 由既有 shell 解析和项目启动流程处理，不在 builder 中硬编码扩展名。

## 5. OpenCode TUI 剪贴板设计

### 5.1 稳定上下文

新增 `isOpenCodeTerminalContext(context)`，优先级严格为：

1. `sessionTool === "opencode"`；
2. `projectTool === "opencode"`；
3. 启动命令首个可执行 token 是 `opencode`/`opencode.cmd`/`opencode.exe`，允许 PowerShell `&`、引号、绝对路径和后续参数；
4. 不使用标题作为主要判定来源；若保留 title 兼容，只允许 title 的结构化尾缀等于 `opencode`，并且不能覆盖明确的非 OpenCode `sessionTool/projectTool`。

普通字符串包含 `opencode`、CC/CX、Claude、Codex、Grok、Pi 不得误判。

### 5.2 独立模块接口和生命周期

新增 `src/terminal/browser/OpenCodeTuiClipboard.ts`，提供：

```ts
attachOpenCodeTuiClipboard(options: {
  container: HTMLElement;
  terminal: Terminal;
  sessionId: string;
  isActive: () => boolean;
  hasInputFocus: () => boolean;
  readClipboardText: () => Promise<string>;
  pasteText: (text: string) => void;
  wrapMultilinePaste: (text: string) => string;
  copyText: (text: string) => Promise<void>;
  clearInputSelection: () => void;
  focusTerminal: () => void;
  logError: (message: string, error: unknown) => void;
}): { dispose(): void }
```

- 接入点只是在终端初始化完成后调用一次；由初始化 effect 的 cleanup 调用 `dispose()`。
- 当 terminal/session/container 改变时先 cleanup 再安装；OpenCode 判断为 false 时不安装。
- 只在当前终端 active、可见、输入焦点位于该终端 xterm textarea/container 时处理；搜索框、右键菜单、后台 pane 不拦截。
- `keydown` capture 规则：
  - Ctrl+C 且有 `terminal.hasSelection()`：读取 selection；调用既有 `copyTextToClipboard`；成功后 `terminal.clearSelection()`、调用 `clearInputSelection()`、保持焦点；`preventDefault()` + `stopPropagation()` + 必要时 `stopImmediatePropagation()`，不让 xterm/PTY 收到中断。
  - Ctrl+C 无 selection：不拦截，通用 handler 发送 ``。
  - Ctrl+V：capture 拦截，读取现有 `readClipboardPasteText()`；非空才调用 `pasteText()`；失败记录日志，不向 PTY 写空值；阻止后续 handler，避免双重粘贴。
  - Ctrl+Shift+V：同样 capture 拦截，但粘贴前调用既有 `wrapTerminalPasteTextForCtrlShiftV`；不依赖额外 browser `paste` 事件，避免重复处理。
  - Shift/Alt/Meta 或非 Windows Ctrl 组合不被该模块拦截；Ctrl+C 复制仅使用 Windows/非 Mac 语义。
- 复用现有 Tauri clipboard abstraction 和 `useTerminalInput` 的读取/粘贴函数；不直接读写 `navigator.clipboard`，不调整 `mouseEventsRequireAlt`。

## 6. 兼容性与影响分析要求

| 变更 | 影响范围 | 风险 | 控制措施 |
|---|---|---:|---|
| OpenCode plugin root mapping | OpenCode Hook/实时状态/Session ID | 中 | 可执行 JS fixture、子会话乱序测试、仅 source=opencode |
| OpenCode resume builder | HistoryWorkspace、终端创建 | 低 | locator/id 边界测试、完整参数过滤测试 |
| OpenCode context/helper | TerminalCliContext、OpenCode listener | 低 | 明确 token 测试、其他 CLI false 矩阵 |
| 独立 clipboard listener | 当前 OpenCode PTY | 中 | capture 传播测试、生命周期 dispose、其他 CLI 不挂载 |

## 7. 验证策略

### 自动化

- Hook：执行生成插件的 JS 或测试拆出的纯函数，fixture 覆盖 created/updated/status/idle/error、根/子/多级子、子先到、乱序、迟到、未知、环、多个根。
- History：覆盖真实 `ses_...`、locator、路径、`#session=`、空格/控制字符和所有参数形态。
- Context/clipboard：OpenCode 启用；Claude/Codex/Grok/CC/CX/Pi 未启用；按键矩阵和 dispose。
- TypeScript/Rust/已有脚本测试。

### Windows 手工证据

记录：Windows 版本、OpenCode CLI 版本、启动方式（PowerShell/cmd/.cmd/绝对路径）、Hook 安装/重装结果、是否 TUI 鼠标报告、主/子事件样例、顶部 root Session ID、历史 `ses_...` ID、实际恢复命令、Ctrl+C 有/无选择结果、Ctrl+V/Shift+V 多行结果，以及 Claude/Codex/Grok/CC/CX/Pi 回归结果。
