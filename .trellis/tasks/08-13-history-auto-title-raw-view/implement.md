# Issue #184 实施计划

## 执行闸门

- **当前只执行阶段 A。** 阶段 A 的所有检查和用户验收完成前，阶段 B 保持阻塞。
- 阶段 A 不允许创建自动命名字段、设置、命令、网络请求或后台任务。
- 阶段 A 完成后先更新任务进度与规划文件，再向用户确认阶段 B 方案；未确认不得继续。

## 阶段 A：新增对话视图并修复单击打开（当前）

- [x] 为本地/WSL `HistoryMessage` 增加可选 `parts`，实现来源结构块分类。
- [x] 为 SSH `RemoteHistoryMessage` 增加相同 parts 契约及兼容反序列化。
- [x] 保留 `content` 与 `message_index` 语义，补齐 Rust parser 回归测试。
- [x] 前端归一化 optional parts，旧快照按 role 回退。
- [x] 保留现有“原文”页签，新增并默认选择“对话”页签，不增加二级模式设置。
- [x] 折叠连续非正文区段，接通搜索命中、Diff/工具/时间线跳转强制展开。
- [x] 将打开会话绑定到列表整行，隔离树展开、删除和批量选择事件；保留最后一次详情请求获胜语义。
- [x] 更新 `zh-CN`、`zh-TW` 兼容文案与 `en-US` 文案、aria 标签。

### 阶段 A 验收

- [x] `npx tsc --noEmit`。
- [x] History parser 定向 Rust 测试覆盖本地 Claude/Codex、其他来源兼容和 SSH history-core。
- [x] 前端状态测试覆盖旧快照 fallback、搜索/跨视图跳转和最后一次详情请求获胜。
- [ ] 手工验证 `zh-CN`、`zh-TW`、`en-US`，并检查键盘操作和 24 小时制。
- [ ] 手工验证 Local/WSL/SSH、主仓库/Worktree、父子会话树、批量选择模式。
- [ ] 用户确认“对话”与“原文”职责、折叠行为和单击打开体验符合预期。

## 阶段 B：可选自动标题（阻塞，阶段 A 验收后再启动）

- [ ] SQLite migration 扩展 `session_meta` 的生成标题与状态字段。
- [ ] 调整 `SessionMeta`/`HistorySessionView` 和唯一标题优先级入口。
- [ ] 增加自动命名设置、cc-switch provider 选择、启用时间与隐私/费用说明。
- [ ] 抽取最小共享模型 HTTP/响应文本解析能力。
- [ ] 实现 Rust `history_generate_title`：读取 cc-switch 配置、提取首轮正文、请求、清洗和错误码。
- [ ] 实现前端单队列、资格过滤、同一 basis 去重、失败不重试和手动重试。
- [ ] 覆盖别名竞态、旧会话不批量生成、provider 删除/超时/非法响应回退。

### 阶段 B 验证（后置）

- [ ] cc-switch Claude/Codex 标题响应解析与错误矩阵单元测试；HTTP 使用本地 mock，禁止真实计费测试进入自动化。
- [ ] session meta migration、标题优先级、生成队列与旧快照前端状态测试。
- [ ] 手工覆盖 Local/WSL/SSH、Hook 安装/未安装、Worktree、多个并发新会话、离线/401/429/5xx。

## 风险与回滚点

- PR A 可通过切换到现有“原文”页签回到旧展示行为。
- PR B 可通过关闭 `historyAutoTitleEnabled` 回到旧标题优先级；绝不修改来源历史文件。
- `HistoryMessage`/`RemoteHistoryMessage` 是 MEDIUM 影响契约，实施前需再次运行 GitNexus impact，完成后运行 detect_changes。
- 当前规划确认仅授权阶段 A；启动 `task.py start` 后也不得越界实施阶段 B。
