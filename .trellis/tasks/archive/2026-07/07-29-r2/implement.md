# 实施计划

1. 新增并测试 R2 Origin 校验、Actions 环境导出和安装脚本渲染工具。
2. 修改桌面发布及独立 SSH Agent 发布工作流，在构建/打包前使用该工具。
3. 将 Tauri updater、Rust 默认清单和前端安装地址接入构建时变量，保留本地默认值和 GitHub fallback。
4. 调整现有 R2、安装脚本、Rust/前端相关测试，移除对固定旧域名的发布假设。
5. 更新 `CHANGELOG.md` 的 `V1.3.3`。
6. 运行目标 Node/Shell 测试、`npx tsc --noEmit`、`cargo check`/相关 Rust 测试；不运行被禁止的完整构建命令。
7. 运行 GitNexus `detect_changes` 和 git diff 审查，确认影响范围。
