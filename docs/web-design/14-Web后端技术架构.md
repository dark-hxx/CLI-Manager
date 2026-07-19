# Web 后端技术架构

## 1. 技术决策

Web 后端统一使用 Rust，采用模块化单体。首版由一个进程同时提供 HTTP API、WebSocket 设备网关、业务编排、桌面上报接收、缓存、审计和后台任务。

| 层 | 技术 |
|---|---|
| 异步运行时 | Tokio |
| HTTP / WebSocket | Axum + Tower |
| 序列化 | Serde |
| 数据库 | SQLite3 |
| 数据访问 | SQLx |
| 日志与追踪 | tracing |
| 缓存 | 进程内缓存 + SQLite3 |
| Redis | 默认不引入，架构升级后按明确需求评估 |

不在设计阶段锁定具体依赖版本，实施时以当时官方稳定版本和项目兼容性检查为准。

## 2. 单进程结构

```text
Rust Web Service
├─ HTTP API
├─ Browser WebSocket
├─ Desktop WebSocket
├─ Authentication
├─ Device Registry
├─ Operation Dispatcher
├─ Event Ingest
├─ Cache Service
├─ History / Replay Query
├─ Analytics Query
├─ Audit Service
├─ Background Jobs
└─ SQLite Repository
```

网关和业务服务同进程部署，但代码按模块隔离。连接模块不得直接编写业务数据，业务模块不得持有 WebSocket 连接对象，只通过设备注册表和操作分发接口通信。

## 3. 核心模块

| 模块 | 职责 |
|---|---|
| `transport` | HTTP、WebSocket、请求大小和超时限制 |
| `auth` | 用户会话、设备配对、权限和设备撤销 |
| `device_registry` | 在线连接、心跳、能力和连接实例 |
| `operation` | operationId、幂等、状态机、取消和回执 |
| `event_ingest` | 校验桌面快照、事件序号、去重和补传 |
| `cache` | 读取缓存、版本比较、TTL 和失效 |
| `history` | 会话、Replay、Prompt 和请求日志查询 |
| `analytics` | Token、费用、趋势和排行聚合 |
| `audit` | 记录用户、设备、目标、决策和结果 |
| `storage` | SQLite3 事务、迁移、备份和查询 |

## 4. SQLite3 定位

SQLite3 保存用户与设备关系、权限、操作记录、审计以及桌面上报的结构化缓存。数据库文件只由单个 Rust 服务实例管理。桌面端仍是项目、文件、Git、CLI、Hook 和系统状态的唯一权威来源。

建议的数据域：

- `users`、`browser_sessions`、`devices`、`device_grants`。
- `operations`、`operation_events`、`operation_receipts`。
- `resource_snapshots`、`resource_cache_entries`、`event_cursors`。
- `history_sessions`、`history_messages`、`request_logs`、`stats_rollups`。
- `audit_logs`。

大体积文件正文、PTY 原始输出、密钥和凭据不进入 SQLite3。

### 4.1 连接与 PRAGMA

- `journal_mode=WAL`：读写可以并行，降低页面查询对事件写入的影响。
- `foreign_keys=ON`：强制关系完整性。
- `busy_timeout`：短暂写锁冲突时等待，不立即报错。
- `synchronous=NORMAL`：在 WAL 模式下平衡安全性和写入开销。
- 使用小型有界连接池，禁止每个事件新建连接。

### 4.2 写入规则

- 所有写入通过统一存储模块进入有界队列。
- 快照、事件和审计使用批量短事务。
- 事务中禁止网络请求、文件读取和长时间计算。
- 统计查询使用预聚合表，避免长查询阻塞检查点。
- operation、事件序号和幂等键由唯一约束兜底。

### 4.3 迁移和备份

- 数据库迁移随 Rust 二进制内嵌并按版本顺序执行。
- 启动迁移前创建安全备份，失败时停止启动，不带病运行。
- 在线备份使用 SQLite Backup API 或 `VACUUM INTO` 等一致性方式。
- 不直接复制处于 WAL 写入状态的 `.db` 文件。
- 恢复后执行完整性检查，再允许设备连接和业务写入。

## 5. 操作状态机

```text
submitted
  → waiting_device
  → accepted
  → running
  → succeeded | failed | rejected | timed_out | canceled
```

- Web 创建操作后只能进入 `submitted`。
- 桌面接收后进入 `accepted`，开始执行后进入 `running`。
- 只有桌面最终回执可以进入终态。
- 取消先进入 `cancel_requested`；桌面确认停止后才进入 `canceled`。
- `operationId`、用户、设备、项目和幂等键组成唯一操作边界。

## 6. 缓存

首版使用两级缓存：

1. 进程内缓存：在线设备、连接索引、热点快照和短期查询结果。
2. SQLite3 缓存：需要跨重启、跨浏览器读取的桌面上报数据。

进程内缓存丢失后必须能从 SQLite3 和桌面快照恢复，不能保存唯一业务状态。

## 7. Redis 引入条件

当前单实例 + SQLite3 架构不需要 Redis。只有先完成数据库和部署架构升级，并满足以下需求时才重新评估：

- Rust 服务需要运行多个实例，并跨实例定位设备连接。
- 需要跨实例发送取消、审批或实时通知。
- 已迁移到支持多实例写入的数据库。
- 需要短期分布式锁、限流计数或幂等结果共享。

Redis 只用于连接路由、短期状态、限流和事件分发，不作为持久业务数据源。重要事件使用数据库 Outbox 或具备确认机制的队列，不依赖不可靠的 Pub/Sub 完成最终状态更新。Redis 不能解决多个实例共享 SQLite3 文件的问题。

## 8. 并发与隔离

- WebSocket 心跳和事件接收使用独立并发限制。
- 数据库查询、统计聚合和文件类回执设置独立超时。
- 每台设备限制并发操作数和消息速率。
- 慢客户端使用有界发送队列，队列满时断开并要求重连补传。
- 后台统计任务不得阻塞设备心跳和操作回执。

## 9. 部署

首版只部署一个 Rust 服务，SQLite3 数据文件位于持久化数据目录：

```text
Reverse Proxy
  └─ Rust Web Service
       └─ SQLite3
```

Rust 服务提供静态 Web 资源、API 和 WebSocket，可使用单个容器或单个二进制部署。数据目录必须挂载持久卷，并纳入在线备份。Redis 不进入首版部署清单。

## 10. 扩容路径

1. 单实例 Rust + SQLite3。
2. 优化索引、批量事务、WAL 检查点和统计汇总。
3. 当单实例达到明确瓶颈时，迁移到 PostgreSQL 等服务型数据库。
4. 再引入 Redis 处理多实例连接路由和跨实例状态。
5. Rust 服务水平扩容。
6. 只有出现独立瓶颈时，才拆分统计或历史查询服务。
