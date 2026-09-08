# 后端注释扫描处置台账

状态：`已修复` 表示本分支含实现与回归验证；`现状确认` 表示契约/注释已准确描述且本次不改变行为；`后续任务` 表示需要独立设计、平台环境或公开契约评审；`范围排除` 表示用户明确排除。

| ID | 观察项 | 处置 | 状态与验证 |
|---|---|---|---|
| CP-01 | Codex pending resume 无上限 | 上限 64，满载拒绝新 ID，不丢弃已有请求 | 已修复；`resume_tracking_rejects_new_requests_at_capacity_without_dropping_existing_entries` |
| CP-02 | Codex profile metadata 后无界读取 | 打开文件后以 `take(MAX+1)` 限量读取 | 已修复；Codex proxy 定向测试、`cargo check --lib` |
| CP-03 | parent-input 错误不终止 child | 需要代理主循环取消协议设计 | 后续任务；未复现挂起 |
| CP-04 | WAV 只校验头部、WSL Toast 归属硬编码 | 完整音频解码与本地化需产品/平台契约 | 后续任务 |
| ST-01 | transcript 路径仅词法校验、目录遍历无 visited | canonical/link 与 WSL 路径语义需跨平台设计 | 后续任务 |
| ST-02 | WSL transcript 命令无期限/上限 | 纳入统一进程 deadline 后续迁移 | 后续任务；本次未触达真实 WSL |
| ST-03 | 订阅替换不 join、空读取忙轮询、首行无界 | stop+join；空读取保持轮询休眠；Codex 首行 256 KiB | 已修复；subagent transcript 定向测试 |
| PV-01 | Provider WSL stdin 写入不受 deadline | 新增覆盖 stdin、wait、输出 drain 的统一 deadline helper | 已修复；`input_write_is_covered_by_the_process_deadline` |
| PV-02 | batch live-file 部分覆盖 | 现有 caller recovery 语义需事务化设计 | 后续任务 |
| PD-01 | JSON array 脱敏/去密遇首项即停 | 改为完整遍历 | 已修复；repository 多元素测试 |
| PD-02 | card settings validity 仅表示外层 JSON | 保留解析有效性语义，不冒充 runtime readiness | 现状确认；就绪态拆分列入后续契约任务 |
| PD-03 | TOML ArrayOfTables 脱敏遇首项即停 | 改为完整遍历 | 已修复；document table-array 测试 |
| PD-04 | JSON/TOML secret preservation 漏数组/inline/table array | 递归检测与恢复所有容器，并拒绝新增 secret | 已修复；documents 定向测试 |
| DB-01 | WAL checkpoint 忽略 busy | 读取 PRAGMA 结果，busy 时拒绝备份 | 已修复；database checkpoint 测试 |
| DB-02 | 备份名可能碰撞并覆盖 | `create_new` 分配唯一文件并 `sync_all` | 已修复；database backup 测试 |
| CR-01 | crash JSON 不按敏感键脱敏 | 对 token/password/secret/key/auth/cookie 类键递归脱敏 | 已修复；crash reporter 测试 |
| CR-02 | runtime marker 跨 debug/release 前缀误收 | 改为严格 build-specific 文件名 | 已修复；跨 build marker 测试 |
| CR-03 | rolling log 的 10 MiB 是 rollover threshold | 保持现有行为，文档不再称硬上限 | 现状确认 |
| AI-01 | installer 部分错误路径未恢复旧链接 | 将后置步骤纳入共同恢复闭包 | 已修复；installer 编译/定向检查；Unix 实机未运行 |
| AI-02 | install_from_exe 预备文件与 best-effort rollback | 需 Unix 故障注入与持久事务设计 | 后续任务 |
| AI-03 | installer version 命令无 timeout/cap | 需迁移统一 bounded process helper | 后续任务 |
| SY-01 | remote dir 实现为规范化而非拒绝 | 保持已有兼容行为，注释按实现描述 | 现状确认 |
| SY-02 | snapshot validation 不证明领域完整性 | hash/对象仅为封装层校验 | 现状确认；领域 schema 校验后续任务 |
| SY-03 | snapshot/outbox 直接截断目标 | 改为独占创建，已有目标不覆盖；失败仅清理本次新文件 | 已修复；已有 ZIP 不截断回归测试 |
| SY-04 | backup filename/device/timestamp 与 URL decoding 宽松 | 需要同步协议版本化输入契约 | 后续任务 |
| ET-01 | 非 Windows `open_file` 语义不一致 | macOS/Linux 均尊重 file/folder 定位语义 | 已修复；shell command 测试/编译 |
| ET-02 | Unix `cd` 失败仍执行 startup | 使用 `cd && startup; exec shell` | 已修复；shell command 测试 |
| BG-01 | 背景图 exists/save 未绑定常规文件与 canonical 根 | 严格相对路径、扩展、常规文件和 canonical containment；拒绝 symlink/collision | 已修复；background 测试 |
| BG-02 | cleanup 跟随 symlink 且删除非图像 | 仅删除允许扩展的顶层常规文件，忽略链接/特殊文件 | 已修复；background 测试 |
| GA-01 | global apply journal 显示 verifying 而结果 committed | 中间 journal 保持 verifying/备份，最终统一 commit 后清理 | 已修复；global service 26 项测试 |
| GA-02 | rollback 被同 Home pending journal 阻塞 | 回滚时豁免当前事务 journal | 已修复；global rollback 测试 |
| GA-03 | 恢复写入前不校验备份指纹 | 所有备份先校验，再开始任何恢复写入 | 已修复；global recovery 测试 |
| PI-01 | import source hash 与 WAL/读取快照不绑定 | 需源数据库 snapshot 协议 | 后续任务 |
| PI-02 | unchanged 计数并非 no-write | 保持计数为结果等价语义 | 现状确认 |
| PI-03 | provider/scope/issue 分阶段部分提交 | 需要跨存储补偿与公开状态模型 | 后续任务 |
| RT-01 | failover queue 恢复 future 未 await | 等待恢复完成后返回 | 已修复；routing 测试 |
| RT-02 | provider ready 未检查 key 内容/完整运行配置 | 需拆分 enabled/configured/runtime-ready 契约 | 后续任务 |
| RT-03 | global proxy test 把任意非 407 当成功 | 当前仅表示代理可达；API 成功需独立探测 | 现状确认/后续契约 |
| CC-01 | CC Switch WSL stdin 无 deadline、stderr 直出 | 统一总 deadline、输出上限、对外通用错误，内部仅识别 runtime unavailable | 已修复；process/ccswitch 测试与编译 |
| CC-02 | readonly 测试未独立比较源库 | 测试真实性需隔离 WSL 数据库夹具 | 后续任务；默认不运行真实 WSL |
| SG-01 | suggestions 每次新建 HTTP client | `OnceLock` 复用共享 client | 已修复；suggestion 13 项测试 |
| SG-02 | provider/HTTP 错误可能含 secret | 错误文本先脱敏再限长 | 已修复；suggestion tests |
| SG-03 | sanitize/clamp 不负责危险命令与去重 | 保持前端策略边界 | 现状确认 |
| SG-04 | WSL listing/exists 无期限与容量 | 使用 bounded timeout helper，不返回原始 stderr | 已修复；suggestion tests；真实 WSL 未运行 |
| DM-01 | daemon pending 在写失败泄漏、写入不受限 | 写超时，所有失败与等待结束均移除 pending | 已修复；daemon client 编译/测试 |
| DM-02 | HTTP/rectifier body 无上限 | 非流式读取统一 16 MiB 上限 | 已修复；route HTTP tests |
| DM-03 | SSE lossy chunk、仅 LF、undecided buffer 增长 | 原始字节累计，支持 LF/CRLF，64 KiB undecided 上限 | 已修复；stream tracker tests |
| DM-04 | Claude 模型后缀按字节切片 | 使用 UTF-8 安全 `strip_suffix` | 已修复；非 ASCII mapping 测试 |
| DM-05 | Origin 前缀校验 | URI 解析并精确限定 loopback scheme/host/port/root | 已修复；Origin spoof tests |
| DM-06 | WebSocket 首帧 deadline/frame 读取前容量 | 需要握手层 deadline 与库级 frame 配置评审 | 后续任务 |
| DM-07 | Shutdown ACK、detach flow-control、PTY 边界 | 涉及公开 daemon/PTY 状态机契约 | 后续任务 |
| SSH-01 | bridge identity 漏 `config_file`、claim release 漏 `host_id`、readonly 非权限 | 需要身份 key/兼容迁移与授权模型 | 后续任务 |
| SSH-02 | SSH queue/pipe/join deadline、长行、config glob 容量 | 需要 SSH transport 全链路取消设计及 Unix 故障注入 | 后续任务 |
| HK-01 | AgentTool 完整 payload 日志 | 只记录有界元数据，不记录消息/转录正文 | 已修复；hooks tests/编译 |
| HK-02 | approval 仅按文件增长、listener lifecycle | 决策格式与监听器取消需要 Hook 协议任务 | 后续任务 |
| HK-03 | Hook client stdin 无界 | 限制 64 KiB | 已修复；hook stdin test |
| HK-04 | Hook 共享事件删除、非数组 expect、同步吞错、Codex inline comment | 共享项由既有测试确认；Codex bool 支持 inline comment；其余列入配置事务任务 | 部分已修复；settings 38 项测试 |
| AC-01 | capability metadata 后无界读取、fingerprint 漏 Skill、frontmatter 不闭合 | 文件句柄限量读取；fingerprint 纳入 scope/source/path/content；必须闭合 delimiter | 已修复；agent-capabilities-core 13 项测试 |
| AC-02 | capability 控制字符、自定义 root、async 中同步 SSH probe | 需输入契约与 async transport 调整 | 后续任务 |
| TS-01 | statusline ANSI 非 ASCII panic、命令先 wait 后 drain | ASCII hex 校验；统一 bounded concurrent drain/timeout | 已修复；statusline tests |
| TS-02 | Usage SSE 跨 chunk UTF-8 损坏 | 原始字节缓冲后按完整事件解码，保留 CRLF/1 MiB cap | 已修复；split UTF-8 test |
| TS-03 | 多 widget 重复 Git status | 性能缓存策略 | 后续任务 |
| GT-01 | Git tag format 缺 `--format=` | 桌面与 SSH agent 均使用显式参数 | 已修复；Git integration/agent check |
| GT-02 | rewrite squash 提前返回绕过 rollback、patch-after-reset | 高数据风险，需独立 Git 事务故障注入任务 | 后续任务 |
| FS-01 | overwrite copy/move 先删同路径目标 | 删除前拒绝相同 canonical source/target | 已修复；files test |
| FS-02 | copy/move 丢 symlink 身份、SSH download await 后不复验、attachment root 宽松 | 需要 symlink/远程 TOCTOU/root capability 设计 | 后续任务 |
| LS-01 | Live Server 任务/通道无全局上限、shutdown 未跟踪连接 | 需要 server ownership/cancellation 重构 | 后续任务 |
| SC-01 | OpenCode 失败前写 dedup、无 deadline、容量测试失真 | 成功后提交 dedup；5s AbortSignal；容量测试创建真实映射 | 已修复；Node 12 项测试 |
| SC-02 | dev-server probe body 无上限 | 64 KiB 后销毁请求并返回失败探测 | 已修复；`node --check`/脚本测试 |
| PF-01 | cc-connect preflight 有副作用、危险平台测试可能碰真实环境 | 默认验证不运行真实控制目录/信任库/外部可执行文件 | 后续隔离任务；本次未运行 |
| PF-02 | 多处 Git/WSL deadline、metadata read、busy timeout 不一致 | 公共 bounded process helper 已建立；剩余调用点按模块迁移 | 部分已修复/后续任务 |
| HR-01 | repair/history/profile/database-family 等事务与 TOCTOU | 跨数据库/外部文件事务，拆分独立高风险任务 | 后续任务 |
| PET-01 | 桌宠 ID 接受 `.`/`..` 并可能递归删除 pets 根 | 用户明确要求本次不要处理 | 范围排除；未运行卸载或破坏性测试 |

## 风险与验证说明

- GitNexus 在改动前报告 `request_with_timeout`、数据库 checkpoint/backup、capability frontmatter、Provider global/hook settings 等共享符号为 HIGH/CRITICAL；实现保持原接口并用相关模块定向测试覆盖。
- Windows 环境不安全执行真实 WSL、SSH、Unix installer、真实用户控制目录/信任库测试；相应项目未伪装为完成。
- 本台账把源观察的复合条目拆分或合并到唯一 ID；`PET-01` 明确保留为范围排除，因此不会被“已修复”统计。
