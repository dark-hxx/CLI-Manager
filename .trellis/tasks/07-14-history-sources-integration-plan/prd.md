# 历史来源接入规划

## Goal

设计多平台历史来源配置、CLI 工具注册表与后续解析器接入顺序。

## Requirements

- 历史来源目录配置必须从 Hook 设置中解耦，新增独立入口 `设置 -> 历史来源`。
- 现有单个 `file_path` 模型必须升级为 `sessionRef + rawPointers`，以兼容文件、SQLite、混合存储和消息级原始定位。
- 会话稳定身份必须包含 `sourceInstanceId`，使用 `(sourceId, sourceInstanceId, sessionId)` 防止用户切换 Windows、WSL 或自定义位置后新旧索引混淆。
- 每个历史来源同一时间只能配置一个 active instance；自动探测只提供候选，用户必须在设置中确认读取位置。
- 更换读取位置必须两阶段切换：新实例验证和首轮索引成功后才替换旧 active instance，失败或取消保留旧实例。
- 历史列表、搜索、统计和规范化详情必须以 CLI-Manager 自己的 SQLite History Index DB 为主读取路径；外部历史源仍是真实来源，索引库是可删除重建的派生数据。
- 刷新时只做来源发现、fingerprint 比较和增量解析；只有新增、变更、删除或 parser 版本变化的会话需要更新索引，不能每次请求都全量读取各来源后临时聚合。
- Source id 统一使用短 id；显示名通过 descriptor + i18n 配置，不在业务逻辑硬编码。
- 第一阶段只落地来源注册、目录发现、路径校验、Claude/Codex 无行为迁移；新来源解析可以先做 shadow/research parser，正式标记为已解析后必须进入转换体系。
- 新来源接入必须先声明能力，避免把非 Claude/Codex 来源误用于删除、编辑、转换、实时统计等专属链路；能力状态需要支持 `supported/planned/unsupported`。
- 架构不能把新来源永久设计成只读。修改、删除、转换可以不在第一版开放，但必须进入后续计划，并预留 adapter 级 mutation API。
- 保留 raw pointers / 原始可追溯入口，后续 mutation、打开原始位置、转换都必须基于原始定位。
- 外部历史 mutation 必须先备份，默认备份目录为历史来源所在运行环境用户主目录下的 `.cli-manager/backups`；需要兼容 Windows、WSL、macOS、Linux。
- 删除默认语义为物理删除。
- 物理删除主会话时必须级联删除全部 subagent 后代，不能留下孤立会话。
- 主会话树删除必须全有或全无；任一 subagent/artifact 失败时恢复此前已删除内容，不允许部分成功。
- subagent 不允许单独编辑、删除或转换；它是只读关联节点，只有主会话删除 plan 可以内部级联处理。
- 转换要覆盖所有已解析来源：已解析来源可作为 `from`，具备目标写入能力的来源可作为 `to`，用户可自定义选择任意可行组合。
- 转换是非破坏性复制，来源始终保留；不允许转换成功后自动删除来源。
- 转换生成新的目标原生 session id，不覆盖、不合并现有会话；idempotent 重试复用同一目标 id。
- writer 必须写出目标工具的完整会话包，而不是只生成主 transcript 或 CLI-Manager 历史索引。
- 目标缺少必需 artifact、schema 未知或版本未验证时禁止转换；该错误不能通过有损确认绕过。
- 目标工具运行时禁止转换，不提供 override，也不由 CLI-Manager 强制结束进程。
- 每个已接入解析器的来源都必须进入原生 writer 的后续计划，最终具备 `convertTo`；capability 只用于表达分批交付状态，不能把某类来源永久排除在转换目标之外。
- 转换必须输出兼容性报告；有损转换允许执行，但必须提醒并由用户明确确认。
- History Index DB 使用普通本地 SQLite，不加密、不参与同步，不引入 SQLCipher。
- Mutation 备份按每个运行环境的 backup root 独立计算，默认保留 7 天或最多占用 1 GiB，任一条件先达到即自动清理，并支持立即永久清理。
- 单次必要备份预计超过该环境 1 GiB 时必须阻止 mutation；用户只能更换备份目录或显式临时提高仅本次 mutation 的环境上限。
- History Index DB 的详细 schema、增量同步、迁移和查询设计以 `docs/历史索引库设计.md` 为准。
- 备份创建、保留清理、自动回滚和人工恢复由子任务 `07-14-history-backup-restore` 负责；本任务只定义依赖 contract。
- 逻辑会话必须和物理 artifact graph 分离；删除、备份、恢复和转换目标写入覆盖完整制品集合。
- 保持现有列表的主会话/subagent 下挂效果；v2 使用显式、多层 session relation，不再依赖 `file_path` 推断。
- artifact 必须区分 exclusive/shared；共享文件和数据库只执行精确 record/row operation，恢复不得覆盖 mutation 后产生的无关数据。
- mutation 必须有 idempotency key、持久 manifest、staging、回滚和重启恢复；成功后必须重新解析目标验证。
- capability 必须按来源格式/schema 版本判定，未知版本默认禁止外部写入。
- usage、cost、时间戳需要保存 reported/estimated/unknown 等质量口径。
- 数据库/混合来源外部写入不设置通用实验性开关；必须由 source-specific capability、schema/version 校验、备份恢复能力和目标运行时锁检测共同放行。
- 新建项目 CLI 工具选项需要抽成注册表，允许内置更多 CLI，但不能把 CLI 工具等同于历史来源。
- 详细设计以 `docs/历史来源接入规划.md` 为准。

