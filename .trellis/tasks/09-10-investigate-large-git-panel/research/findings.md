# 排查记录

## 根因陈述
Git 变更展示层没有按视口限制渲染量：默认全展开的递归树对每个变更挂载复杂 React 行组件并订阅整个 Git store；数万条数据使主线程渲染工作随文件总量增长，目录重复汇总和刷新重复建树进一步放大成本。因此应在树展示和状态刷新层消除无界工作，而非限制用户仓库文件数。

这是已确认的代码扩展性缺陷，也是 issue 的高置信主因；没有用户仓库/浏览器 trace，不能声称已量出现场完整卡死耗时或排除 Git 扫描延迟。

## 版本核对
通过 git show V1.3.9 检查旧目录 src/components/git/{GitChangesTree,GitTreeNode}.tsx、src/stores/gitStore.ts、src-tauri/src/commands/git.rs。递归全量挂载、整 store 订阅、默认空折叠集合、同步重建树、500 条以上跳过统计、spawn_blocking 均已存在。当前 master 架构迁移后对应下列路径，问题仍存在。

## 发现清单
| 触点 | 证据与判定 |
|---|---|
| GitChangesTree.tsx:26 | nodes.map 全部根节点，无虚拟化；确认主因入口 |
| GitTreeNode.tsx:60、63、420 | 递归挂载子树；每行 useGitStore() 无 selector；文件图标、ContextMenu、复选框等组件随文件数膨胀；确认主因 |
| gitStore.ts:261、1024 | collapsedDirs 默认及 reset 均为空，首次默认全展开；确认触发条件 |
| GitTreeNode.tsx:16、272–309 | 每次目录渲染 collectFileChanges，随后多次 filter/map；包括折叠目录；确认放大因素 |
| gitStore.ts:110、193、331 | 主线程排序/建两棵树；刷新无数据相等短路；确认长任务和重复成本 |
| GitChangesPanel.tsx:590–620 | 全量 filter/reduce/map 在渲染期执行，分支状态等无关更新也重复统计；确认放大因素 |
| gitStore.ts:306–357 | 每次 fetchChanges 都发请求；已有项目/仓库/Transport 身份守卫，但没有同身份请求合并，也没有同身份响应序号；确认并发放大和旧快照覆盖风险 |
| GitChangesPanel.tsx:467–540 | watcher、聚焦、可见性和轮询都能触发 fetchChanges；watcher 去抖不是请求完成合并；确认刷新入口 |
| gitTransport.ts:158、230；remote/api/sshRemoteGit.ts:172、217 | 本地直接 IPC，远程直接 request；前端两路均无同请求合并；数据全量返回 |
| Rust features/git/mod.rs:264；status.rs:44–70 | 查询在 spawn_blocking 执行，native/WSL 超过 500 条跳过行数统计；不能归因为 64,887 次逐文件 diff；扫描本身耗时未测 |
| Rust features/git/mod.rs:323–400 | 子仓库扫描限深，排除常见构建目录并在发现子仓库后停止递归；并行后台工作可能增加 I/O，但未证实为主因 |
| ssh-agent/src/git.rs:640–669 | 完整状态列表，超过 2000 条跳过 numstat；确认相同前端渲染问题适用，远程传输延迟待测 |
| features/git/snapshot.rs、mod.rs 的 collect_git_changes_from_repo | Replay 单独收集链路，不由打开变更树触发；本次不修改，确认非本次修复触点 |
| Git Diff Viewer | 已有 Hunk 虚拟化/Worker/大小限制；当前症状在选择文件之前发生；确认非首开变更树主因 |

以上前端路径除 remote 外均相对 src/features/git/；后端路径相对 src-tauri/src/。

## 规模实验
直接用 TypeScript AST 提取当前源码 buildTree、collectFileChanges、collectCompactDirectoryChain 在 Node 执行；未复制改写算法。每组 64,887 个 M 状态文件，三个路径分布。原始数据见 scale-results.json。

| 分布 | 同步建树 ms | 默认展开组件行数 | 目录汇总访问文件条目 | JSON 字节数 |
|---|---:|---:|---:|---:|
| 全部根目录 | 50.42 | 64887 | 0 | 4855416 |
| 100 个模块 | 112.60 | 64987 | 64887 | 5497796 |
| 深路径 + 100 个模块 | 172.21 | 64988 | 129774 | 6471101 |

组件行数由实际压缩目录规则计算，并非浏览器实测 DOM 节点数（真实 DOM 更多）。计时为本机单次微基准，不是用户现场总耗时。未计入 React render/commit、图标、DOM/layout、IPC、native Git 扫描。不能拿此结果证明主线程只阻塞 172 ms。

## 工具与影响范围
GitNexus query 的 FTS 缺失，关键字检索无结果；已改用可用的精确 context/impact 和领域契约+rg。无 stale-index 提示，未执行全库重建。
- GitChangesTree：LOW，直接调用者 GitChangesPanel。
- GitTreeNodeComponent：LOW，直接调用者 GitChangesTree，间接 GitChangesPanel。
- collectFileChanges：LOW，经行组件到面板。
- useGitStore（Function UID）：LOW，2 个直接调用者、3 个受影响符号，面板相关流程；图谱不能完整表示 Zustand 动态动作和 UI 事件，不能等同无并发风险。

## 场景判定
- 本地/WSL/SSH、主仓库/Worktree/子仓库：共享树渲染均受影响；保持既有环境和仓库身份路由。
- 根目录大量文件、宽目录、深路径、模块分组：均需虚拟化，默认折叠不能解决根目录大量文件。
- 已跟踪/未跟踪、M/D 筛选、A 的选择语义：完整数据保留；目录批量操作不能只处理可见行。
- 多终端/Workspan/项目快速切换：旧请求与旧建树结果必须失效；面板隐藏停止接收无效结果。
- 窗口失焦/隐藏/最小化/托盘：保留既有不刷新策略；重新聚焦合并请求。
- 侧栏位置/宽度/焦点模式：视口尺寸改变后重算可见范围。
- Hook 是否安装：与此读 Git 状态/显示树链路无关；CLI 工具改文件可以成为 watcher 事件来源。

## 待实施验证
浏览器真实 64,887 条数据注入、首开与刷新 Performance 记录、滚动首尾与批量选择正确性，以及模拟延迟/乱序 Transport 的刷新测试。用户实际仓库扫描时间可从既有 status_elapsed_ms/elapsed_ms 日志定位；目前未取得。

## 实施阶段影响复核

具体 fetchChanges 动作的 GitNexus 结果为 HIGH，23 个直接调用者（暂存、提交、回滚等写后刷新）。编辑前已告知用户，已使用真实 Zustand store、真实 stageFile 动作和延迟 Transport 测试覆盖写后快照等待、并发上限及身份切换。树/筛选/目录操作相关符号为 LOW。最终实现和验收见 validation.md。
