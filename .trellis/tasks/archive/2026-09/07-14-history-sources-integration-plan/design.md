# 多来源历史解析设计记录

备份与恢复已拆分为子任务 `07-14-history-backup-restore`，详细设计见 `docs/历史备份与恢复设计.md`。本设计只保留 adapter artifact graph 和 mutation 对 Backup Service 的接口依赖。

## 已拍板

- `file_path` 升级为 `sessionRef + rawPointers`。
- 第一版可以不完整接入所有解析器；新 parser 可先 shadow/research，正式标记为已解析来源后必须进入转换体系和 writer 路线图。
- 保留 raw pointers / 原始可追溯入口。
- Source id 统一短 id；显示名走 descriptor + i18n。
- 不能把非 Claude/Codex 来源永久设计成只读。修改、删除、转换可以分阶段，但架构必须兼容。
- 外部历史 mutation 备份目录放在历史来源所在运行环境的用户主目录下 `.cli-manager/backups`：Windows 为 `%USERPROFILE%\.cli-manager\backups`，WSL/macOS/Linux 为 `$HOME/.cli-manager/backups`。
- 删除默认语义是物理删除。
- 物理删除主会话时级联删除全部 subagent 后代；整棵树完成 preflight 和备份后才开始执行，不能留下孤立会话。
- 级联删除全有或全无：任一节点失败则恢复全部已删除内容；回滚失败进入 `manualRecoveryRequired` 并锁定来源实例 mutation。
- subagent 是只读关联节点，禁止单独编辑、删除、转换；前后端基于 relation 强制校验，只有主会话 delete plan 可内部级联处理。
- 转换要覆盖所有已解析来源：已解析来源可作为 `from`，具备目标写入能力的来源可作为 `to`，用户可自定义选择任意可行组合。
- 转换固定是非破坏性复制，来源始终保留；删除来源必须另起物理删除 plan，不提供隐式 move。
- 转换生成新的目标原生 id，不覆盖、不合并；id 必须贯穿目标工具完整会话包，mutation 重试通过 idempotency key 复用。
- Codex writer 不能只写 rollout 或索引，必须按目标版本一致处理 rollout、`history.jsonl`、`session_index.jsonl`、`state_5.sqlite` thread row，并整体验证/回滚。
- 缺少必需 artifact、schema 未知或版本未验证时 preflight 直接阻止转换，不允许 best-effort 主文件写入，也不能用有损确认绕过。
- 目标工具运行时禁止转换，无 override、无强制结束进程；plan 与 commit 前都在目标运行环境检查进程/写锁，关闭后重新 preflight。
- 每个已解析来源都必须进入原生 writer 路线图，最终支持作为 `to`；capability 只控制阶段性开放，不作为永久排除理由。
- 数据库/混合来源写入不设置通用实验性开关；只由 source-specific capability、schema/version 校验、备份恢复能力和目标运行时锁检测共同放行。

## Recall research 摘要

调研对象：`samzong/Recall`，HEAD `de6db943b05e61d92648e024150a1731403d4e63`。

可参考点：

- adapter 注册：`SourceAdapter + all_adapters()`。
- 多来源扫描：Claude、Codex、Gemini、Copilot、Antigravity、Grok、Pi、OpenCode、Kiro、Cursor、Cline。
- 增量同步：`scan_for_sync()` 使用 mtime / updated_at / message_count 判断是否跳过。
- 溯源字段：`RawSession.source_file_path`。
- resume/app open：adapter 返回命令，不在 UI 里硬编码。

不能直接照搬：

- Recall 的 delete/update 是索引库操作，不是外部源 mutation。
- Recall import/export 是 Recall JSONL 记录迁移，不是源格式转换。
- Recall 单会话 export 是纯文本导出，不是原生格式转换。
- SQLite 来源在 Recall 中只读打开。
- `source_file_path` 不足以表达数据库 row、JSON path、混合来源。

## 核心模型