## Acceptance Criteria

- [ ] Trellis task 记录历史来源接入规划，并引用 `docs/历史来源接入规划.md`。
- [ ] 规划记录 Recall research 结论，明确 Recall 主要是 scan/sync/index，不提供外部源原地 mutation。
- [ ] 规划包含 `sessionRef + rawPointers`、短 source id、显示名配置方式、capability 状态。
- [ ] 同一来源不能同时选择多个读取实例；切换 Windows、WSL 或自定义位置后，不会与旧 instance 的 session id 混合或覆盖。
- [ ] 转换目标使用设置中的唯一 active instance；目标未配置、禁用或不可写时不开放转换。
- [ ] 新位置无效、离线、schema 不兼容或首轮索引失败时，旧历史仍可查询且设置不被覆盖。
- [ ] pending 切换期间查询继续使用旧实例，edit/delete/convertTo 暂时禁用；切换成功后不混合显示新旧索引。
- [ ] 规划明确本地 SQLite 索引库是列表/搜索/统计/规范化详情的主读取路径，支持增量同步、删除检测、parser 版本失效和删除重建。
- [ ] 规划明确 mutation 先写外部源，成功后重新解析刷新索引；禁止只修改索引库冒充修改外部历史。
- [ ] 规划包含修改、删除、转换的后续阶段，不把数据库/混合来源永久限定为只读。
- [ ] 规划明确备份目录、物理删除语义和任意 `from -> to` capability 转换策略。
- [ ] 转换成功、失败或回滚都不修改来源；删除来源只能通过后续独立物理删除 mutation。
- [ ] 新目标 id 在 rollout/transcript、registry、数据库 thread/session row 等全部目标制品中一致，碰撞发生在写入前重新生成。
- [ ] Codex 转换覆盖当前目标版本要求的 rollout、`history.jsonl`、`session_index.jsonl`、`state_5.sqlite` thread row，并在任一步失败时整体恢复。
- [ ] adapter 只有在完整 target bundle 写入和重解析验证通过后才声明 `convertTo=supported`。
- [ ] target bundle preflight 失败时不会创建任何文件、registry row 或数据库 row，并提供初始化目标工具或选择受支持版本的明确提示。
- [ ] Codex 目标版本要求 thread registry 时，缺少/不支持 `state_5.sqlite` 不会被静默跳过并误报成功。
- [ ] plan 预览和 commit 前都会检测目标进程/写锁；Windows、WSL 和原生 Unix 环境均在目标所在环境检测。
- [ ] 目标运行时不会写入任何 artifact；关闭目标后旧 plan 失效，必须重新 preflight。
- [ ] 主会话删除 plan 展示完整 subagent 树和 artifact graph，整棵树 preflight/备份完成前不得开始删除。
- [ ] 主会话删除成功后，其全部 subagent 后代都从外部源和派生索引中消失。
- [ ] 任一子任务删除失败时，已删除的主会话、其他 subagent 和共享 record/row 都被恢复，结果为 `failedRolledBack`。
- [ ] 回滚失败进入 `manualRecoveryRequired`，该来源实例禁止后续 mutation，但仍可读取和导出备份。
- [ ] subagent 行和详情禁用编辑、删除、转换；后端直接或批量提交 subagent root 时返回对应稳定错误且不修改外部源。
- [ ] subagent 消息的 `editable` 始终为 false；orphan subagent 不能绕过限制，主会话内部级联删除不受直接操作限制影响。
- [ ] 规划明确数据库/混合来源不靠通用实验性开关放行，未知 schema、缺少 restore strategy、目标工具运行中均阻止写入。
- [ ] 所有已解析来源均进入转换来源列表和目标 writer 路线图；转换 UI 按 capability 展示当前可执行组合及计划中组合。
- [ ] 转换 plan 能区分无损/有损转换并列出丢失字段，有损转换未经用户明确确认不得执行。
- [ ] 备份清理按完整 mutation 目录执行；每个运行环境独立统计，超过 7 天或该 root 总占用超过 1 GiB 时从旧到新清理；执行中和恢复中的备份不得自动删除。
- [ ] 单次备份超过默认上限时不会跳过备份或静默超限；临时上限只对当前环境、当前 mutation 生效，完成或取消后恢复默认值，完成后按默认规则自动清理。
- [ ] subagent 统计另外计算：session 数默认只计主会话，subagent 数单列，消息/token 全局只统计一次。
- [ ] detail、stats 和 subagent 展开使用分页/懒加载；stats 聚合桶不返回全部 session refs。
- [ ] 同样本 Claude/Codex P95 回退不超过 10%，后台同步期间前台 P95 回退不超过 20%，读 API 不触发源扫描或 WSL shell out。
- [ ] v2 schema 能支持 source instance、结构化消息部件、tool/usage/file change、FTS、安全增量同步和失败保留。
- [ ] v2 schema 能表达一条逻辑会话的多个文件、registry row、数据库 row，以及 parent/subagent/fork 关系。
- [ ] 主会话转换 plan 检查全部后代；能保留关系的 subagent 按树写入，不能保留或转换失败的 subagent 列出影响后经确认不写入目标。
- [ ] subagent 不会被转换成独立目标会话或压平进主会话；丢弃只影响目标输出，不修改来源会话。
- [ ] 主会话写入失败会回滚整个 mutation，不能作为普通有损项跳过；单个 subagent 失败只丢弃其无法挂接的子树。
- [ ] 5 个 subagent 中 1 个失败时，主会话和其余 4 个继续；失败子树不残留孤立文件、registry 或数据库 row，结果为 `completedWithOmissions`。
- [ ] 用户确认时已明确知晓运行期间失败的 subagent 会被跳过；执行结果再次展示实际成功和丢弃数量。
- [ ] subagent 行的转换入口禁用并提示从主会话发起；直接或批量调用后端转换 subagent 时返回稳定错误，不生成任何目标制品。
- [ ] UI 和后端均使用来源 capability 与 session-level constraints 的交集，不能仅凭 source 支持转换就开放 subagent 转换。
- [ ] 中途失败或应用崩溃不会留下无法识别的半完成转换；相同 mutation 重试不会重复追加目标数据。
- [ ] 未知来源格式/schema 版本不会开放 edit/delete/convertTo。
- [ ] 备份目录、索引库、mutation workspace、重叠目录和符号链接不会被重复扫描。
- [ ] 后续实现前先基于该文档拆分阶段性任务。
- [ ] 真实 edit/delete/convert mutation 在对应 Backup Service 能力完成前不得开放执行。
- [ ] 第一阶段实现不得新增解析器，不得改变 Claude/Codex 现有历史行为。
- [ ] 新建项目 CLI 选项扩展需保留自定义命令入口。

