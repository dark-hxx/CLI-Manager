# Git 工作区三阶段增强实施清单

## Baseline

- [x] 当前分支与上游同步状态检查完成。
- [x] 原 Git 工作区任务、分诊指南和跨层契约已复核。
- [x] codebase-memory 索引刷新；GitNexus MCP 未暴露，使用代码图谱 trace + 源码复核降级。
- [x] 当前未提交实现的 Rust checks 通过，TypeScript 编译阻塞已清理。

## Phase 1

- [x] 统一分支动作与最近/收藏分支入口。
- [x] 增加 Log 引用、作者、日期、路径过滤。
- [x] 增加提交信息复制、父提交查看和 Patch 创建。
- [x] 增加独立标签列表和完整本地标签动作。
- [x] 完成 Phase 1 自测。

## Phase 2

- [x] 增加 Stash 管理。
- [x] 增加 Remote 管理和仓库网页入口。
- [x] 增加 Push Tag、远端分支删除。
- [x] 增加 Reflog 恢复。
- [x] 增加当前文件历史和 Blame。
- [x] 完成 Phase 2 自测。

## Phase 3

- [x] 增加交互式 Rebase 与 todo 动作。
- [x] 增加 Force Push with lease。
- [x] 增加 Bisect 管理。
- [x] 增加 Submodule 管理。
- [x] 完成 Phase 3 自测。

## Delivery

- [x] 更新中英文文案、`CHANGELOG.md`、`docs/功能清单.md` 和必要契约。
- [x] 刷新索引并运行 detect changes。
- [x] 运行完整类型、Rust、fixture 和 diff 检查。
- [x] 只构建 NSIS 安装包并计算 SHA256。
