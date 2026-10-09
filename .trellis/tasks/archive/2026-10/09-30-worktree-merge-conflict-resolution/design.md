# Worktree 合并冲突解决 — 设计

> 状态：V1.4.2 产品实施中，P1 后端安全内核尚未全部完成。本文中的预算是验收门槛，不是已测结果。需求见 `prd.md`，实施顺序见 `implement.md`，用例与证据见 `tests/`、`validation.md`。

## 1. 目标、方向与不变量

主检出发生本应用发起的合并冲突后，立即尝试 abort，并检查退出码和恢复结果；只有主检出恢复安全后，才允许在已验证的 linked Worktree 中准备冲突现场。普通干净基线应恢复干净；强制合并恢复原先未提交改动，不能把原有改动误报成恢复失败。不得修改既有 stash 保留、不自动 drop 与清理前置条件。

在 Worktree 内合并的是后端刚解析并固定的目标分支 OID，不是后续随时可能变化的分支字符串。真实分支名用于展示，OID 用于校验。

| Git 来源 | 实际含义 | UI 位置 | API 语义 |
|---|---|---|---|
| stage 1 | 公共祖先；add/add 时可能缺失 | 仅解析/比较，不作为取舍按钮 | ancestor |
| stage 2 / ours | Worktree 当前分支 | 右栏 | worktree |
| stage 3 / theirs | 本轮固定的目标分支 | 左栏 | base_branch |

不能按 diff3 第一段、第二段的顺序命名左右：标记中的第一段是 ours，即右栏。禁止在 UI 中使用含混的 ours/theirs；按钮写实际分支名。Worktree 解完本轮后，只有目标分支未变化时才能利用祖先关系避免同一轮冲突；目标前移可能再次冲突，不能承诺一次解决后永不冲突。

不支持 WSL/SSH Worktree，不新增 SQLite 表；复用既有 Monaco 依赖。按用户修订新增 `worktree-conflict` 原生视图标签类别，与终端/文件标签共用 pane/workspan，不套外层标签栏。该类别无 PTY、不参与终端恢复；全局宿主保存控制器、通过稳定 portal 停靠原生 pane，切换不重建编辑器。原生关闭必须 flush 草稿成功后才移除，Esc 不关闭；取消分屏若会移除此标签则提示先保存关闭。UI store 不持久化，但后端操作清单和已保存草稿必须持久化。不得接管外部 Git 正在进行的 merge/rebase/cherry-pick。

## 2. 模块边界与现有触点

- Rust 新增职责单一的 `features/projects/worktree_conflicts/` 模块：薄 commands、session/manifest、file_io、安全校验、parser、git_ops、tests，按职责分文件，不按数字分片。
- `features/projects/worktree.rs` 当前约 1857 行，`features/git/mod.rs` 约 1959 行，`useTerminalTabsController.ts` 约 1995 行；不得直接追加成片实现。薄适配仍须预留长度并通过 strict 架构检查。行数为修订时快照，实施前重新确认。
- 现有 `worktree_registration(project_path: &Path, worktree_path: &Path, branch: &str)` 接收三个参数。先核验注册关系，再解析真实路径/共同仓库/每个 Worktree 的 git-dir，不能只检查目录存在。
- 普通合并已有未检查 abort 结果的分支，必须补齐错误传递和恢复检查；不能声称主检出链路完全不改。强制合并仍沿用原有 stash 顺序及恢复语义。
- 普通 `git_stage_all`、`git_commit` 需要后端未完成仓库操作保护。现有普通 commit 只组装 HEAD 单父提交，不能用于完成本功能的 merge。公共仓库状态检查放基础设施窄模块，避免 Git 功能域反向依赖 projects。
- 前端新增轻量 workspace 状态与 App 级 `MergeWorkspaceHost`，挂在 compact/普通布局分支之外。TerminalTabs、Sidebar 与外部终端完成入口共用，不把内容状态继续塞入近上限的 controller。
- 跨功能复用通过现有或新增窄 `api/<module>` 入口；不导入 Git 功能域内部组件，不新增连带加载全部 UI/store 的聚合出口。
- `react-diff-view` 只负责呈现；必须验证结构化片段到共享行模型的适配，不能把复用库等同于自动获得虚拟化和正确对齐。

