# 根因与发现清单

## 根因陈述

实时 Codex 读取在主机的日志定位层复用了可能失效的历史目录快照及不会淘汰消失文件的定位缓存，Tap 的请求层又只在轮询回调内检查期限，导致旧路径不可读或 HTTP 挂起时后续对话刷新无法推进；修复分别落在精确定位/缓存生命周期和请求期限的生产层。

## 已确认的复现证据

- 两个新 Rust 定向测试在修改生产实现前失败：同 UUID 的日志在来源目录内移动后返回 `session_file_not_found`；冷实时读取建立了全局目录缓存。
- 两个新 Node 定向测试在修改生产实现前失败：创建或轮询 HTTP 不返回，虚拟时钟经过 60 秒后请求仍未释放。
- 增加真实 Conversation + operation runner 集成回归：首个请求挂起，到期后现有单请求尾随刷新读取已结束回合的回复，验证迟到结果隔离。
- 读取本机持久化元数据及当天 Codex 日志的字段统计，确认存在已绑定 UUID、正确来源根和规范 `response_item` 消息；未复制用户对话内容。本机 Web DB 的 transcript 记录较旧，不能用作用户当前空白页面的运行时复现证据。
- 以上确认了能够造成该症状的故障机制；未取得用户当次浏览器请求现场，不宣称已唯一确定该次偶发问题的触发条件。

## 发现清单

| 触点 | 结论 |
| --- | --- |
| `live_transcript.rs::locate` | 修改：Codex 使用即时精确文件名查找，绕过目录快照及无关日志正文 |
| `live_transcript.rs::read` / `cached_entry` / `evict_entry` | 修改：缓存文件消失或旧读失败时按 Arc 身份淘汰，保留并发替代条目；重新定位，metadata I/O 在缓存锁外 |
| `codex_lookup.rs::rollout_candidates` | 复用：仅放宽域内可见性，共享已有原生/WSL UUID 文件查找，保留不跟随链接规则 |
| `operations.ts::createOperationRunner` | 修改：独立 60 秒定时期限覆盖 HTTP 自身，完成/取消时清理两类 timer |
| `Conversation.tsx` / `transcript.test.mjs` | Conversation 实现确认无关：已有单请求、尾随刷新及 5 秒 probe；新增集成测试验证释放后恢复 |
| `webManagement.ts::executeTerminalTranscript` | 确认无关：精确 PTY、来源、cwd 与异步后身份复核保留 |
| `live_transcript_reader.rs` / projection / message parser | 确认无关：规范消息、预算、epoch 和身份/cwd 校验保留 |
| `terminalRuntime.ts` / `terminalHookBinding.ts` / Hook schema | 确认无关：当前规范 session_id 可绑定；不从焦点或同目录最新会话猜测身份 |
| `useWorkspace.ts` / `SessionView.tsx` / device capability | 确认无关：旧宿主不会新增全量历史连续轮询，账号/设备/终端隔离保留 |
| PTY / input / permissions / server protocol / migrations | 确认无关：不改变命令提交、终端输出 ACK、审批、协议字段或数据库结构 |
| CHANGELOG / 功能清单 / Web 契约 | 更新 V1.5.1 记录及已确认的精确定位和请求期限边界 |

## 场景边界

- 本地及 WSL 共用已有精确 UUID locator；WSL 传入原始 UNC 来源根，避免 canonical 前缀破坏 guest find 识别。
- 多会话、分屏、Worktree 继续以既有 PTY / CLI ID / cwd / roots 缓存键隔离；未安装 Hook 的未绑定会话仍返回真实 unbound。
- 浏览器隐藏/终端模式停止既有可见 probe；恢复后读当前来源。旧宿主保持事件触发读取；到期不重放输入或管理操作。
- 桌面焦点、最小化、侧栏形态及 focus-mode 不参与日志定位；SSH/remote handoff 延续现有不支持边界。
- 没有新增或修改用户可见文案；沿用已有中英文错误/重试提示和 24 小时时制。

## GitNexus 分析

- 仓库 CLI-Manager，索引对应起始提交 `3f60be77`（2026-11-15）。MCP 存储版本不兼容，CLI FTS 不可用；CLI 精确 context/impact 可用。
- `locate`：LOW，直接调用者 `read`，上游两个 transcript IPC 入口；无索引 execution process。
- `rollout_candidates`：LOW，直接调用者 `find_bound_codex_session`，影响 History 查询流程；修改仅域内可见性和说明。
- `createOperationRunner`：LOW，直接调用者 `useWorkspace`，影响 Tap App 操作流程。
- `read`：LOW/lower-bound，直接调用者原生 transcript IPC；图谱提示同名 read 的动态接收者缺口。已结合领域契约和限定源码核对真实入口，未把缺失边当作无调用。
- 新增 `cached_entry` 的 impact 返回 UNKNOWN/not-found（旧索引未包含新函数）；已通过限定源码确认产品调用者仅为 `read`，并用新增缓存生命周期及并发替代测试验证，未把 UNKNOWN 当作低风险结论。
- 未进行 Git 提交或同步。

## 追加需求：Skill 补全

### 原因与实现边界

旧 Composer 在输入斜杠前缀时直接调用终端 command 并清空草稿，SessionView 又在斜杠发送成功后显示原生面板；两处输入/展示策略均须移除，Skill 发现放在现有主机只读诊断边界，不通过键盘模拟菜单或浏览器扫描文件。

### 发现清单

