# Implementation Plan

1. 影响分析 `GitTransport.getFileDiff`、Desktop `git_get_file_diff`、Agent `gitDiff` 和协议 capability。
2. 新增共享 TS 类型、settings 默认值/迁移/同步和 UI 菜单。
3. 抽取 Desktop `git_diff` 模块，实现 libgit2/WSL 选项与 Rust fixtures。
4. 保留 legacy SSH 请求，新增 `gitDiffWithOptions`、capability、Agent 0.1.5/protocol 1.8 和测试。
5. 在 Controller 中按 options 重载，并在非 exact 模式禁用部分回滚。
6. 更新 Agent 发布/安装相关版本引用和中英文错误映射。
7. 运行 TypeScript、Desktop Rust、Agent fmt/clippy/test 和 `git diff --check`。
