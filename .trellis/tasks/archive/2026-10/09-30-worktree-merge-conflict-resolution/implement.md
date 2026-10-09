# Worktree 合并冲突解决 — 实施

> 用户已批准 V1.4.2 产品实现，task 为 in_progress。P1 后端闭环和 P2 全局工作区已接入，当前推进 P3 验收；未打勾不等于完全未实施，但只有完整满足验收才可标记通过。实际范围及测试证据见 `validation.md`。

## 开始实现前

- [ ] 只读检查分支/upstream/工作区并报告；发现领先/落后仅告知，不擅自同步或提交。只处理本任务文件。
- [ ] 读取 PRD、design、用例矩阵及 implement.jsonl 中契约；按 fix-triage §5 核对 Windows/linked Worktree/外部终端/compact/分屏/托盘/多窗口场景。
- [ ] 确认本轮不新增 AI 解决按钮、不新增 TerminalSessionKind、不在完成弹窗新增终端按钮；UI store 临时，后端清单/已保存草稿持久化。
- [ ] 明确主检出“成功 abort 后恢复基线”和“abort/restore 失败阻断”两种结果，不承诺任何时刻都没有 MERGE_HEAD。
- [ ] 修改符号前跑 GitNexus impact，报告直接调用者、受影响流程与风险。若工具失败，保留原始故障证据并按仓库降级规范检查契约/调用者，不能把工具失败写成影响为零。索引明确提示 stale 才按规则刷新，不沿用旧会话故障。
- [x] 用户批准后启动已有 task，状态 in_progress；本次不创建重复任务。
- [x] 使用用户指定 V1.4.2，同步 CHANGELOG.md 和 docs/功能清单.md；准确标记实施中范围，不把安全内核写成完整可用功能。

## P0 · 冻结契约与验证夹具（后续实施第一步）

1. 对照 design §2 定位当前符号、入口和真实文件长度。先分离必要的小模块，禁止向 1857/1959/1995 行附近文件继续堆叠实现；不做无关迁移。
2. 冻结 design §5 的类型、语义 side、错误码、版本/operationId、分页游标与恢复接口；前后端采用同一契约，不使用旧版 raw filepath/整文件任意覆盖签名。
3. 创建 Rust 临时仓库 fixture：普通/强制合并、对称 modify/delete、add/add、binary/lock、CRLF/BOM、无标记、目标前移；禁用 fixture hooks/filter 后另设显式 hook/filter 测试。所有 fixture 隔离，禁止使用开发者仓库制造冲突。
4. 先写失败测试，重点覆盖普通 abort 结果被忽略、stage 方向反转、缺失 stage checkout 失败、stage-all 暂存 marker 仍能提交。
5. 用固定片段原型验证窄 renderer 的 split/虚拟化/块高度/键盘选区，证明复用可行后再接大面板。
6. Gate P0：契约、 fixture、模块写入范围清楚；不得以本文孤立 Git 实验代替产品失败测试。

## P1 · 后端安全与可恢复闭环

7. 新增 `features/projects/worktree_conflicts/` 中职责模块和薄命令适配；更新命令注册，测试 invoke 名称与参数形状，保持旧正常合并接口兼容。
8. 修复主检出普通路径 abort 错误处理；持久化主检出操作/恢复闸门，保留强制合并 stash OID 和既有恢复/保留规则。实现只读重检及无法自动证明时明确确认的恢复流程，不以关闭弹窗清空闸门。
9. 实现 probe → prepare intent → 固定 OID merge → resolving/ready/其他结果。先校验真实 registration 三参、Git common-dir/git-dir、HEAD 与目录状态；拒绝脏 Worktree、未知仓库操作。
10. 实现原始冲突集合、分页元数据、按需详情、分文件原始源快照/草稿、resolved receipt、崩溃 reconcile。列表 revision 与 draft revision 分离，避免每次编辑刷新全部列表。
11. 实现 fileId 路径白名单、词法+canonical 包含关系、父目录/reparse 检查、NUL Git 元数据、literal pathspec；symlink/gitlink/复杂 rename 组明确 external_only。
12. 实现 byte-offset parser 与格式保留；两段/diff3/自定义 marker size；无标记依赖 index 实态。独立执行字节、行、单行、块和 JSON 字节上限，超限仅返回不可编辑降级元数据。
13. 实现保存草稿、全块确认 finalize、整取存在侧/删除缺失侧、精确暂存与写入日志；所有请求做 CAS 和操作幂等。部分块绝不 stage。
14. 引入共享仓库操作 guard，普通 stage-all/commit 拒绝未完成操作；专用 continue 校验完整 index+receipt，建立正确双父提交并处理 hook/响应丢失。
15. 实现短锁、跨窗口/实例冲突、external Git stale、abort 自有现场校验与失败恢复；不删除未知锁，不自动 reset。
16. Gate P1：后端功能/安全/恢复定向测试通过，再接真实 UI 写操作；未解决数据丢失/错误归属/路径逃逸不得进入 P2。

