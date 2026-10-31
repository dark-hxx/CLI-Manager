# 设计：GPUI Provider 与路由迁移

## 1. 边界

- GPUI view/state 只负责展示、表单交互和异步任务生命周期，不直接访问 `src-tauri`。
- `crates/core-db` 提供 providers.db 连接池和 Provider Repository；`crates/core` 提供 Provider 业务操作与 daemon/routing 客户端适配。Tauri 命令保留既有 DTO 与调用行为，逐步改为薄适配器。
- 复用既有 Provider 表、迁移、配置文件和 daemon 协议，不新增 GPUI 专属 Provider 状态或替代存储。
- 领域 UI 建议放入 `apps/desktop-gpui/src/providers/`，按 `model.rs`、`view.rs`、`actions.rs`、`tests.rs` 等职责拆分；当前主壳模块采用显式模块注册，避免继续膨胀 `main.rs`。

## 2. 数据读取与只读首阶段

实施前先追踪 `provider::database::open_connection`、迁移版本、`ProviderCard` 聚合所需 SQL 和 `global::current` 的真实配置路径。当前尚未确认 providers.db 的连接池、初始化行为或 home 状态落盘格式，因此不可据此假设只读打开/缺库不创建行为；必须先以实现和测试证据确定这些契约，再选定首阶段数据来源。写库迁移与 schema 归既有 core-db 所有。

确认契约后再决定是否新增中立 `ProviderOverviewRepo`。若新增，返回脱敏 Provider 卡片与当前状态快照，字段限于现有摘要；不得返回 `api_key`、原始 `settings_config`、文档内容或 secret-bearing JSON。当前状态如需读取 home 文件，移至 core service，以显式 `AppPaths`/environment adapter 提供路径；不能由 GPUI view 自行拼接用户路径。

GPUI State 采用 `Loading | Ready | Empty | Unavailable | Failed`，附 generation 防止切换类型/窗口关闭后的过期任务覆盖新状态。三 CLI 类型切换不共享错误状态；刷新只重新加载当前视图。只读页面不触发任何 migration、home 写入或 daemon Apply。

## 3. 管理与敏感数据

目录编辑沿用现有输入 DTO、校验、秘密合并、文档解析和数据库事务，不在 UI 重写业务规则。Key 列表默认仅显示 `masked_api_key`；明文揭示只通过专用操作短暂返回内存并清空生命周期，复制走系统剪贴板接口，禁止进入 Debug、错误字符串、持久 UI state 和日志。对既有配置更新必须测试未知字段与嵌套秘密保留。

GPUI 原生编辑器用于 JSON/TOML/env 文档；错误呈现在文档级状态，错误文本不得包含秘密值。所有写操作显示明确成功/失败反馈，使用 generation/revision 避免旧异步结果覆盖。

## 4. 全局应用、路由与恢复

保持现有 `global::preview` → 用户确认 → `global::apply` 流程及 preview fingerprint。应用调用必须使用现有 per app/Home 锁、journal、目标指纹复核、备份/暂存/验证和恢复语义；若要拆分或调整职责，先补充专项设计和 GitNexus 上下游分析。不得从 GPUI 新建第二套文件物化实现。

路由与故障转移 UI 只消费 core 提供的强类型快照/事件；daemon 能力缺失、离线、状态未知与配置无效必须可区分。旧 Tauri 事件名、载荷和轮询兼容保持不变。快捷切换动作复用同一 preview/confirm/apply service，不得直接修改数据库或 home 文件。

## 5. 任务阶段

1. 契约与只读目录：摸清 schema/路径/迁移现状，建立 core-db 只读查询契约、GPUI 三分类列表和当前状态；完成后再据证据确认读模型是否需要拆分。
2. Core extraction：迁移目录与只读全局状态服务，Tauri 适配不变，GPUI 与 Tauri 共用实现。
3. Provider 管理：CRUD、排序、启停、文档与公共配置。
4. 密钥与全局应用：安全 key 操作、预览/应用及 journal 恢复；高风险专项评审。
5. Routing、failover、import、model candidates 与快速切换。
6. 双壳回归、真实窗口交互、无障碍/双语和父任务对齐矩阵更新。

每阶段完成前都以当前源码和测试重新验证，不把本文件的计划当作已实现证据。

## 6. 场景与失败处理

- `claude/codex/grok` × 空/单项/多项/当前项不可用。
- DB 缺失、只读、损坏、迁移未完成、SQL 错误；只读路径不得隐式建库。
- 当前 Home 为 local/WSL/未知，Home 切换与 daemon 掉线；过期快照不可被误认为已应用状态。
- 连续切换分类、重复刷新、窗口关闭后异步完成；generation 丢弃旧结果。
- 配置秘密遮罩、秘密字段缺失/新增/嵌套、畸形 JSON/TOML；原有值不可因编辑非秘密字段而丢失。
- Apply 确认取消、fingerprint 变化、锁竞争、每个文件写入阶段失败、进程中断与下次启动恢复。
- Provider 被删除/禁用但仍被配置引用、导入重复项、网络超时、模型响应非法。

## 7. 影响分析

2026-10-31 GitNexus 预编辑记录：

- `provider_catalog_list` upstream：risk UNKNOWN、无解析 caller；源码确认调用在 `src-tauri/src/lib.rs` command handler 注册，TS 调用点须进一步逐项定位。
- `provider_global_apply` upstream：risk UNKNOWN；源码确认 Tauri command 定义及 handler 注册，禁止按“无人调用”处理。
- `provider_global_apply` downstream：risk CRITICAL，47 个符号、5 条流程，包含 `apply_hot_switch`、`save_global_proxy`、`save_service_config`、`save_takeovers` 与 `current`。全局 Apply 代码修改先复核并逐流程验证。
- GitNexus 概念搜索受索引 FTS 未加载影响，未提供流程候选；不能作为无调用或低风险证据。

## 8. 验证

- Core DB：真实临时 providers.db fixture，覆盖查询语义、排序、空/损坏状态、缺库不建文件、DTO 不含秘密。
- Core：service 的纯逻辑、Home/daemon adapter 与状态分类测试；Apply 流程增加故障注入测试。
- GPUI：三类型筛选、loading/empty/error、过期 generation 丢弃、异步操作反馈及关键表单交互测试。
- 执行相关 package 的 `cargo test`、`cargo check` 与 `npm run check:architecture -- --strict`；相关用户文案提供 zh-CN/en-US，并手动切换验证。
- 阶段完成后记录 `detect_changes({scope:"all"})`，检查执行流变化；如 MCP 不可用，使用 CLI，并说明完整性限制。
