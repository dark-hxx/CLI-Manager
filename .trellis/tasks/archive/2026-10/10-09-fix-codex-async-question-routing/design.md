# Design

## Root cause
错误在进程启动环境边界：Codex 共享 app-server 沿用首个 PTY 的身份，开发版的安装健康门槛又可能阻止覆盖继承自正式版的回调地址。因此同时修复服务选择和新 PTY 环境注入策略，不按焦点或完成状态猜测归属。

## Evidence and rejected fix
- Replay 中 smart-home-assistant 与 jev 的事件都携带正式版首个终端 ID `22478cce-8379-4af0-b54b-54a608d84a42`。
- 共享 Codex server PID 35416（0.162.0）；开发版 Codex PID 8496（CLI 0.161.0）已含 `features.daemon_auto_start=false` 仍串线。该配置只禁止自动启动，仍可连接已有服务；原方案不足，改用 `--no-daemon`。
- 开发版 app PID 30888 与 daemon PID 36032 继承正式版端口 51550，而开发版接收端口为 57768。安装状态比较可执行路径，可在开发版显示 partial；原 shouldEnableHookEnv 仅接受 installed，导致后端不覆盖端口。
- 真实正式版 Hook 可执行文件与两个隔离 loopback 接收器实验中，每端只收到对应环境事件，证明安装路径不决定接收实例。

## Data flow and discovery
- 已检查：terminal commands::prepare_create 为每个 PTY 注入独立 UUID，Windows 环境合并保留显式覆盖；无需修改。
- 修改：projectStartupCommand::withCodexNoDaemon 和 terminalLaunch 启动准备，幂等插入 `--no-daemon`，保留供应商参数、引号内提示文本与 `--`，尊重显式 `--remote`。要求 CLI 支持该参数，不宣称旧版兼容。
- 修改：shouldEnableHookEnv 在任一可配置桥接启用时返回 true，不查询或修复共享安装；全关闭时保留 OpenCode 独立判定及错误日志。
- 已检查：build_codex_status / hook_exe_for_dir 比较安装路径，健康度不适合作为身份注入前提；安装 UI 无需修改。
- 修改：SSH 启动准备也经过相同命令策略；远程环境身份仍由既有 SSH Agent 提供。
- 已检查：hook client 读取进程环境并透传 sessionId；不制造新的会话映射。
- 已检查：resolveCliHookTarget -> handleCliHookEvent 返回同一 tabId 给状态和 App 的 toast/system notification。精确 ID 正确后无需分别补丁。
- 已检查：手动终端输入故意不被重写；自定义包装脚本/显式 --remote 不承诺隔离，文档给出 --no-daemon 操作说明。
- GitNexus query/context/impact 已执行，但 FTS 扩展缺失、目标符号未找到，图风险为 UNKNOWN；定向调用检索表明影响自动终端启动/恢复，手动判断中等风险。

## Scenarios
新建、分屏深层、Workspan、同/不同项目与 Worktree 使用同一源头策略；窗口焦点、托盘、侧栏展示不参与身份选择。Local PowerShell/CMD/pwsh、Git Bash、WSL 使用本地准备，SSH 使用远端准备。桥接启用时 missing/partial/installed 都注入当前实例环境，不将注入视为安装健康；全关闭保留 OpenCode 策略。开发版/正式版可共用安装文件。既有 PTY 不热迁移，必须新建终端；手工启动须自行使用 codex --no-daemon。无持久化/IPC/schema/UI 文案变更。

## Rollback
撤销启动参数与环境策略变更即可；不改 Codex Home 全局配置，不删除服务或历史记录。旧 PTY 环境不会自动刷新。

## Follow-up: realtime stats waiting for the catalog

用户确认通知正常后，截图中 sessionId 为 `01a11ec2-821d-79f1-b047-2fa05225f475` 的统计空白。只读检查真实 rollout：12 条 message、模型 gpt-6-luna、累计 Token 均存在；session_meta 的 id/session_id 与 Hook 相同，history_mode=paginated。开发版日志 11:45/11:46/11:48 开始精确查询后没有 summary，直到全量 catalog 在 11:57 完成才出现其他绑定会话的结果。数据未丢失，瓶颈在查询调度等待全库刷新，而非 --no-daemon 不产生日志。

发现清单：
- [x] TerminalStatsPanel 单飞轮询和 tokensBound：按正确 ID 等待，不改 UI 门控。
- [x] historyRequests::fetchLatestProjectSessionDetail：等待 history_list_sessions，保持精确 ID 和源过滤，不借用最新会话。
- [x] history_list_sessions / session_query / catalog::ensure_refresh：未索引的精确查询进入 wait=true 全量刷新；新增 Codex UUID 直查入口放在 catalog 调度之前。
- [x] codex_lookup：仅枚举来源根中文件名，读取同 ID rollout、核对元数据及项目；缺失/歧义为空，沿用 thread-name overlay。WSL 复用 guest find，SSH 保持既有远端详情入口。
- [x] scanner / session_detail：当前 paginated 日志仍有标准消息、模型及累计 Token 字段，沿用现有解析。
- [x] GitNexus impact(history_list_sessions) 返回 UNKNOWN/未找到；手工核对调用者为统计、预览、回放和历史列表，限制为 source=codex + UUID + limit=1 + offset=0，其他列表/搜索策略不变。

测试覆盖新日志未入 catalog、同项目多会话、ID/项目不匹配、缺失/删除、重复身份和查询适用边界。此变更不改解析语义/缓存内容，不需要提升历史解析缓存版本。
