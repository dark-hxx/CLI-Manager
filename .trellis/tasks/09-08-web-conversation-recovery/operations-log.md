# Operations log

- 2026-09-08：安装验收出现 `cli_exited:initialize` 和 `database is locked`，任务重新进入处理中。
- 现场只读证据确认 `test` 项目带终端 `resume <session>` 参数；直接运行同构命令复现无 TTY TUI 退出。Web 日志确认短时间多次启动，旧托管服务没有 join handle，活跃长连接可保留旧 SQLite pool。
- GitNexus MCP 未暴露，按规则降级为 codebase-memory moderate 索引、调用路径分析，并以源码、SQLite 只读查询、日志、测试和构建复核；完成代码后刷新索引并运行 change detection。change detection 相对 master 包含当前长期功能分支的大量既有差异，因此以本轮目标文件 diff 与自动化验证界定影响面。
- 修复采用最小根因方案：剥离终端恢复选择器、稳定非敏感退出诊断、确定性服务回收、`BEGIN IMMEDIATE` 会话写事务；没有增加无限重试或修改数据库 Schema。
- 安装验收进一步确认失败启动只有临时 operation ID，却被 `turn_failed` 事件持久化并被浏览器当作可恢复 Session；同时真实会话恢复错误依赖桌面当前前 20 条历史摘要。修复后，CLI 建立真实 Session 前不发布会话事件，服务端只列出含 `session_started` 的会话，浏览器清理失效选择，桌面按 Session ID、来源与 cwd 精确查询并在 miss 时刷新一次 catalog。
- 主数据库约 4.1 GB，`request_logs` 与 `usage_records` 各约 187 万行。确认每次连接重放 v27 全量回填耗时约 16～43 秒，按 `data_source + file_path` 删除又因错误索引选择扫描约 31～63 秒。健康 Schema 增加只读 fast path；历史替换先通过 `request_logs(file_path)` 索引取 ID，再按 `usage_records.record_id` 主键定向删除。`EXPLAIN QUERY PLAN` 已确认两侧均使用索引。
- 用户确认供应商连接故障已恢复，但拒绝结构化聊天卡片。任务重新进入处理中，主流程改为复用真实 PTY：浏览器 xterm 经账号/设备 WebSocket 发送 attach/input/resize，桌面 bridge 订阅既有 `PtyHostSocket` 并回传原始字节；实时帧不持久化。
- 服务连接故障根因位于生命周期就绪边界：旧实现在线程启动后立即置 running，且 bind 前已打开数据库并更新设备状态。改为先绑定端口、完成存储与路由初始化后发送 ready；桌面启动命令最多等待 20 秒，失败即回收线程并返回原始 bind/初始化错误。
- 输出链路按 16ms 合帧，重放 reset 转换为 xterm 完整重置序列；项目/设备切换、返回主机和退出登录显式 detach。保留旧结构化会话数据读取能力，但 Web 主界面和项目启动不再依赖该展示链路。
