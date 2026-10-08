# 实施与验收计划

状态：代码及自动化验证完成，用户确认功能验证成功并授权提交、推送；提交前的编译告警清理及恢复回归已通过。详细结果见 verification.md。

## 1. 开始实现前

- [x] 分支/上游只读检查，记录 master 相对 origin/master 为 0/0。
- [x] 读取 Trellis、历史领域、修复分诊、路径安全、架构和注释契约。
- [x] 记录根因、来源表、触点及场景矩阵到 research/source-audit.md。
- [x] 生成 prd.md、design.md、implement.md；主会话 inline，不创建子代理上下文清单。
- [x] 将最终范围/风险/验收摘要展示给用户，并取得其随后明确的实现批准。
- [x] 获批后加载 workflow step 1.4 并执行 task.py start；更新当前任务上下文。
- [x] 对实际修改的每个既有符号先执行 GitNexus impact；仍为 UNKNOWN，已记录并用精确调用点降级核查，包含复核发现的后端能力表。

## 2. 备份与删除核心

- [x] 补齐同名原文备份的隔离回归，以相同固定前缀验证，不依赖时钟碰撞。
- [x] 独占分配快照变更目录；保留 manifest 结构和旧备份发现。
- [x] 提取接受明确目标路径集合的备份/删除执行器；保留旧树删除入口及原有顺序/补偿语义。
- [x] 新增七来源单转录删除入口，不扫描/删除相邻 subagents，不递归删除未知目录。
- [x] 运行备份与既有 session_pipeline 删除定向测试，确认局部提取等价。

## 3. 来源接入与校验

- [x] 添加删除专用的 Cline 多合法根验证，复用目录候选/规范路径/项目键校验。
- [x] 修改命令分发接入七个来源，保留已有五个来源专用路径和恢复锁。
- [x] 使用临时目录建立七来源原生 fixture：每源两会话，删除一条后重新枚举，断言另一条及共享文件不变。
- [x] 覆盖 Cline 不同已知根、相同文件名/不同目录、错误项目/来源、未索引文件、目录/数据库替代及越界；Windows 已用无需额外特权的 junction 验证规范路径逃逸。
- [x] 覆盖备份失败、删除失败、人工恢复锁；Windows 文件句柄拒绝删除时确认已删目标回滚及错误传播。
- [x] 验证新来源文件级删除不调用泛化子代理枚举，旧 Claude/Codex 父子树仍按原方式清理。

## 4. 前端资格与状态

- [x] 精确更新前后端两份能力表的十二来源 delete 状态，不顺带开放 edit/convertTo。
- [x] 新增历史域删除资格/目标策略模块，列表、批量确认及 Store 共用。
- [x] 保持 SSH/只读、收藏快照、子代理的预期约束，防止绕过按钮调用。
- [x] 新来源只清理实际被删目标；已有级联删除维持真实子项清理。
- [x] 保留后端成功后再清 session_meta、生成标题、收藏快照及前端列表/搜索/详情的顺序。
- [x] 批量测试覆盖混合来源、资格失败预检、真实 I/O 中途失败及准确部分成功计数。
- [x] 新可见提示同步 zh-CN/en-US，必要注释与真实副作用保持一致；用户已确认功能验证成功，未提供逐项语言切换记录。

## 5. 定向验证

新 Rust 测试建议命名含 history_delete / history_backup，以便有界运行：

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --lib history_delete
cargo test --manifest-path src-tauri/Cargo.toml --lib history_backup
node --test scripts/historyDeletion.test.mjs scripts/historyListRefreshState.test.mjs scripts/historySubagentHierarchy.test.mjs scripts/kimiHistoryFrontend.test.mjs scripts/grokHistoryFrontend.test.mjs
```

实施时以实际测试名称补齐过滤器，不能把 0 tests 当通过。已有备份模块测试名/目录路由需要按 test --list 精确核对。

## 6. 交付前跨层门禁

- [x] cargo test --manifest-path src-tauri/Cargo.toml --lib history：最终 262 项通过。
- [x] cargo check --manifest-path src-tauri/Cargo.toml：历史修复通过；后续按 --no-default-features 复检，清理 inspect 后无编译告警。
- [x] cargo test --manifest-path src-tauri/Cargo.toml --no-default-features --lib recovery_tests -- --nocapture：8 项通过，0 失败。
- [x] cargo fmt --manifest-path src-tauri/Cargo.toml -- --check：已执行，全仓因 74 个文件既有格式差异未通过；本次修改行均完成格式核对，未扩大格式化。
- [x] npx tsc --noEmit：通过；前端历史相关 82 项回归通过。
- [x] npm run check:architecture -- --strict：独立执行通过，无超限或新豁免。
- [x] npm run report:architecture：已运行，Store 为 1837 行。
- [x] 对照最终 diff 自查来源分发、共享根/目录边界、备份发现和前后端实际删除目标一致。
- [x] 更新历史相关契约、CHANGELOG.md 的 V1.4.2 条目和 docs/功能清单.md 的历史工作区/本地来源条目。
- [x] 已使用 trellis-check 完成质量核查；验收证据、既有格式问题及人工验证边界见 verification.md。

## 7. 人工验收反馈

用户于 2026-10-08 明确反馈“功能验证成功 可以提交”。按用户反馈记录功能验收通过；下列为原交付建议场景，用户未提供逐项操作记录：

- 七来源各选测试会话删除，刷新/重新打开后不出现；同目录另一会话仍可读。
- 混合来源批量删除，核对目标数、成功数与故障提示。
- 收藏快照、SSH/只读项、父子会话以及切换项目/Worktree 后的操作目标正确。
- 设置 → 通用 → 界面语言切换 zh-CN/en-US，确认提示与禁用态，时间仍为 24 小时制。

未由 AI 启动产品服务/Tauri 或操作真实历史；不把用户的总体反馈扩写为逐项语言切换和交互实测记录。

## 8. 编译告警清理

- [x] GitNexus impact 未识别 inspect；按恢复契约和全后端引用补查，确认生产和测试均无调用。
- [x] 删除旧 inspect 入口及其注释，保留实际使用的 probe/recheck；无需添加新测试或抑制 dead_code。
- [x] 开发配置编译、8 项恢复测试、严格架构检查通过，V1.4.2 两份交付文档已补充 Worktree 条目。

## 9. 收尾边界

- 用户已授权本次提交及推送 origin/master；每次提交前运行 GitNexus detect_changes 检查范围，之后归档当前任务并记录会话，再推送完成结果。
- 提交限定为本任务修改；保留规则、二维码、README/许可说明等其他并行修改，Git 同步状态变化仅报告。
- 不进行未授权的版本发布或 Git 历史改写。
- 如实施发现必须删除共享原生索引/整目录或新增远程写入才能满足当前验收，应回到规划说明变化，不静默扩大删除范围。