| 触点 | 结论 |
| --- | --- |
| Composer / SessionView | 移除自动 PTY 前缀写入与斜杠发送后的原生面板/焦点切换；保留手动终端入口与原提交路径 |
| completion / useComposerCompletion / ComposerCompletion | 本地 Skill 候选、CLI 调用语法、30s 内存目录、限定替换、键盘/IME 与旧结果隔离；`@` 路径保持 |
| webManagement / webTerminalSkills | 新增只读 `terminal.skills`，复用注册 PTY 上下文和 Agent 诊断；异步后复核绑定与根，仅读取候选元数据 |
| Agent diagnostics / WSL resolver | Codex 反馈后补修配置根来源、符号链接/Junction 及 WSL find 选项；保持原 IPC 契约和 MCP 探测，不启动 MCP/CLI |
| server api / desktop & helper capability | 允许新读操作及能力名，保留设备所有权、手机范围与管理确认规则 |
| Terminal / input / PTY / permissions / Hook / migrations | 确认无关：手动原生交互、字节提交、权限和身份生产保持；不改数据库或帧结构 |
| i18n / tests / CHANGELOG / 功能清单 / Tap README / Web 契约 | 更新中英文提示、替换旧原生菜单断言、增加前后端行为回归、操作说明及 V1.5.1 记录 |

### 影响分析

- Composer/补全入口为 LOW，上游为 SessionView；Web 管理校验/执行为 LOW，上游为 WebDeviceBridge 的 executeOperation；server 校验/能力映射为 LOW，上游为 create_operation。
- SessionView/openCommand/returnToChat 返回 UNKNOWN：限定文本确认 App 的 lazy 加载以及 Composer 回调/按钮调用，未将空边当作无人使用。
- desktop default_capabilities 为 MEDIUM（21 个上游）；helper default_capabilities 为 CRITICAL（13 个上游，包含请求处理及启动流程），已在修改前告知。两处仅增加 `terminal.skills` 字符串，跨层类型/Rust 检查验证兼容性。
- 新增 executeTerminalSkills 未进入起始索引，impact 为 UNKNOWN；已确认唯一生产调用者为 webManagement dispatcher，并用执行生产模块的 fixture 验证校验、只读投影、WSL 和迟到结果隔离。

## Codex Skill 漏识别反馈

### 根因与证据

Skill 发现的配置根未沿用当前会话/执行环境的 `CODEX_HOME`，共享扫描器又跳过目录符号链接，导致自定义 Codex Home 中的链接 Skill 被漏读；修复位于配置根解析及主机扫描层。

- 本机只读环境核对：`CODEX_HOME` 指向自定义目录，`skills` 下 6 个直接 Skill 目录均为链接。没有读取用户会话正文。
- 修复前生产模块回归：会话环境指定的根被当前项目根覆盖；自定义 Home 和 Worktree 符号链接各应发现 1 项却得到 0 项。其他 Agent 的符号链接排除回归通过。
- 修复后独立 Rust 元数据探针调用真实共享发现库，在本机实际目录识别到全部 6 个链接清单、共 27 项可用 Skills；探针仅输出数量，未启动 CLI 或桌面服务，临时文件已清理。
- 官方 OpenAI Docs 页面请求被 403 阻挡，未将本次本地验证陈述为官方文档确认；结论来自实际安装目录及生产代码回归。

### 触点与场景

| 触点 | 最终结论 |
| --- | --- |
| webTerminalSkills::requestFor | 会话启动环境配置根优先于当前项目设置，既有异步后复核包含该根 |
| agents::inspect_local / inspect_wsl | 显式根优先，缺省分别沿用本机或 guest 环境；WSL 不读取 host CODEX_HOME |
| discovery_layout / SkillRootSpec / collect_local_bundle | 仅 Codex 开启符号链接发现，规范目录去重避免循环；保留深度 8、500 清单、256 KiB 读取，新增 10,000 路径枚举预算 |
| WSL Skill find | Codex 固定 find -L，保留原深度、输出/时间及结果数量上限；其他 Agent 保留原规则 |
| shared scanner 的 SSH 与扩展清单消费者 | SSH Agent 编译验证；公开布局只增加内部扫描标识，不修改序列化快照或 RPC；扩展清单使用自己的扫描器 |
| Composer / PTY / Hook / server / permissions / migrations | 本轮确认无关：斜杠仍只修改草稿，能力门控、精确绑定、原提交与权限边界保持 |

场景覆盖本机自定义/默认配置根、会话根与后改项目根、用户/项目/Worktree 链接、循环、Junction、超大清单、其他 Agent、WSL guest 身份及 SSH 编译。窗口焦点、托盘、侧栏形态及分屏不参与根解析，继续以注册 PTY/CLI 身份隔离；未绑定、旧主机、手机/IME 沿用前一批次验证。本轮未启动 WSL 或真实 UI。

### 编辑前影响

- GitNexus 索引为 CLI-Manager / d84b5820（2026-11-15 10:54），匹配本轮起始 HEAD；MCP 存储版本不兼容，CLI 精确 impact 可用。
- requestFor 为 HIGH，上游 executeTerminalSkills 与 Web dispatcher；collect_local_bundle、discovery_layout、SkillRootSpec、push_skill_root 均为 HIGH，上游涉及本机诊断、SSH Agent 和扩展 inventory。已在编辑前明确告知共享影响。
- inspect_local、inspect_wsl、push_wsl_skills 为 LOW；新增的根选择/find 参数辅助函数不借助旧索引的零结果判定安全，通过限定调用点及生产模块回归核对。