```ts
type HistorySourceId =
  | "claude"
  | "codex"
  | "gemini"
  | "copilot"
  | "antigravity"
  | "grok"
  | "pi"
  | "opencode"
  | "kiro"
  | "cursor"
  | "cline";

type HistorySessionRef = {
  sourceId: HistorySourceId;
  sourceInstanceId: string;
  sessionId: string;
  storageKind: "file" | "database" | "mixed";
  primaryPath?: string;
  databasePath?: string;
  rawKey?: string;
  sourceVersion?: string;
};

type HistoryRawPointer = {
  kind: "file" | "fileLine" | "jsonPath" | "databaseRow";
  path?: string;
  line?: number;
  jsonPath?: string;
  databasePath?: string;
  table?: string;
  rowId?: string;
  column?: string;
};
```

`sourceId` 表示工具类型，`sourceInstanceId` 表示用户当前确认的读取位置。每个 source 同一时间最多一个 active instance；稳定主键仍是 `(sourceId, sourceInstanceId, sessionId)`，用于防止切换 Windows/WSL/自定义位置后新旧索引混淆。

来源设置按“实例”组织，而不是只存一组路径：

```ts
type HistorySourceInstanceSettings = {
  id: string;
  environment:
    | { kind: "windows" }
    | { kind: "wsl"; distro: string }
    | { kind: "macos" }
    | { kind: "linux" };
  locations: Record<string, string>;
};
```

用户确认读取位置后持久化 active instance；自动探测只提供候选。同一 source 不能同时选择多个实例。Cursor 等多槽位来源可以在一个 instance 内配置多个不同槽位，但每个槽位只有一个位置。WSL UNC 路径由路径本身推断 distro，不增加额外环境开关。

转换目标直接使用目标 source 在设置中的唯一 active instance；未配置或不可写时不开放目标能力。

读取位置使用两阶段切换：pending instance 完成路径/schema 校验和隔离首轮索引后，才原子替换 active instance；失败或取消保留旧实例。pending 期间旧实例只读可用，外部 mutation 暂停。

## Source id 规则

内部统一短 id：

- `claude`
- `codex`
- `gemini`
- `copilot`
- `antigravity`
- `grok`
- `pi`
- `opencode`
- `kiro`
- `cursor`
- `cline`

兼容 alias：

- `claude-code -> claude`
- `copilot-cli -> copilot`
- `kiro-cli -> kiro`

显示名由 descriptor 提供 `labelKey/defaultLabel/shortLabel`，前端统一从 i18n 渲染。

## 本地 History Index DB

完整数据库设计见 `docs/历史索引库设计.md`，本节只保留关键架构决策。

CLI-Manager 当前已经有两套派生索引：

- `history-index-cache`：内存 + JSON 持久化，按文件 fingerprint 复用解析结果。
- `history-catalog.db`：SQLite catalog、messages、FTS、state；列表和搜索优先读它，失败时回退旧索引。

问题不在于“完全没有 SQLite”，而在于现有 catalog 仍以 `file_path` 为中心，详情和部分操作继续回读 Claude/Codex 原始文件，无法统一数据库/混合来源。目标是把它升级为唯一的正式 History Index DB，停止长期维护 SQLite + JSON 两套索引。

数据流：

```text
外部历史源（真实来源）
  -> source adapter 发现 sessionRef
  -> fingerprint / parser_version 比较
  -> 只解析新增或变化的会话
  -> 统一中间模型
  -> History Index DB（可重建派生数据）
  -> 列表 / 搜索 / 统计 / 规范化详情 / 转换候选
```

建议核心表：

```sql
history_source_instances(
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  environment_kind TEXT NOT NULL,
  environment_key TEXT NOT NULL,
  locations_json TEXT NOT NULL
);

history_sessions(
  id INTEGER PRIMARY KEY,
  source_instance_id TEXT NOT NULL,
  source_session_id TEXT NOT NULL,
  storage_kind TEXT NOT NULL,
  primary_path TEXT,
  database_path TEXT,
  raw_key TEXT,
  source_version TEXT,
  project_key TEXT,
  cwd TEXT,
  title TEXT,
  created_at INTEGER,
  updated_at INTEGER,
  message_count INTEGER NOT NULL,
  parser_version INTEGER NOT NULL,
  fingerprint_value TEXT NOT NULL,
  model_version INTEGER NOT NULL,
  last_seen_generation INTEGER NOT NULL,
  indexed_at INTEGER NOT NULL,
  UNIQUE(source_instance_id, source_session_id)
);

history_messages(
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL,
  message_index INTEGER NOT NULL,
  role TEXT NOT NULL,
  timestamp INTEGER,
  display_content TEXT NOT NULL,
  raw_pointers_json TEXT,
  UNIQUE(session_id, message_index)
);

history_message_parts(...);
history_tool_events(...);
history_usage_events(...);
history_file_changes(...);
history_source_state(...);
history_sync_runs(...);
```

