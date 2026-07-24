# 优化 SSH 远程历史索引与锁竞争

## Goal

让 SSH 远程项目的历史会话在已有缓存时快速打开、快速翻页，并消除远程同步期间无统一调度的 SQLite 写入造成的 `database is locked`。

## Changelog Target

V1.3.1

## Background

- 远端 Agent 的 `historySync` 当前把读取缓存、翻页和索引刷新绑定在同一入口。每次调用都会递归发现最多 100,000 个 JSONL、检查文件并写回整个 `index.json`；即使没有文件变化也会刷新摘要并执行 `fsync`。
- 前端加载更多会再次调用 `historySync`，因此翻页重复承担全目录扫描成本。
- Desktop 将远端结果写入 `history-catalog.db` 后，前端还通过 plugin-sql 直接写主库 `ssh_agent_tool_integrations`。该写入不走现有 SSH 持久化边界的 `BEGIN IMMEDIATE`、busy timeout 和错误映射，和其他主库写事务并发时可能返回 SQLite code 5。
- `requestRemoteHistorySync` 的 single-flight key 包含 `consumerId`，导致同一主机、来源、根目录、项目作用域、游标和页大小的不同消费者不能复用请求。
- 当前 UI 将远端 RPC、目录库应用和主库元数据持久化包装为同一个“刷新失败”，无法判断锁发生在哪个数据库阶段。
- 远端 `sourceInstanceId` 明确不包含 Agent `installationId`，以便重装/升级后继续复用同一机器、用户、来源和配置根；但 Desktop catalog 又把旧 `installationId` 当作不可变来源身份，导致重装后首次落库被误报为 `history_remote_identity_changed`。
- Desktop 普通详情请求把缺失的 `remoteTranscriptRef` 编码为 JSON `null`，但已发布 Agent `0.1.3` 的 `HistoryGetRequest` 使用 Rust `String`；`serde(default)` 只兼容字段缺失，不能反序列化 `null`，因此列表成功后详情在协议入口返回 `history_request_invalid`。

## Root-Cause Statement

当 SSH 远程历史被打开、翻页或与统计请求并发使用时，读取缓存仍会触发全量远端扫描和整份索引写回，目录库与主库写入缺少统一的短事务持久化边界，catalog 将可轮换的 Agent `installationId` 错当成稳定来源身份，并且 Desktop 详情协议适配层把缺失字符串编码成 Agent 无法反序列化的 `null`；修复必须落在远端索引读写、Desktop 持久化/身份合并和请求编码边界，而不是在 Toast 或刷新按钮处重试。

## Requirements

### R1：远端缓存快路径

- 当远端索引存在、解析器版本兼容且已覆盖请求的项目作用域时，非强制同步直接从 `index.json` 分页返回。
- 缓存快路径不得获取 writer lock、递归扫描历史目录或重写索引文件。
- 无索引、索引不兼容、请求扩大项目作用域或显式强制刷新时，继续执行增量发现与解析。
- 手动刷新必须显式强制扫描；加载更多只读取同一 generation 的缓存页。

### R2：减少索引写放大

- 增量扫描没有发现文件、作用域或 tombstone 变化时，不重建全部摘要、不序列化和 `fsync` 整份索引。
- 首次或重建索引时优先处理最近修改的历史文件，使有限扫描预算优先产出最近会话。
- 保留 append、partial tail、truncate、same-size rewrite、rotation、oversized record、tombstone 和 cursor generation 语义。

### R3：远程请求复用

- 相同 host/source/config root/project paths/cursor/limit/refresh mode 的并发请求共享一个 in-flight Promise，不因 `consumerId` 不同而重复索引。
- 不同来源、项目作用域、游标页或刷新模式仍保持隔离。
- 已有 Desktop 缓存的项目先展示缓存列表，再在后台执行一次强制增量刷新；首次无缓存仍等待远端首批结果。

### R4：主库写入治理

- `ssh_agent_tool_integrations.history_source_instance_id` 的写入必须从前端 plugin-sql 迁移到现有 Rust SSH 集成持久化边界。
- 使用带 busy timeout 的 SQLite 连接、`BEGIN IMMEDIATE` 短事务和幂等 UPSERT/UPDATE。
- 锁竞争必须映射为稳定错误码，禁止向用户暴露无法定位阶段的原始 code 5。
- 不新增依赖，不修改数据库 schema，不修改 `application.yml`/配置文件。

