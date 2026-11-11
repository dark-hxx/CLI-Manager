# 根因与设计

## 根因陈述

前端确认到批量执行的生命周期没有排他控制：确认弹窗直到任务结束才关闭且仍可再次提交；重叠队列遇到已被另一队列删除的会话后报失败，而原队列继续成功。

## 发现清单与影响面

- HistoryWorkspace：真实单删/批删确认入口；接入 Store 排他 action 和等待态，守住再次请求与关闭弹窗，失败只记一次诊断。
- historyStore/historyStoreTypes：新增不持久化 deletingSessions 与 deleteSessions；首个 await 前同步取锁，finally 释放。重复调用返回 null（未执行），不误报完成或失败。
- executeHistoryDeletion/historyDeletedSessionKeys：复用整批预检、顺序执行和实际覆盖合并；确认无需更改，失效与 I/O 失败不能忽略。
- ConfirmDialog：22 个 JSX 使用文件，影响面较高；可选 pending 默认 false，仅启用者禁用操作和遮罩/Escape，既有消费者保持原行为。
- HistoryListPane：单条按钮、批量按钮及右键删除全部绑定同一执行状态；入口回调仍同步复查 Store，不能仅依赖下一帧 disabled。
- deleteSession 的下一条详情预览：可能单独失败，但会停止所属队列，无法解释本次“失败后另一队列继续”；本轮不改读取/预览语义。
- 索引更新/背景刷新：可能导致真实失效，保持现有明确报错，不以列表缺行当作成功；非本次重叠队列根因。
- Rust 级联/备份/回滚、PTY/Hook/Web：确认无实现或契约变化。

GitNexus 工具及项目引用的 Trellis skills 未提供；按 workflow、领域契约、codebase-memory 与真实源码执行主会话降级。memory 已刷新；executeHistoryDeletion→HistoryWorkspace 直接调用被标 CRITICAL，JSX 调用边漏检，实际 rg 复核 22 个 ConfirmDialog 使用文件，不以空图结果降低风险。符合仓库 inline 模式，不派实现代理。

## 场景与边界

- 同窗口鼠标连点/Enter 连按、单删与批删竞争：只允许一个队列。
- 等待期间关闭/重开历史组件、隐藏/显示、焦点切换：锁在 feature Store，不随组件卸载丢失；任务完成才释放。
- 取消/Escape/遮罩：运行前允许取消，运行中不关闭确认；全局隐藏历史面板不宣称取消任务。
- 父子覆盖/快照/来源混合、失败后再删：保留现有策略，部分成功与剩余项正确报告。
- WSL/本地/Worktree 缺失/Hook 状态：不改变资格、路径或后台协议；SSH/read-only 仍阻止删除。
- 不同独立 WebView/外部应用并发修改并非同一 Store，仍遵守后台校验与真实失效报告；不扩展成跨进程调度器。

## 验证、发布和回滚

执行真实 Store action、确认回调和 ConfirmDialog JSX，使用隔离内存边界，不启动 CLI-Manager 或删除真实历史。定向并发/既有历史测试，tsc，独立 strict architecture，桌面/Web 生产构建与缓存 NSIS。不加依赖或数据库迁移。回滚为前一已验证安装包；打包前备份同名旧包，提交后再构建。