## 3. 操作状态机与入口顺序

状态：`none → preparing → resolving → ready → committing → completed`；另有 `aborting/aborted`、`stale`、`foreign`、`recovery_required`。状态由 Git 实态和清单共同决定，不由 UI 阶段推断。

1. 每次打开完成弹窗，先 probe，再进入普通 review/commit。受管会话即使 unmerged 数量已为零，仍须恢复到 ready/continue，而非普通 commit。foreign/stale/recovery_required 展示诊断和安全出口。
2. 普通合并冲突返回前，确认本次主检出的 abort/恢复成功。失败留存诊断并阻断准备、重试合并和清理，不能返回普通可解决冲突态。
3. prepare 检查注册身份、分支/OID、Worktree 的干净 index/工作目录、无其他仓库操作，以及主检出恢复闸门。Worktree 有未提交内容时先走既有审查提交路径，不自动 stash 或覆盖；untracked 阻挡文件同样拒绝。
4. 在 Git 变更前原子写 preparing intent，记录起点 HEAD、固定目标 OID、干净基线与 operationId，再执行固定 OID 的 diff3 merge。成功、快进、无变化、真实 unmerged 冲突、hook/其他失败按 Git 实态分别处理，不把非零退出码统称冲突。
5. 仅已证明由本操作创建且 HEAD/MERGE_HEAD 相符的现场进入 resolving。仅存在 MERGE_HEAD 不足以认领；缺少清单或无法证明归属时 foreign/recovery_required，保持现场。
6. 逐块选择和手动修改只保存草稿；全部块确认且版本核验后，才允许“保存并标记此文件已解决”。成功暂存后记录凭证，所有原始冲突均确认且 index 无 unmerged 才进入 ready。
7. continue 走专用双父 merge 提交路径，成功后检查新提交父 OID、tree 与预期一致、MERGE_HEAD 清除。hook 失败保留可恢复状态；不静默绕过 hook。
8. 关闭面板不 abort。先 flush 草稿，失败或仍有未保存修改时提示重试/明确放弃本次未保存编辑/取消关闭，不能悄悄丢失已保存块进度。
9. abort 仅适用于匹配的受管现场。先核验已知写入及当前文件/index，没有外部修改才可执行；否则拒绝自动 abort，保留诊断。不得强制 reset 或清理未知文件。
10. continue 后重新打开相同 Worktree 的完成流程；主检出重新解析目标 OID，执行原有普通/强制合并规则。目标前移产生新冲突时，在主检出安全恢复后新建一轮，不复用旧 OID 的选择凭证。只有主检出合并成功且 stash 恢复条件满足才能清理 Worktree。

### 3.1 模态交接与可访问性

传递显式 `{projectId, worktreeId, baseBranch, returnStep}`，不能依赖关闭弹窗后已被清空的 finishTarget。先保存返回上下文、卸载 Radix Dialog（解除 focus trap/inert），再挂载 App 级 workspace 并设置初始焦点；禁止只提升 z-index 将面板盖在仍存活的模态上。关闭/continue 时核验实体仍存在，恢复正确入口和焦点；实体被删除则显示明确错误，不能串到另一个 Worktree。compact、Sidebar、TerminalTabs、外部终端同路径。

### 3.2 主检出恢复闸门

主检出合并 intent/恢复记录必须跨窗口和重启有效；在可能改变 Git 状态之前落盘，按现有合并锁串行。保存基线、操作阶段、abort/restore 结果与 stash OID，不存秘密或整份大文件。应用退出、关闭弹窗不能清除此闸门。

