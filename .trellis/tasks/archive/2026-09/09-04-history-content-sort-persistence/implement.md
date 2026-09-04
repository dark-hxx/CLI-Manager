# 实施计划：会话历史内容排序与操作记忆

## 0. 开始条件

- 任务目录：09-04-history-content-sort-persistence。
- PRD、设计与本计划已完成审阅；用户已同意实现并执行 task.py start，当前进入实现与验收。
- 开始实现前重新执行只读 Git 分支检查，并保留用户已有工作区改动。当前检查结果为 master 相对 origin/master 领先 11、落后 0、未分叉；工作区已有其他任务改动，不纳入本任务。
- 开始写源代码前读取 trellis-before-dev，并按它加载 .trellis/spec 中与目标包相关的规则。
- 每次修改已有函数、组件、hook、store action 或后端解析函数前，先对该 symbol 执行 GitNexus impact(direction=upstream)。若工具仍因索引能力受限而无法解析，记录降级原因，使用相关契约和 rg 完成触点确认；若返回 HIGH/CRITICAL，先停下报告风险再编辑。

## 1. 前端类型、设置和工具

- 新增共享的历史详情排序类型、六页签常量、默认映射、方向校验和纯反转 helper。
- 在 settingsStore 的 Settings、默认值、读取迁移和 store action 中加入 historyDetailSortDirections。
- 实现先更新内存、串行持久化、失败只记 debug 日志的专用 action；验证多次快速切换时不会出现旧写入覆盖新写入。
- 补充 i18n 的正序/倒序 label、tooltip、aria 文案，确认 zh-CN/en-US 和现有 zh-TW fallback。

## 2. HistoryWorkspace 与 SessionDetailPane

- HistoryWorkspace 读取 settingsStore 的六页签方向并将当前方向传给 SessionDetailPane 及结构化子视图；切换方向调用专用持久化 action。
- 将对话/原文的 visible message 从 HistoryMessage[] 改为带原始 messageIndex 的条目投影。
- 实现正序头部窗口、倒序尾部窗口、倒序向早期消息扩展的分页逻辑；不使用 column-reverse。
- 保持虚拟 key、DOM ref、搜索结果、编辑/插入/删除、批量操作、跳转和加载更多使用 raw messageIndex。
- 调整搜索命中导航和 toggle/session change 后的滚动锚点；没有目标时到当前方向起点，有目标时按 raw index 展开并定位。
- 在页签栏旁增加仅对六个 sortable view 显示的原生排序按钮，补齐状态语义与键盘行为；canvas/context 不显示。

## 3. 结构化历史视图

- SessionTimelineView：过滤后反转时间事件，保留既有摘要和稳定 tie-breaker。
- SessionFileChangesView：反转变更节点，保留节点内部文件名、目录和操作排序。
- SessionToolDiagnosticsView：反转调用/错误/疑似事件，保留聚合统计；descending 的受限列表优先取最新窗口。
- SessionSubtaskTreeView：反转记录，固定主会话 root 和非时间层级关系。
- 检查各子视图 props、memo/cache 和 jump callback 不因新增方向参数破坏现有调用者。

## 4. Codex thread_name 后端解析

- 在 history command 层增加按来源范围隔离的 CodexThreadNameIndex 和安全 JSONL 读取/解析逻辑，覆盖本地 Windows、WSL。
- 将 resolver 接入 legacy history index、V2 catalog、直接 detail 的 summary/title 生成路径；复用现有 title 字段和 IPC 契约。
- 让 Codex session_index fingerprint 参与 legacy/catalog 的复用失效判断，并递增受影响的 parser/adapter 版本；不新增数据库列，不改 raw history。
- 在 history-core/ssh-agent 中读取远程 Codex 对应 config root 的 session_index.jsonl，把匹配的 thread_name 应用到 RemoteHistorySessionSummary；保留远程来源身份边界并递增远程 parser version。
- 处理缺失索引、坏行、空名称、权限失败、重复 id 和 id 不匹配的 fallback；增加日志但不让单个索引异常阻塞同步。
- 保持已有 session index 写入/转换逻辑兼容，避免把 AI 标题或手工 alias写回来源文件。

## 5. 前端标题优先级接线

- 确认历史列表、详情标题、搜索结果和 AI 标题成功/清除路径都经过同一解析链。
- 将 source title 中的 Codex thread_name 作为候选，不允许它覆盖手工 alias 或有效 AI 生成标题。
- 在统一刷新、重新打开详情和内部 alias/AI 操作完成时验证内存显示更新。

## 6. 测试与文档

- 先运行 GitNexus impact 覆盖本计划中实际将编辑的 symbol；实现后运行 detect_changes，确认变更范围只覆盖本任务的组件、store、历史解析、测试和文档。
- 增加前端纯函数/组件相关测试，覆盖方向投影、raw messageIndex、倒序分页、稳定顺序和设置迁移。
- 增加 Rust 单元测试，覆盖 Codex index 解析、来源隔离、title fallback、fingerprint 失效、远程同步和异常输入。
- 执行 npx tsc --noEmit、前端构建、cargo fmt --check（如仓库现有流程支持）、cargo check、cargo test 及相关 node 测试。
- 按仓库现有格式更新 CHANGELOG.md，未指定版本时使用 TEMP；同步更新 docs/功能清单.md 对应的历史会话功能板块。
- 对照 task-delivery-checklist 做最终检查；实现和验证完成后再运行 trellis-finish-work，提醒用户提交。

## 7. 风险与回滚

- 风险最高的是倒序虚拟列表与消息编辑坐标；通过独立 raw messageIndex 条目、纯投影和针对性跳转测试控制风险。
- Codex thread_name 读取失败必须是局部 fallback；任何来源索引异常不得阻塞主历史扫描。
- parser version/fingerprint 变化可能触发一次重建或重解析，但不会改写原始会话数据；如需回滚可撤销 resolver 接线和前端投影，旧缓存仍可由原有 parser 读取。
- 不修改用户已有的未提交文件；所有新增/修改文件在最终交付时单独列出。
