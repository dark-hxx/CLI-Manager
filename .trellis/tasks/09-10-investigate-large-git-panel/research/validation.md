# 验收记录

## 实现结果

- `gitTreeModel.ts`：共享分块排序/建树生成器、压缩目录、完整后代收集、计数聚合、带类型和层级身份的可见行。保留模块模式下文件/目录互换的同名容器语义。
- `gitTreeBuilder.ts` + Worker：5000 条阈值、15 秒超时、一次性终止、AbortSignal 和分批 fallback；正常取消不触发 fallback。
- `GitChangesTree`：单滚动容器虚拟化、目录操作与显示分离、菜单/焦点/拖拽所有者暂留、首次父 ref 绑定和列表缩短偏移校正。
- `gitStore`：按身份串行且合并下一轮，写操作等待队列排空；生命周期代次拒绝 A→B→A 和关闭后的旧结果，重复快照复用引用，动态筛选选项复核。
- `GitChangesPanel`：摘要 memo；将既有 `handleRequestDiscard` hook 移到隐藏 guard 前，避免切换可见性时 hook 数量变化。
- V1.4.0 CHANGELOG 与功能清单的 Git 部分已更新；新增性能契约并加入 frontend/index。

## 测试

38 项通过：

```sh
node --test scripts/gitChangesLargePerformance.test.mjs scripts/gitChangesBrowser.test.mjs scripts/gitStoreRemote.test.mjs scripts/gitTransportLease.test.mjs scripts/gitDiffReviewNavigation.test.mjs scripts/gitWorkspace.test.mjs scripts/dragInteraction.test.mjs
```

新增用例包括实际 `stageFile` 写后刷新、同身份 20 次突发刷新最大并发 1、A→B→A 及关闭隔离、SSH 空 repoId/子仓库、silent/显式失败和恢复、快照/选择引用复用、筛选竞态、Windows 路径、同名标题与文件/目录转换、Worker 构造/postMessage/运行/消息/超时/取消。

最后的同名文件/目录兼容调整后，13 项新增规模/浏览器用例再次全部通过。

## 真实浏览器数据

Chrome 独立临时配置，实际树/行/复选框/Radix 右键组件、实际 Worker 和 Zustand store；替换 Tauri 平台服务，使用真实中英文 Git 字典。

- 64,887 个文件，520px 视口：首次挂载 28 行，末尾挂载 28–29 行（额外 1 行用于保留正在交互/有焦点的所有者），约 401–415 个 DOM 元素。
- 最新测试 Worker 构造及传输约 295ms；期间主线程定时任务执行 41 次。此耗时不是用户现场 Git 扫描或应用完整首开耗时。
- 首尾文件可访问，文件点击和暂存回调、目录 64,887 文件批量暂存、压缩链拖拽路径、折叠/展开和偏移复位通过。
- 1000 个未跟踪文件的目录全选和三态通过；右键菜单打开后滚到末尾，所有者仍保留。
- zh-CN 标签为“改动 / 未跟踪文件”；en-US 为“Changed / Untracked Files”。

测试先发现同次父/子挂载 ref 时序导致的空白，已修复并保留回归。Chrome 工具因用户配置目录已占用不能连接，改用本任务独立 headless 配置，没有关闭或修改用户浏览器。

## 检查

- `npm run check:architecture -- --strict`：979 个源文件，0 超过 2000 行，0 新违规。
- `git diff --check`：通过；只有现有仓库 LF/CRLF 提示。
- 首轮 `npm run build`：TypeScript + Vite 通过，Worker 独立 chunk 成功输出。
- 最终 `npm run build`：通过（Vite 2m31s），完整输出见 build.log。已核对产物包含同名模块处理及带层级/类型的虚拟 key。
- 最终 `npx tsc --noEmit`：通过；最终严格架构检查和差异空白检查再次通过。

## 限制和未执行操作

- 未取得报告者实际仓库、性能 trace 或 crash.log，不能据合成规模测试断言其磁盘扫描延迟已消除。
- 未启动 Tauri 实机，也未在“设置→通用”手动切换语言；已通过真实字典组件测试覆盖两种语言。WSL/SSH 仅完成 Transport 行为测试，未连接真实远端。
- 未新增依赖或修改 Rust/IPC/数据库/发布版本配置，未执行 Rust 全量检查。
- 业务代码已提交 ae116d6b，正文 Fixes #257；未推送或回复 issue。原有 Pi 终端、规范及文档改动保留。

## 用户验收

用户确认“验证成功”，并授权提交代码、关联 issue #257。此前实机验证限制为代理侧记录，用户已完成自己的验证。