### R5：目录库写入与诊断

- 远端同步结果应在取得 writer lease 前完成可提前完成的校验和序列化，缩短 `history-catalog.db` 写事务。
- 目录库 busy/locked 与主库元数据 busy 必须使用不同错误码，便于 UI、日志和后台任务定位。
- 失败时保留已缓存的会话列表，不删除来源 JSONL 或可用目录行。
- Agent 重装/升级仅改变 `installationId` 时，稳定的 machine/user/source/config-root 与 `sourceInstanceId` 继续复用，catalog 原子更新当前安装元数据；机器、用户、来源或配置根变化仍拒绝覆盖旧缓存。

### R6：详情请求协议兼容

- Desktop `historyGet.remoteTranscriptRef` 必须始终发送非 null 字符串；普通历史详情没有 Hook 引用时发送 `""`。
- 必须兼容用户已安装的 Agent `0.1.3`，不得仅依赖升级远端 Agent 才能打开详情。

## Scenario Coverage

- 首次打开且无远端/本地缓存：按最近优先建立首批索引。
- 再次打开且已有缓存：立即显示 Desktop 缓存，后台增量刷新。
- 手动刷新：强制远端扫描并等待结果。
- 加载更多：使用 cursor 读取已发布 generation，不重新扫描。
- 远端文件 append、截断、同大小改写、删除：强制/后台刷新后正确更新。
- 历史面板、实时统计和分析看板并发请求：相同请求复用，不产生重复 writer。
- 两个窗口/消费者访问同一远程作用域：共享可复用请求，consumer 生命周期不破坏结果校验。
- 本地历史目录刷新与远端目录应用并发：WAL 读取继续可用，写事务有明确 busy 错误。
- SSH 断开或远端索引失败：保留 Desktop 缓存并标记 stale/error。
- Agent 重装/升级后立即打开：同一稳定远端来源直接接续缓存并更新安装元数据，不报 `history_remote_identity_changed`。
- 列表中打开普通历史详情：无 transcript 引用时通过 Agent 索引定位，不报 `history_request_invalid`。
- Window focus、分屏、最小化、Focus mode、Worktree、CLI Hook 安装状态：已确认不改变本任务的数据边界，属于无关维度。

## Acceptance Criteria

- [ ] AC1：已有兼容索引的非强制分页不会扫描历史目录、获取 writer lock或改变 `index.json` 修改时间。
- [ ] AC2：手动刷新、首次索引和新增项目作用域仍会扫描并发现新增/修改/删除会话。
- [ ] AC3：无变化的强制刷新不会重写 `index.json`；首次构建优先索引最近修改文件。
- [ ] AC4：加载更多不再重复全目录扫描，cursor generation 变化仍从 offset 0 重新分页。
- [ ] AC5：相同远程同步输入的并发调用只执行一次远端 RPC 和一次集成元数据写入。
- [ ] AC6：远程历史元数据不再通过前端 plugin-sql 直接写主库；busy 错误被映射为稳定、分阶段错误码。
- [ ] AC7：远端同步失败时已有缓存列表仍可见，来源文件和已提交目录数据不被清除。
- [ ] AC8：相关 Rust 定向测试、`cargo check` 与 `npx tsc --noEmit` 通过。
- [ ] AC9：`CHANGELOG.md` 的 `V1.3.1` 记录本次用户可见行为变化，`docs/功能清单.md` 同步更新。
- [x] AC10：同一 machine/user/source/config-root 下轮换 Agent `installationId` 可继续应用同步结果并更新 catalog；任一稳定来源字段变化仍返回 `history_remote_identity_changed`。
- [x] AC11：普通远程历史详情请求发送 `remoteTranscriptRef: ""` 而不是 `null`，已发布 Agent `0.1.3` 可成功反序列化并打开详情。

## Out of Scope

- 不把远端 JSON 索引迁移为 SQLite。
- 不修改远端历史为可编辑；仍保持只读。
- 不引入跨主库与目录库的分布式事务。
- 不升级 Tauri、React、Rust crate 或 npm 依赖。
- 不重构本地/WSL 历史解析器。