增加显式“重新检查恢复状态”操作：只读检查注册身份、当前操作状态、HEAD/index/工作目录与已知基线，能证明恢复完成才自动解除；外部手动修复但无法自动证明时展示差异和保留的 stash OID，要求用户明确确认已处理原有改动并记录确认，仍拒绝存在未完成操作/unmerged/其他正在执行写入的现场。该操作不自动 apply/drop stash、不 merge、不 abort。正常保留 stash 的既有策略不是错误，不能仅因 stash 条目仍存在而永久阻断。

## 4. 持久化、版本与并发

- 使用 `git rev-parse --absolute-git-dir` 对应的每 Worktree 私有目录，存放 `cli-manager/conflict-resolution/<sessionId>/`。不能使用 common-dir 单一文件混淆多个 Worktree。
- 清单带 schemaVersion、sessionId、状态、revision、原始 HEAD/目标 OID、操作 ID 与进度。原始冲突集合分片/分页保存内部 fileId、原始 Git 路径、stage modes/OIDs/缺失侧；保存自动合并的非冲突 index 基线。不能从后续 `ls-files -u` 反推已经消失的已解决文件。
- 初始枚举只读批量 Git 元数据，不读每个冲突文件的内容。内容/工作文件指纹在详情或写入时按需获取；大文件流式指纹，不全量载入内存。需要整体核验时批量扫描 Git 状态/index，不能每文件启动一个 Git。
- 草稿按文件保存块选择/编辑、稳定块 ID（原始偏移 + 内容哈希）、源版本。可编辑文件首次打开时保存有上限的原始冲突源快照，用于重开恢复与无损重建；不复制全部二进制/大文件。
- resolved receipt 保存期望 index mode/OID 或删除、源版本与确认信息。已暂存文件仍保留原始集合中的历史进度；总数=已解决+未解决，草稿是未解决子集。
- manifest、草稿、intent、receipt 使用同目录临时文件、flush、原子替换；Windows 替换失败保留旧完整版本并报错。实现须验证崩溃一致性，不宣称文件与 Git index 是单一事务。
- 列表 snapshot/cursor 使用独立 membership revision；草稿 revision 不使每次 300ms 保存都触发整表重建。列表身份变动拒绝旧游标并重取，不能漏项或重复统计。
- 所有写操作携带 session revision + 文件版本 + operationId。同 ID 同 payload 返回已有结果或进行只读 reconcile；同 ID 不同 payload 拒绝。token 必须匹配 HEAD、MERGE_HEAD、stage、工作文件指纹及草稿版本；mtime 不足以防止并发覆盖。
- stage/continue 前比较完整语义 index 与基线+receipts，检测无关文件被外部暂存。先前已解决文件被改写、重新冲突或外部 commit 时转 stale，不沿用旧凭证。
- 应用内单飞 + 跨应用实例短锁覆盖校验→Git 写→清单更新，固定仓库/主检出锁→Worktree 锁顺序，兼容现有 WORKTREE_MERGE_LOCK。不持锁等待用户选择。崩溃后通过 OS 锁释放与持久化 intent 恢复，不能仅按锁文件年龄抢锁。
- 外部 Git 不遵循应用锁。使用 Git 自身 index/ref 锁及操作前后复核，失败保守进入 stale/recovery_required；不声称能彻底排除第三方同时写工作文件的 TOCTOU。不删除别人的 index.lock。
- 读取返回同一版本快照；详情前后身份变化则返回 stale。前端每身份单飞、请求 epoch、取消旧请求；后端支持协作取消或串行替换，前端丢弃响应不等于底层进程已取消。写后才触发一次合并刷新。

## 5. IPC 契约（拟新增，实施前冻结）

后端由 project/worktree 身份重新解析路径；客户端缓存路径不能作为授权。fileId 是清单内不透明键，展示路径不参与写入。API 不接受任意文件路径或任意 shell。

