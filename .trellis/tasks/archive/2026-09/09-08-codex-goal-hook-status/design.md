# Design: Codex Goal Hook 状态与通知收口

## 1. 根因与目标

当前链路把 `Stop` 当作整段对话完成事件：Hook 客户端将每次 Codex `Stop` 发送到本地 daemon，前端 `mapCliHookEvent` 将每个 `Stop` 映射为 `done`，`App` 再同时触发 Tab 状态、任务栏、Toast 和系统通知。Codex `/goal` 的每个 autonomous continuation turn 都会产生一次 `Stop`，所以中间阶段被错误地当成完成。

修复原则是把“回合结束”和“目标完成”分开：Hook 收到 Codex `Stop` 后，用 `session_id` 查询 Codex 的 `thread_goals`；只有查询得到 `complete`，或者成功确认没有 goal 行的普通 Codex turn，才能继续使用完成语义。任何仍可能有后续工作的状态或不确定状态，都不能进入绿色完成分支。

## 2. 统一的 goal 状态契约

载荷新增两个可选字段：

- `goalStatus`: `none`、`active`、`paused`、`blocked`、`budgetLimited`、`usageLimited`、`complete` 或 `unknown`。
- `goalId`: 经过长度与字符校验的 goal 标识，仅用于跨层关联和去重，不用于展示。

字段语义：

| `goalStatus` | 来源/含义 | Tab 状态 | 完成型通知 |
| --- | --- | --- | --- |
| `none` | 数据库查询成功且 `thread_goals` 没有该 session | `done` | 保持普通 Stop 行为 |
| `active` | goal 仍在执行 | `running` | 抑制 |
| `paused` | goal 暂停 | `attention` | 不发送完成通知 |
| `blocked` | goal 被阻塞、等待外部条件 | `attention` | 不发送完成通知 |
| `budgetLimited` / `usageLimited` | 触达限制，非成功完成 | `failed` | 发送一次非成功通知（若现有设置允许） |
| `complete` | goal 真正完成 | `done` | 发送一次 |
| `unknown` | 缺少 session、数据库不可读、schema/字段异常、超时或非法状态 | `running` | 抑制 |
| 缺失 | 旧载荷；非 Codex 沿用旧逻辑，Codex `Stop` 按未知处理 | `running`（Codex Stop） | 抑制（Codex Stop） |

数据库中的 snake_case 值（如 `usage_limited`、`budget_limited`）在边界处规范化为上述 camelCase 值；未知字符串不猜测为完成，统一为 `unknown`。`StopFailure` 始终优先表示 `failed`，不被 goal 状态改写成成功。

## 3. 数据流与职责

```text
Codex Stop stdin
  -> hook client: 规范化 session_id
  -> Codex goal adapter: 只读查询 goals_1.sqlite / state_5.sqlite
  -> Hook JSON: goalStatus + goalId
  -> HTTP bridge / daemon / SSH spool
  -> 统一 Hook decision
       -> Tab reducer: running/attention/failed/done
       -> App sinks: taskbar/Toast/system（仅允许的终态）
       -> third-party dispatcher / remote handoff
```

Hook 客户端负责取得事实，消费端负责按同一契约解释事实。这样既能让无前台 Tab 的 daemon 和第三方通知走相同规则，也不会把“查询失败”重新降级成 `Stop -> done`。

## 4. Codex 数据库适配器

新增一个职责隔离的 Codex 专用适配模块（建议 `src-tauri/src/features/hooks/codex_goal.rs`），不把查询逻辑塞进通用 Hook schema 或历史会话模块。对外提供纯粹的查询结果：`NoGoal`、`Known { goal_id, status }`、`Unknown { code }`。

### 路径和版本兼容

候选根目录按以下优先级解析并去重：

1. `CODEX_SQLITE_HOME`；
2. 当前 Codex 配置中的 `sqlite_home`；
3. `CODEX_HOME`；
4. Codex 默认目录及项目已有的 Codex 配置路径解析结果。

每个根目录优先检查当前布局 `sqlite/goals_1.sqlite`，再检查同根的 `goals_1.sqlite`，最后才检查旧版 `state_5.sqlite`。高优先级当前数据库已经存在但不可读时返回 `Unknown`，不使用可能过期的低优先级数据库冒险猜测；只有候选文件不存在时才继续下一个布局。找到可读且含 `thread_goals` 表的数据库后，即使没有匹配行也返回 `NoGoal`，不再回退到旧数据库。

查询使用参数绑定的 `thread_id = session_id`，只选择 `goal_id` 和 `status`，并使用 `create_if_missing(false)`、SQLite read-only 连接、`query_only`/短 `busy_timeout` 和总超时。Hook 进程不能因为数据库锁、损坏、schema 变化或查询超时阻塞 Codex；查询失败只产生脱敏诊断码并返回 `Unknown`，Hook 投递仍保持 fail-open。

### WSL 与 SSH