## P2 · 面板入口、可访问性与草稿体验

17. 完成弹窗设置限高 flex、可滚动 body、不收缩 footer；危险按钮旁常驻恢复错误说明并补 title/aria，保持禁用与取消可用。
18. 在正常 review/commit 之前 probe；从 Sidebar、TerminalTabs、compact、外部终端入口均可恢复 resolving/ready。不能只在本次 merge 返回 error 后显示入口。
19. 新增 App 级 host、轻量 workspace state、独立请求/草稿 hook。host 在 compact 布局条件之外；不向近上限的 terminal controller 加成片状态逻辑。
20. 明确保存 finish context，先卸载 Radix Dialog 再打开面板、转移焦点；关闭/continue 返回相同 Worktree 和正确步骤，处理实体消失，不复用已清空的 finishTarget。
21. 列表分页+虚拟化、内容有界；用户批准改为 Monaco 目标原文/中央结果/Worktree 原文三栏，stage2→右、stage3→左不变。延迟加载且仅挂载当前块的三个模型，各栏独立滚动，切块/关闭释放，大块使用纯文本；不再挂载下方输入框或手动编辑按钮。
22. 草稿 debounce+串行合并、切文件/关闭前 flush、dirty 提示；请求 epoch 和底层协作取消/串行替换，A→B→A 不回填旧结果。切文件释放旧缓冲，不保留无限内容缓存。
23. pending/fallback/external_only 各有准确能力说明，不渲染非法按钮；整取按钮显示实际分支，缺失侧明确表示删除。所有用户可见和 aria 文案同时维护 zh-CN/en-US。
24. continue 后回到原完成流程；目标分支前移可新建下一轮。清理只走原有主检出合并/恢复成功 gate，不因 Worktree 内 continue 成功立即删除。
25. Gate P2：功能用例及实际模态焦点/compact/语言检查通过，无不完整链路以“稍后处理”漏到性能阶段。

## P3 · 定向回归、性能与工程交付

### 2026-10-07 · 块状态反馈实施记录

- 已完成：统一块选择完成度派生；当前文件已解决待应用状态；编辑区“应用结果”提示条；全局已应用文件计数及双语帮助。保持原控制器草稿、CAS、显式文件写入和显式最终合并逻辑。
- 已完成：20 项定向控制器/独立浏览器回归，类型、CSS、strict 架构检查及 V1.4.2 两份变更记录；实际证据和未验收边界见 validation.md。

### 当前执行约束（2026-09-30）

用户要求尽快收尾、避免过度测试，且所需测试由用户启动。不得自动编译、启动应用或重新执行长时间基准；以下命令仅保留为可选复现入口，不作为自动运行清单。索引读取优化及 11 项必要回归已完成，1k/10k 复测结果已保存，64,887 档已中止且不标通过；实际状态以 validation.md 为准。

### 已有检查入口（实施时执行，不代表本轮已执行）