- `ConflictSessionSnapshot`：sessionId、revision、state、两分支展示名/固定 OID、total/resolved/unresolved/draftCount、mainRecovery、listSnapshotId。
- `ConflictFileEntry`：fileId、displayPath、stage/缺失侧摘要、resolutionState、capability（pending/blocks/whole_file/external_only）、reason。pending 时禁止逐块入口；不得为给列表分类而预读所有文件。
- `ConflictFileVersion`：后端 opaque CAS token，绑定源、当前文件/index/session 和草稿版本。
- `ConflictFileDetail` 判别联合：editable 返回有界源片段/偏移/块/格式/草稿；fallback 返回原因、可用整取动作和版本。不返回能够保存的截断内容。详情令牌超大文件可流式计算。
- 整取 API 仅接受 `base_branch | worktree`；缺失侧是 delete，不是 checkout 一个不存在的 stage。

| 命令 | 输入/主要结果 | 约束 |
|---|---|---|
| git_worktree_probe_conflicts | context → none/受管 snapshot/foreign/recovery | 完成入口先调用；不改变 Git |
| git_worktree_prepare_conflicts | context、expected HEAD/base OID、operationId → snapshot | 后端再次解析比对，写 preparing intent |
| git_worktree_conflict_status | context、sessionId、snapshot/cursor、limit → 分页 | limit≤200；原始集合+receipt，不只 unmerged |
| git_worktree_conflict_file | context、sessionId、fileId、request epoch → detail | 单内容请求、有界读取 |
| git_worktree_save_conflict_draft | context、sessionId、fileId、版本、块选择/编辑、operationId | 仅保存草稿；也受字节与块数限制 |
| git_worktree_take_conflict_side | context、sessionId、fileId、版本、语义 side、operationId | 安全整取/删除后精确暂存并保存 receipt |
| git_worktree_resolve_conflict_file | context、sessionId、fileId、版本、draftRevision、operationId | 从受管源与全部确认块重建，不接受整份任意 raw 内容覆盖 |
| git_worktree_continue_conflicts | context、sessionId、revision、operationId | 校验完整 index/receipts，专用双父提交 |
| git_worktree_abort_conflicts | context、sessionId、revision、operationId | 仅自身现场且无未知改动 |
| git_worktree_recheck_main_recovery | context、expectedRecoveryRevision、可选明确确认 → recovery 状态 | §3.2；不执行恢复/合并 Git 写操作 |

错误采用稳定 typed code：identity/path_invalid、foreign_operation、stale、busy、unsupported、limit_exceeded、io/git_failed、recovery_required；detail 携带可诊断阶段，不靠解析英文 stderr 决策。旧合并返回形状保持兼容，新增 abort/恢复失败不能降级成普通冲突。普通 stage-all/commit 明确拒绝未完成 merge/rebase/cherry-pick 等仓库操作，相关现有调用者必须验证。

## 6. 文件安全、格式与写入事务

### 6.1 路径与冲突能力

1. fileId 必须属于本会话原始冲突集合，当前 stages 与预期一致。后端不接受客户端自造 path。
2. 同时校验词法与实际路径包含关系；拒绝越界 `..`、绝对/drive-relative 路径、UNC/device 前缀、ADS、NUL、Git 元数据路径。处理 Windows 大小写/分隔符规则，不能简单字符串 startsWith。
3. 验证 Worktree 注册、canonical root、文件及全部父路径；缺失文件检查最近存在父目录。遇 symlink/junction/reparse point 拒绝此轮写入；stage mode 120000/160000、复杂重命名组返回 external_only，不部分删除一组路径。
4. Git 路径用 NUL 分隔协议读取；命令参数数组与 literal pathspec、`--` 分隔，禁止 shell 拼接。空格/Unicode/前导连字符/括号按合法字面路径处理；无法安全表示的路径拒绝，不猜。
5. binary、lockfile、非 UTF-8、超限、无可解析标记的普通文件支持安全整取存在侧；缺失侧删除。畸形/不支持解析不能标已解决。复杂类型 external_only 显示原因与取消，不伪造可执行动作。

### 6.2 文本解析与无损拼装