同步规则：

- 页面请求只查询索引库，不触发全量源解析；刷新由显式刷新、启动后台同步、来源设置变化和文件监听/轮询触发。
- adapter 的发现阶段只返回轻量 `sessionRef + fingerprint`。文件来源优先使用路径、mtime、size，必要时补 hash；数据库来源使用稳定 row key、更新时间或数据库变更标记。
- `(source_id, source_instance_id, source_session_id)` 是稳定业务身份；库内 child 表通过 `history_sessions.id` 整数外键关联。路径只是定位信息，移动文件不能自动产生重复会话。
- fingerprint 变化或 `parser_version` 升级时，在一个事务内替换该会话的 session/messages/events/usage/FTS。
- 一次扫描完成后，对“之前存在、现在缺失”的记录做删除确认。只有来源扫描成功且范围完整时才删除索引记录；扫描失败、路径离线、WSL distro 未启动时只标记来源不可用，不能误删。
- 详情默认读取索引中的规范化消息；raw view、完整工具调用、diff 精确还原和 mutation 才按 `rawPointers` 回源。
- 索引库启用 WAL、busy timeout 和短事务；解析在事务外进行，写入时只持有批量 upsert/replace 的短事务。
- 索引库 schema 和 parser 分别版本化。schema migration 失败时保留原库并提示重建；索引库可删除重建，但不能影响外部历史源。

写操作一致性：

- 编辑、删除、转换先生成 plan，备份并写外部源；成功后重新解析受影响的 session，再更新索引库。
- 外部写入成功但索引刷新失败时，结果标记为“外部已完成、索引待刷新”，进入重试队列；不能回滚成只改索引库。
- 不允许通过直接更新 History Index DB 来伪造外部历史编辑或删除。索引内可单独维护 CLI-Manager 私有元数据，但必须与源字段分表或明确命名空间。

迁移策略：

1. 在现有 `history-catalog.db` 中新增版本化 v2 表，避免同时引入第二个 SQLite 文件。
2. 首次运行从外部源重建 v2，不把旧 `file_path` 记录直接当作可靠新主键。
3. 列表、搜索、统计、详情依次切到 v2；每一步保留可观测回退和一致性对比。
4. v2 稳定后删除运行时对 `history-index-cache` 的依赖，再单独清理旧表/旧缓存文件。

## 能力模型

能力值使用三态：

- `supported`
- `planned`
- `unsupported`

第一版只开放已经验证的能力。新 parser 可以先处于 shadow/research 状态；正式标记为已解析后，只要统一模型满足最低完整度就必须作为 `convertFrom`，`convertTo` 需要目标 adapter 的原生 writer。未完成的能力可以是 `planned`，但每个正式已解析来源都必须进入 writer 路线图，最终支持双向转换。

转换 plan 必须附带兼容性报告：目标格式不能表达的 tool call、usage、diff、附件和来源私有字段逐项列出。无损转换可正常执行；有损转换提醒用户并要求明确确认后继续。统一模型允许保留命名空间化 source extension，防止 parser 阶段不可逆丢失原始语义。

History Index DB 使用普通本地 SQLite，不加密、不参与同步，不引入 SQLCipher。

Mutation 备份按每个运行环境的 backup root 独立计算，默认保留 7 天或最多占用 1 GiB，任一条件先达到即从旧到新按完整 mutation 目录清理；执行中、恢复中和 manifest 不完整的备份不能自动删除。

单次必要备份预计超过该环境 1 GiB 时阻止 mutation。用户只能更换备份目录或显式临时提高仅当前环境、当前 mutation 的上限；完成或取消后恢复默认值，禁止跳过备份或静默超限。

临时超额备份不长期豁免默认保留策略；mutation 执行中、回滚中和恢复中禁止清理，完成后仍按默认 7 天 / 1 GiB 自动清理，必要时本次 completed 备份也可被清理，确认页必须提前提示。

复审补充：

