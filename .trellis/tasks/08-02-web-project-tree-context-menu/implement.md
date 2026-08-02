# 实施步骤

1. [x] 读取并遵循前端、Server、Tauri 和 fix-triage 规约；对实际修改符号执行 GitNexus impact。
2. [x] 扩展 Web `ProjectTree`、Workbench props、样式和中英文文案，实现节点菜单、选择和快捷启动。
3. [x] 增加 `project.start` / `project.action` 的 Web operation 类型、Server allowlist/确认校验和桌面 bridge 分发。
4. [x] 增加桌面端 action bus，接入 Sidebar 现有终端、原生弹窗、文件、Provider、分组和 Worktree 处理器。
5. [x] 补充服务端和边界校验测试，运行 Web typecheck、Server/桌面 Rust 测试和 `git diff --check`。
6. [x] 使用 `[TEMP]` 更新 CHANGELOG.md，复核现有用户修改不被覆盖。
