# Add Git commit history

## Goal

Add paginated read-only Git commit history and commit diff inspection to the existing Git panel across local, WSL, and SSH transports.

## Requirements

- 在现有 Git 面板中提供“变更 / 历史”两个视图，默认保持现有变更视图。
- 历史视图按每页 50 条分页展示提交，包含标题、短 SHA、作者、时间和可获得的引用标签。
- 支持按提交标题、作者和 SHA 搜索；搜索结果仍按 50 条分页。
- 点击提交后按需加载提交文件列表、增删行统计；Merge 提交首版与第一父提交比较。
- 点击提交中的文件后复用现有 Diff 查看器，以只读模式展示该提交的文件差异。
- 本地 Windows、WSL 和 SSH 项目行为一致。SSH Agent 需声明独立能力，旧 Agent 显示明确升级提示。
- 列表只加载元数据，提交详情和文件 Diff 按需加载，切换仓库/分支/transport 后不得显示旧请求结果。
- 历史在进入视图、手动刷新以及仓库/分支上下文变化时刷新，不跟随每次工作区文件写入刷新。

## Acceptance Criteria

- [ ] 本地普通仓库、嵌套仓库和 Worktree 可浏览、搜索及分页查看提交。
- [ ] WSL Linux 文件系统仓库与映射到 Windows 盘的 WSL 路径沿用现有路由规则并正确显示历史。
- [ ] SSH 新 Agent 可浏览历史；旧 Agent 不发送未知协议帧并展示本地化升级提示。
- [ ] 空仓库、浅克隆、Detached HEAD、Merge 提交、重命名文件和二进制文件均有稳定结果或明确空态。
- [ ] 切换项目、仓库或 transport 时，未完成的异步请求不会污染新上下文。
- [ ] 历史 Diff 不提供暂存、回滚、逐块回滚或逐行回滚入口。
- [ ] 新增界面文案同时支持 zh-CN 与 en-US。
- [ ] Rust、TypeScript、相关脚本测试与生产构建通过。

## Notes

- 首版不提供 reset、revert、cherry-pick 等改变仓库状态的操作。
- 不新增数据库表或持久化历史缓存。
- Diff 继续遵守现有大小限制，过大内容不截断、不开放修改操作。