- 逻辑会话与物理 artifact graph 分离，支持主 transcript、subagent、registry、database row 和附件。
- 现有列表下挂语义保留，但由显式、多层 session relation 替代路径推断；主会话转换 plan 检查全部后代。
- 多制品 mutation 使用持久 manifest、idempotency key、staging、逆操作和重启恢复。
- 备份必须配套 restore plan；执行成功后必须重解析目标验证。
- capability 按 source + format/schema version + adapter version 判定，未知版本默认禁写。
- 路径 canonicalize、重叠来源去重、symlink/junction 循环保护，并排除备份/index/workspace。
- usage、cost、timestamp 保存 reported/estimated/unknown 等质量口径。
- subagent 统计另外计算：每个节点保存自身指标；session 数默认只计主会话，subagent 数单列，消息/token 全局只统计一次。
- detail、stats 和 subagent 展开必须分页/懒加载；stats 聚合桶不返回全部 session refs。
- 同样本 Claude/Codex P95 回退不超过 10%，后台同步期间前台 P95 回退不超过 20%；读 API 不触发源扫描或 WSL shell out。
- 目标能表达关系时按树写入；不能表达关系或转换失败的 subagent 作为有损项确认后不写入目标，禁止生成独立目标会话或压平进主会话。
- subagent 丢弃只影响目标输出，来源不变；主会话失败则整个 mutation 回滚。
- subagent 采用部分成功：每个子树独立 apply/verify/compensate，单个失败只回滚该子树，其他成功节点继续；有丢弃的结果标记 `completedWithOmissions`。
- subagent 禁止作为 conversion root；前端禁用入口，后端基于 session relation 返回 `history_conversion_subagent_not_allowed`。最终能力是 source capability 与 session constraint 的交集。

## Mutation 长期方案

后端预留 adapter 级 mutation API：

- `build_delete_plan`
- `build_edit_plan`
- `build_convert_plan`
- `build_operations`
- `build_restore_operations`

所有 mutation 必须：

- 先 plan，再执行。
- plan 展示影响范围。
- adapter 只生成 primitive operations、校验和逆操作；中央 `MutationExecutor` 统一状态机、备份、提交、回滚、恢复和定向重新解析。
- 执行前备份到历史来源所在运行环境的用户主目录下 `.cli-manager/backups`。
- 文件型来源用 mtime/size/hash 防冲突。
- 数据库来源用事务，处理锁冲突。
- 执行后重新解析并校验。
- 删除默认执行物理删除，不做软删除/隐藏。

默认备份目录解析：

| 环境 | 默认目录 |
|---|---|
| Windows 原生来源 | `%USERPROFILE%\.cli-manager\backups` |
| WSL 来源 | 对应 distro 内的 `$HOME/.cli-manager/backups` |
| macOS 来源 | `$HOME/.cli-manager/backups` |
| Linux 来源 | `$HOME/.cli-manager/backups` |

规则：备份目录跟随被修改的历史来源所在环境，不固定跟随 CLI-Manager UI 所在系统。WSL UNC 来源必须写入对应 distro 的 Linux home。

数据库/混合来源写入闸门：

- 不提供通用实验性写入开关。
- plan/dry-run 可以用于研究和预览，但不能创建任何目标 artifact、registry row 或数据库 row。
- 未知 schema、缺少完整 artifact graph、缺少 restore strategy、目标工具运行中或 backup root 不可用时阻止 mutation。
- 用户确认有损转换只能接受语义损失，不能绕过结构性不可写错误。
- 数据库/混合 writer 首次交付必须有真实目标工具版本的基准会话对照和恢复测试。

## 分阶段

1. 来源注册、设置页、`sessionRef/rawPointers`、Claude/Codex 无行为迁移。
2. CLI 工具注册表，内置更多启动选项，保留自定义命令。
3. 解析器分批接入：先完成 adapter core，再做 Gemini/Kiro JSON、OpenCode/Antigravity、Copilot/Grok/Pi/Cline、Cursor；每个 parser 同时登记对应原生 writer 的后续任务。
4. Mutation plan：先 dry-run，再覆盖所有已解析文件型来源，最后扩展数据库/混合来源。
5. 转换：做任意 `from -> to` 选择器；已解析来源可作为 `from`，已完成 writer 的来源可作为 `to`，按 capability 开放当前组合，并明确展示计划中组合。最终所有已解析来源都需具备 writer。