支持 UTF-8（可含 BOM）、普通/diff3 标记、add/add；读取 attributes 中 conflict-marker-size，不能写死 7。祖先段只用于对照，不作为左右来源。无标记但 index unmerged 的文件仍是冲突。

保留源 byte offsets、未编辑原始片段、CRLF/LF、BOM 和末尾换行；不通过 `lines().join()` 重建整文件。未修改片段逐字节保留，块选择保留其源字节；混合换行手动编辑须保持每行元数据，做不到则禁用手动编辑并整取降级。嵌套/畸形/有歧义标记、非 UTF-8 安全降级。普通源码中的合法标记形似文本不能被全局正则误判；验证绑定已识别原始块，新增疑似未处理标记须显式拒绝/解释，不能用 `git add` 作为确认依据。

草稿 300ms debounce，保存串行且合并最新修改，关闭/切文件先 flush；保存失败不清 dirty。切文件前 flush 后释放旧大缓冲区，再请求新文件。逐块草稿不改变工作文件或 index。所有块经确认后后端按源偏移重建，再次检查输出字节与 IPC/请求限制。

### 6.3 写入与崩溃恢复

先落盘 write intent（旧/新指纹、期望 stage/index、动作），再原子替换本文件或按缺失侧删除，随后精确 `git add`/`git rm`，最后 receipt。整取存在侧沿用 Git checkout stage/filter/可执行位语义，校验实际 stage OID/mode；属性或 clean/smudge filter 不可安全保持时保守降级，不能绕过 filter 手工写 blob 后宣称无损。

文件写成功但 add 失败时进入 recovery_required，留存 intent，不增加已解决数；重开比较实际工作文件和 index，只有证明属于已完成的本次操作才补 receipt。若外部改动介入拒绝自动重写。磁盘满/权限/替换失败不破坏旧清单；二进制大文件整取也不将整个文件装入 JSON。

continue 前确认原始冲突集合全部有匹配 receipt、无 unmerged、无未知暂存；拒绝普通 stage-all 已暂存的未确认 marker。commit hook 失败保留 ready 和诊断；提交成功但响应/manifest 更新丢失时，通过已记 intent、实际 tree、双父 OID 与操作状态证明完成，不再次提交。不确定时 recovery_required，不只检查 HEAD 变化。

## 7. 界面与既有功能回归

- 用户批准改为 Monaco 三栏：目标原文只读 / 中央结果直接编辑 / Worktree 原文只读，移除下方输入框和手动编辑按钮。每次只挂载当前块的三个模型，切块/关闭释放；前后及下一未处理导航切换块。各栏独立滚动，不互抄 scroll 事件。文件列表仍为 28px 步长、4 overscan，代码行 24px，由 Monaco 渲染可见区域。
- 冲突内容行、列宽及换行分析由一次性 Worker 构建；成功、失败、切换、关闭及 15 秒超时终止。失败保留源文件/草稿并提供重试，不同步回退到主线程扫描。模型身份包含 fileId/sourceHash/capability/markerSize/source；仅 draft/version 改变不重建，Monaco 的挂载/编辑回调保持稳定，相同内容的保存回读不挪光标、不清撤销栈。
- Monaco 延迟加载并复用现有依赖；超过 128 Ki 字符或 2,000 个 LF 换行的大块降为纯文本，单行高亮上限 2,000 字符，关闭 minimap/建议等昂贵功能。沿用 300ms 草稿防抖与串行 CAS；非冲突文本仍由后端保留，不构建可编辑全文件。文件虚拟化、当前块模型数量、视口 DOM 与关闭释放分别验收；旧 renderer 性能证据不覆盖新编辑器。
- 完成弹窗采用 max-height（如 85vh）、flex 列容器、body min-height:0 + overflow:auto、非收缩 footer。长错误文本换行；400px 高度下操作可达。
- stash 恢复错误继续禁用危险操作，按钮旁常驻说明并提供 title/aria；取消及重新检查可用，不能以“解禁按钮”替代修复根因。
- 冲突页脚左为取消、主按钮为解决冲突，不新增终端按钮，不向用户暴露“降级”等实现术语。面板标签、取舍按钮和进度写真实分支名；相同短名时显示完整名/必要的 OID 辅助信息。
- 全部按钮/状态/错误/aria 同步 zh-CN、en-US，通过领域 messages 维护；手动切换验证，两种语言均保持 24 小时时间格式。