- Windows 进程不直接通过 `\\wsl$`/UNC 打开 WSL 的 SQLite WAL 文件。WSL 能提供同环境查询通道时，沿用项目的外部 SQLite 规约：在对应发行版内用固定参数调用 Python `sqlite3.Connection.backup` 生成一次性 Windows 临时快照，再用同一个 SQLx 只读查询适配器读取并清理快照；`wsl.exe`、Python、路径转换或快照步骤不可用时返回 `Unknown`。禁止把路径拼接进 shell 字符串。
- SSH Hook 不在本机尝试查询远端 session。远端生成的 Hook spool 若已经带有经过同样规范化的 `goalStatus`/`goalId`，保留并消费；缺失时按 Codex `unknown` 处理，宁可不发完成也不猜测完成。

## 5. 跨层载荷与状态消费

### Hook 接收和 daemon

`ClaudeHookRequest`、`ClaudeHookPayload`、远端 spool 转换和 `to_notification_job` 增加可选 goal 字段，并继续执行现有长度、控制字符和来源校验。普通 CLI 载荷不改变。

daemon 的 `update_task_status_from_hook` 与前端使用同一张映射表：Codex goal 的中间 `Stop` 写入 `running`，暂停/阻塞写入 `attention`，限制写入 `failed`，只有 `complete` 或明确 `none` 写入 `done`。为防止乱序事件，按 session/goal 记录当前 goal 生命周期：同一 goal 进入 `complete` 或限制终态后，迟到的 `active`/重复终态不能回退或再次升级状态。

### 前端 Tab 状态

在 `src/features/terminal/lib` 增加面向 `CliHookPayload` 的纯决策函数，统一返回：有效 Tab 状态、是否为 goal、是否是允许完成的终态、去重键和是否应抑制完成 sink。保留 `mapCliHookEvent` 作为普通事件兼容入口，但 `terminalRuntime` 必须使用带 payload 的决策结果。

`active` 和 `unknown` 的 Stop 按 `running` 处理：保留运行中的 Hook 超时和 PTY 活动，不清理运行态输出，不触发 done 清理逻辑。`complete`/`none` 才可复用现有完成清理；`paused`/`blocked` 进入 attention；限制和 `StopFailure` 进入 failed。已有的时间戳乱序防御继续生效，并补充同一 goal 的终态单调性防护。

### App 通知出口

`App` 在调用任务栏、Toast 和系统通知前使用同一决策结果。Codex goal 的 `active`/`unknown` Stop 三类完成出口全部静默；`paused`/`blocked` 只保留关注语义；限制复用现有失败语义；`complete` 仅首次通过完成门。

完成门使用 `tabId/sessionId + goalId` 作为主键；goal id 缺失时仅对明确的 Codex goal `complete` 使用 session 级短期兜底键。普通 Codex `none` Stop 不共享该去重键，避免影响普通多回合通知。缓存有容量/TTL 上限，Tab 销毁或新 goal id 到来时可释放，不能无限增长。

### 第三方和远端接管通知

`HookNotificationJob` 携带 session/goal 字段。第三方 dispatcher 在构造消息前过滤 Codex goal 的 `active`/`unknown`，并对 complete/限制终态做有界的一次性去重；Claude、其他 CLI 和普通 Codex `none` 事件保持现有规则。远端 handoff scheduler 同样只将 `complete`（或 `none`）视为完成，将 active/unknown 留在运行阶段，将 paused/blocked 留在关注阶段，将限制视为失败阶段。

## 6. 兼容性、失败策略和安全边界

- 不改变 Codex 原生 Hook 配置、SQLite schema、IPC 命令签名或数据库写入行为。
- 非 Codex 事件完全沿用现有映射；Codex 非 goal 的 `Stop` 只有在适配器成功返回 `none` 时才恢复旧的绿色完成语义。
- 缺少 `sessionId`、字段非法、数据库路径不可信、数据库不存在且无法确认能力、schema 不匹配、锁等待或 WSL/SSH 查询不可用均返回 `unknown`，禁止成功完成。
- 日志只记录固定诊断码、来源和是否命中，不记录完整路径、goal 内容、session 原文或 token；对 goal id 做长度/字符限制。
- 本次不新增用户可见文本和翻译键；若实现阶段发现限制/暂停需要新的可区分文案，先补齐 `zh-CN`/`en-US` 再接入。

## 7. 影响范围和验证重点

主要触点为：

- Rust Hook client / Codex goal adapter / hook schema boundary；
- `ClaudeHookRequest`、`ClaudeHookPayload`、remote spool 和 notification job；
- daemon task-status mapper、third-party dispatcher、remote handoff scheduler；
- `CliHookPayload`、terminal status decision、`terminalRuntime`、`App` notification sinks；
- 对应 Rust/TypeScript 定向测试和 `V1.4.0` 变更记录。

GitNexus MCP 在当前会话不可用，因此实施时以已读契约、符号级 `rg` 调用链、逐批编译/测试和最终 diff 范围审查替代；不把未执行的 GitNexus 结果当作风险结论。

验证必须覆盖：普通 turn、中间 active、complete、paused、blocked、budget/usage limit、unknown、重复/乱序、旧版 state DB、当前 goals DB、DB 锁/缺失、WSL/SSH 降级，以及其他 CLI 不回归。
