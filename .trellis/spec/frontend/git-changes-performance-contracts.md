# Git 变更面板规模与刷新契约

## 1. Scope / Trigger

Issue #257：V1.3.9 在 64,887 个文件变更时默认展开递归树，每行订阅整个 store。后台跳过 diff 统计不能解决 WebView 全量挂载问题。

范围为 `features/git/components/{GitChangesTree,GitTreeNode}.tsx`、`store/gitStore.ts` 和 `lib/gitTree*.ts`、`gitChangesRefreshQueue.ts`、`gitChangesSummary.ts`；本地/WSL/SSH/Worktree 共用此展示层。Rust 扫描耗时仍需按 `status_elapsed_ms`/`elapsed_ms` 日志单独判定。

## 2. Signatures

```ts
buildGitChangeTrees(changes, filter, groupBy): Generator<void, GitChangeTrees>;
buildGitTreesAsync(changes, filter, groupBy, signal): Promise<GitChangeTrees>;
flattenGitRows(tree, untrackedTree, collapsedDirs): GitVisibleRow[];
summarizeGitDirectories(roots, selectedUntracked, deselectedAdded): Map<GitTreeNode, GitDirectorySummary>;
GitChangesRefreshQueue.request(key, job, reportError): Promise<void>;
```

不变更 `GitFileChange[]`、Transport 或 IPC 协议。

## 3. Contracts

- 两分区标题和展开节点在同一个虚拟列表内，共用父 Content 滚动条；26px 行步长、8 行 overscan。文件/目录交互行高 24px，不允许内容撑高固定行布局。
- 虚拟 key 包含分区和行类型，目录折叠 key 沿用 `treeId:path`。名为 `section` 的文件不能与分区标题冲突。
- 父滚动容器与树同次挂载时，提交后绑定 scroll element，避免子布局 effect 早于父 ref 赋值导致空白。缩短列表后夹紧旧滚动偏移。
- 虚拟化只限制挂载量，不能截断 `changes` 或目录操作范围。右键、焦点及 pointer 操作中的行保留到交互结束。
- 目录汇总按树/选择集合计算一次，每个目录存计数而非一份后代文件数组；完整后代路径只在批量操作发生时收集。U/?? 是前端选择，A 取消勾选不 unstage，其他已跟踪状态沿用真实 staged。
- 超过 5000 条使用一次性 Worker，成功、失败、取消或 15 秒超时均终止一次。Worker 不可用/失败后执行同一分块排序与建树生成器，每批 1000 条让出主线程；取消禁止触发 fallback。
- 同身份最多一个状态查询在途，新请求合并为下一轮，所有等待者等到队列排空；写后刷新不能复用写前在途快照。身份含项目、repoId、Transport contextKey，SSH 根 repoId 的空字符串合法。
- 项目/子仓库/Transport/reset 改变推进生命周期代次并中止建树。A→B→A 的旧 A 结果也必须失效。不可取消的旧 IPC 不得覆盖新状态。
- 相同快照复用 changes/tree/选择集合引用；分组变化仍需重建。异步返回前复核当前筛选/分组，不能将旧选项树写回新选项。
- 面板摘要按快照和 A 取消选择集合 memo。所有 hooks 都在隐藏/关闭的 early return 前调用。

## 4. Validation / Error Matrix

| 场景 | 必须行为 |
|---|---|
| 64,887 根目录文件 / 宽目录 / 压缩深路径 | 完整数据、首尾可达，挂载量受视口限制 |
| 目录折叠 / 模块分组 / M、D 筛选 | 保留压缩链操作路径、分区隔离和目录批量范围 |
| Worker 构造/运行/消息错误或超时 | 终止后分批 fallback |
| 切换项目、仓库、Transport 或关闭面板 | 中止建树，旧结果不写入 |
| 同仓库突发刷新、操作后刷新 | 最大并发 1，补查写后的快照 |
| 相同数据周期刷新 | 不重建树、不重新分配选择集合 |
| 滚动时菜单仍打开 | 保留菜单所有者行，菜单关闭后可回收 |

## 5. Good / Base / Bad Cases

- Good：520px 视口展示 64,887 个文件仅挂载约 28 行，目录批量暂存仍提交全部 64,887 路径。
- Base：小列表同步构造，原有文件状态、分组、右键和 Diff 入口不变。
- Bad：限制到前 1000 文件、只默认折叠、每个目录渲染时递归 flatMap、逐事件排队刷新、把已在途读取作为写后的刷新结果。

## 6. Tests Required

```sh
node --test scripts/gitChangesLargePerformance.test.mjs scripts/gitChangesBrowser.test.mjs
node --test scripts/gitStoreRemote.test.mjs scripts/gitTransportLease.test.mjs scripts/gitDiffReviewNavigation.test.mjs scripts/gitWorkspace.test.mjs scripts/dragInteraction.test.mjs
npm run check:architecture -- --strict
npm run build
```

浏览器测试以独立临时 Chromium 配置运行真实树/行/复选框/右键组件，替换平台服务；可用 `GIT_TEST_CHROME` 指定可执行文件，无浏览器时明确 skip。使用 CDP 真实时间等待 Worker，不能让 headless virtual-time-budget 提前耗尽 Worker 超时预算。它不替代本地/WSL/SSH Tauri 实机验收。

## 7. Wrong vs Correct

```tsx
// Wrong：业务文件数决定组件数，所有状态更新传播给每行。
nodes.map(node => <RecursiveTree node={node} />);
const state = useGitStore();

// Correct：只挂载视口及正在交互的行，完整操作数据留在树模型。
virtualizer.getVirtualItems().map(item => renderRow(rows[item.index]));
const selected = useGitStore(state => state.selectedUntracked.has(path));
```