## 8. 性能预算与测量方法

以下是本轮建议冻结的初始预算。未实测前不能标通过；硬件不满足时先定位与优化，变更预算需说明证据，不能事后静默放宽。Git/hook 自身耗时与应用开销分别记录，端到端耗时也必须保留。

### 8.1 后端和内存硬上限

| 项目 | 门槛与降级 |
|---|---|
| 可编辑源/重建输出 | 各≤2 MiB；流式读取最多上限+1，超限 whole_file |
| 行数 / 单行字节 / 冲突块数 | ≤20,000 / ≤64 KiB / ≤2,000；独立检查，不能只算行数 |
| 单次序列化详情/草稿请求 | ≤8 MiB UTF-8 JSON 字节；考虑 JSON 转义，不仅检查 Rust 字符串长度 |
| 文件列表分页 | ≤200 条；批量 Git 元数据，禁止 N 个文件 N 次 Git 进程 |
| 编辑缓冲与并发 | 同时最多 1 份活动编辑文件、1 个内容请求；旧响应无权回填；关闭释放 |

原始冲突集合/进度可落盘分页，不在每次响应附全量数据。binary 分类按需，pending 默认关闭逐块动作。大量元数据必须一次变换时才复用 >5,000 条 Worker 阈值、15s 超时、失败后每 1,000 条 yield 回退；真正分页的小批次不机械创建 Worker，取消不触发全量回退。

### 8.2 实测场景与验收值

记录 Windows、WebView2/Chromium、CPU/内存、构建模式、Git版本、fixture 文件数/总字节/块数；每组至少 5 次冷启动、20 次热运行，保存 p50/p95/max 和采样原始值。不能只用 mock 单元测试替代 WebView2/浏览器实测。

| 场景 | 验收门槛 |
|---|---|
| 64,887 个冲突元数据项、520px 列表视口 | 挂载行≤40（可额外保留1个键盘焦点行）；首/中/末页可达，计数准确，不能截成前200条 |
| 首屏元数据已返回到列表可交互 | p95≤500ms；另记真实 Git 枚举→首屏的端到端时间，禁止隐藏此段 |
| 接近所有允许上限的可编辑文件组合 | 详情请求开始→首次可交互渲染 p95≤2s（本地无慢filter fixture）；分别测解析/IPC/渲染 |
| 已打开文件的按块选择与滚动 | 选择→绘制 p95≤100ms；无应用代码造成的>100ms主线程长任务 |
| 连续100次切换/刷新、A→B→A竞态 | 内容在途峰值≤1，同身份状态刷新单飞，旧响应不覆盖新选择 |
| 同一面板打开/关闭20次 | 支持GC的仪器环境中稳定基线后堆增量≤max(10 MiB,10%)，无随次数线性累积的 detached DOM/Worker/listener；另记WebView2进程RSS |
| 托盘/隐藏窗口与恢复 | 隐藏不后台轮询；恢复合并为一次刷新，无进程风暴或抢焦点 |
| 超限/二进制大文件 | 不生成巨型详情JSON、不挂载内容；流式操作可取消并保留状态，不阻塞UI线程 |

列表元数据生成/枚举成本随 N 增长不可伪称 O(1)。分别报告 1k/10k/64,887 档耗时与峰值内存，检查是否存在重复全量排序/扫描、每文件进程或二次复杂度。真实多文件 Git fixture 验证后端，元数据压力 fixture 验证前端，二者报告分开。

## 2026-10-07 · 自适应与列宽修订