```powershell
# 独立架构 gate，不绑定 build；不可新增豁免
npm run check:architecture -- --strict
# 按受影响范围选择已有回归，不机械启动全库
node --test scripts/gitWorkspace.test.mjs scripts/gitDiffWorkspace.test.mjs scripts/gitDiffViewerArchitecture.test.mjs
node --test scripts/gitDiffInteractionA11y.test.mjs scripts/gitDiffLargePerformance.test.mjs scripts/gitChangesLargePerformance.test.mjs
npx tsc --noEmit
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
```

已实现的入口：`scripts/worktreeMergeConflicts.test.mjs`、`scripts/worktreeRecoveryGate.test.mjs`、`scripts/worktreeConflicts.browser.test.mjs`、`scripts/worktreeConflicts.boundaries.test.mjs` 和 `scripts/worktreeConflicts.performance.test.mjs`。后两类浏览器测试使用独立临时构建及 Edge，Git IPC 为替身，不启动 CLI-Manager 或服务。性能脚本通过 `CONFLICT_PERF_REPORT` 写入原始证据。Rust 测试位于 `worktree_conflicts` 职责模块；忽略测试 `native_scale_evidence` 用 `CONFLICT_NATIVE_REPORT` 指定输出后显式运行，建立隔离临时 Git fixture，记录 1k/10k/64,887 文件的准备耗时、5 次新进程冷读 / 20 次预热后读取及完整分页可达性。该原生命令测试不等于 Tauri IPC/WebView2，prepare 每档只有一次，不冒充五次冷 prepare。禁止空过滤零测试被记为通过。

26. 执行 `tests/worktree-merge-conflict-resolution-test-cases.md`，逐项写实际结果/日志/截图或测量数据；功能、安全、恢复、性能分开计数。必要跨层回归必须包含薄命令注册、类型、guard 的既有调用者。
27. design §8 压测记录 5冷/20热采样、p50/p95/max、硬件、fixture规模、挂载DOM、单飞峰值、长任务、GC堆和WebView2 RSS。没有浏览器实测时标待验证/阻塞，不能把静态扫描或 mock timing 标性能通过。
28. 人工核验中英文、实际分支名、400px高窗口长错误、Tab/Escape焦点、compact/外部终端、托盘恢复、多窗口争用；旧完成功能正常回归。
29. 更新 backend worktree-isolation 与 frontend 性能/IPC 契约，保持旧安全保证；把本轮有依据的新增要求写入，不添加不可能的全局 MERGE_HEAD 断言。更新版本化 CHANGELOG 和准确功能板块。
30. 更新 validation.md，把产品 gate 从未执行改成有证据的实际结果；仅全部关键用例/预算/工程检查通过才宣布功能性能正常。提交前按规则 detect_changes，且不主动提交。

## 停止与回退规则

### 2026-10-07 追加执行项（已获用户实施授权）

1. 移除三栏固定宽度下限和整体横向滚动，修复栏头、工具栏与侧栏的窄窗口收缩。
2. 新增纯列宽约束函数和局部可拖动布局组件；工作区持有临时比例，保留原 Monaco 内容生命周期。
3. 覆盖双分隔线拖拽/键盘/取消/视口变化/卸载，核验三栏始终在布局边界内和子树不重挂。
4. 运行定向 Node 测试、无服务布局夹具（工具可用时）、类型/CSS/strict 架构检查；更新 V1.4.2 两份记录、契约与 validation.md。不启动应用或后台服务，不运行完整构建/基准。
5. 回退仅撤销本轮列宽组件接线与 CSS，保留用户既有未提交合并实现。整项原任务仍有原生验收，不能据此标记全部完成。

- 任一错误归属、数据丢失、路径越界、未知外部修改或无法证明恢复：停止写操作，保留 intent/诊断，禁止以重试覆盖现场。
- 阶段 gate 未通过不推进后续依赖阶段；性能预算失败先分析真实瓶颈，不通过截掉文件、丢弃草稿、关闭安全检查来达标。
- 本轮方案修订通过只表示可以开始 P0 实现，不表示产品已完成；保持所有产品 AC 未勾选。
- 仍不做 AI 解决、WSL/SSH Worktree、复杂重命名组编辑或接管外部 merge，不新增弹窗终端入口。
