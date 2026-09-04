# Git 工作区三阶段增强

## Goal

在现有 JetBrains 风格 Git 工作区上补齐常用分支、历史、远端和高级恢复工具，使本地、WSL、Worktree 与 SSH 用户能在明确的上下文和风险提示下完成主要 Git 工作流。

## Phase 1: References And History

- 分支入口提供最近分支、收藏分支、分组动作和搜索。
- Git Log 支持当前分支、所有分支和多引用范围，并按作者、日期、路径过滤。
- 提交菜单支持复制提交信息、查看父提交和创建 Patch。
- 标签由独立数据源加载，支持搜索、检出、比较、从标签建分支、创建和删除。

## Phase 2: Daily Repository Management

- Stash 支持创建、列表、应用、弹出和删除。
- Remote 支持列表、新增、编辑、删除、Fetch，并能打开可识别的仓库网页。
- 支持 Push Tag 和删除远端分支。
- Reflog 支持浏览并以新分支或安全 Reset 恢复。
- 当前文件支持历史和 Blame；没有文件上下文时不显示幽灵入口。

## Phase 3: Advanced Operations

- 支持交互式 Rebase 计划：pick、reword、squash、fixup、drop，并允许继续/中止。
- 支持 Force Push with lease，禁止裸 `--force`。
- 支持 Bisect 开始、标记 good/bad、重置，并显示当前状态。
- 支持 Submodule 列表、初始化/更新/同步；危险删除不在首版范围。

## Cross-Environment Rules

- Local、WSL 和 SSH 共享 `GitTransport` 契约；SSH Agent 缺 capability 时必须在发送协议帧前禁用入口并显示升级说明。
- Worktree 使用实际仓库目录；linked worktree 的 `.git` 文件必须继续可用。
- 所有用户可见文案同步支持中文和英文，时间保持 24 小时制。
- 网络和写操作必须有进行中状态、防重复触发、结果刷新和错误反馈。
- Reset hard、删除远端引用、Force Push、Drop 等操作必须二次确认。

## Acceptance

- [ ] 三阶段所有真实入口均接入主工作区，无仅定义未调用的功能。
- [ ] 每阶段的纯逻辑、类型和 Git fixture 冒烟验证通过。
- [ ] Local/WSL/SSH 的能力支持或禁用状态明确且可验证。
- [ ] `CHANGELOG.md` 与 `docs/功能清单.md` 已更新。
- [ ] TypeScript、Rust 主程序、SSH Agent 检查通过。
- [ ] 最终只构建 NSIS 安装包并给出路径与 SHA256。