- 根因：三栏 Grid 固定 `min-width:720px` / 每栏至少 240px，外层再分出文件栏，实际终端 pane 的可用宽度不足时只能整体横向滚动；栏头不可收缩子项又撑出窄列。
- 发现清单：CSS Grid/标题/工具栏负责边界；新增局部 `ConflictPaneLayout` 负责布局和交互，纯列宽函数负责约束；Workspace 持有临时比例，经 BlockEditor 传给 MonacoEditor，模型 key/内容/草稿回调保持。终端已有侧栏拖拽绑定 settings 与终端内部模块，不适合直接复用；沿用其帧节流思想，不新增依赖或跨域实现入口。
- Grid 使用三段比例轨道和两个 6px 分隔线，所有代码容器 `min-width:0`。最小栏宽为 min(100px, 可用代码宽/3)；收缩时重新约束显示比例，放大可恢复偏好比例。
- Pointer capture 管理拖动，requestAnimationFrame 合并预览，仅结束时提交比例至工作区；pointercancel/lost capture/blur/容器尺寸变化取消当前手势，卸载释放帧和监听。键盘左右箭头调宽，Home/End 到边界，Enter/双击恢复等宽。可访问 separator 绑定受控列并同步范围。
- 只核验本轮 UI 与列宽计算：纯函数边界测试、独立无服务 React 布局夹具（不启动 CLI-Manager/Git/Vite）、TypeScript/strict 架构/CSS/双语。原生 WebView2 的编辑光标、IME 与真实主题观感仍需用户运行验收，不重跑全量构建或性能基准。

## 9. 分阶段验证与停止条件

### 2026-10-07 · 块解决与文件应用状态

- 根因：展示层把块草稿 choice 的“已处理”和 Git 解决凭据的“未解决”直接并列，未说明中间仍需应用文件，导致用户误以为接受右侧无效；控制器选择、保存和显式写入链路正常，因此修复落在 UI 状态映射与下一步入口。
- 发现清单：`ConflictController.choose/flush/resolve`、IPC protocol、Rust `session_write` 已核对，保持原语义；`conflictProgress` 统一当前详情的块完成度与文件状态；Workspace 接入独立应用提示条，FileList 使用同一派生状态；Monaco 保持选择回调，仅修改双语块状态文案；CSS、双语帮助、测试与交付记录同步。
- 用户明确选择保留“应用结果”按钮：块已解决属于草稿状态，应用成功才计入后端文件进度，最终合并仍需用户提交。
- 场景：单块/多块、空编辑、陈旧 choice key、无块/不支持逐块、保存中/失败、应用失败需重检、切文件恢复、中英文/窄宽。窗口焦点/分屏/Workspan/终端运行环境不改变这组派生状态；不增加事件监听、IPC、后台自动写入或持久化协议。
- GitNexus 对未跟踪组件 impact 返回 UNKNOWN，使用契约及直接引用定位；主要调用链为 Host → Workspace → FileList/Confirmation，BlockEditor → Monaco → controller.choose。不视索引缺失为零影响。

- 方案阶段：需求—用例覆盖、契约/路径一致性、隔离 Git 语义验证；保持 task planning，不将 AC 勾选为通过。
- 实现阶段：先模块拆分与薄入口、Git 状态/恢复/文件安全测试，再接 UI。已有文件接近上限，开始修改符号前必须 impact；高风险先报告。
- 功能 gate：主路径、对称缺失侧、所有状态迁移、外部/并发/崩溃、安全路径、格式往返、compact/模态/语言全部通过。
- 性能 gate：§8 有真实采样、DOM/内存/并发证据；没有浏览器/WebView2环境只能标待验证或阻塞。
- 工程 gate：独立 `npm run check:architecture -- --strict`、定向 node/Rust 测试、`npx tsc --noEmit`、`npm run build` 及受影响 Rust 编译检查；静态检查不是性能证明。
- 不沿用旧会话的编译失败或工具故障作为当前事实；现场重跑失败须记录命令、错误、影响范围。所有必须 gate 通过才可交付/清理；本次仅修订方案，不启动产品实现。