## Research Notes

- Recall 当前 HEAD：`de6db943b05e61d92648e024150a1731403d4e63`。
- Recall adapter 支持 11 个来源：Claude Code、Codex、Gemini CLI、Copilot CLI、Antigravity、Grok、Pi、OpenCode、Kiro、Cursor、Cline。
- Recall 的 `SourceAdapter` 只有 scan/sync/prune/resume/app 能力；`delete_session_data`、`update_session_fields` 操作 Recall 自己的索引库，不是外部源写回。
- OpenCode 在 Recall 中只读打开 SQLite 数据库；CLI-Manager 若要支持数据库 mutation，需要单独设计事务、备份、锁冲突处理。
- 本机 Kiro 当前版本实际使用 `%APPDATA%/Kiro/User/globalStorage/kiro.kiroagent/workspace-sessions/<workspace>/<sessionId>.json`，后续 parser 必须以真实 JSON fixture 为准，不能沿用早期 SQLite 假设。
- CLI-Manager 已有 `history-catalog.db`、FTS 和旧 `history-index-cache`，但现有 catalog 仍以 `file_path` 为核心；应迁移为以 `(source_id, source_instance_id, session_id)` 为主键的正式 History Index DB，并最终淘汰双索引路径。
- 当前 catalog 在扫描结果为空时会清理旧路径；v2 必须通过 adapter `discovery_complete` 和 generation 防止来源离线时误删索引。

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
