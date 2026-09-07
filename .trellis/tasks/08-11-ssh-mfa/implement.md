# 实施计划：SSH MFA 输入后连接关闭

## 开发前

- [x] 已记录 Changelog Target：`V1.3.6`。
- [x] 已读取上一任务归档、Issue #195 原文和当前 SSH/ConPTY 源码。
- [x] 已完成根因分诊：跨进程、跨 PTY 边界的行为回归，走根因修复。
- [x] 已运行 GitNexus impact；Rust 符号索引缺失，结果为 `UNKNOWN`，已使用精确源码和契约完成发现清单。

## 实现

- [x] 在 Windows `read_control_terminal` 中改用继承 stdin/stderr，不再打开 `CONIN$`/`CONOUT$`。
- [x] 保证 `GetConsoleMode`/`SetConsoleMode` 作用于继承 stdin，并复用现有恢复守卫。
- [x] 保留平台无关的输入输出协议测试；Windows 专属路径已通过目标平台编译检查。
- [x] 更新 `.trellis/spec/backend/ssh-remote-terminal-contracts.md`，记录 ConPTY 句柄契约。
- [x] 更新 `CHANGELOG.md` 的 `V1.3.6` 条目并关联 #195。
- [x] 按项目要求更新 `docs/功能清单.md` 的 SSH MFA 行为说明。
- [x] 增加独立 `ssh-askpass.log` 诊断日志：记录 prompt 分类、路由、阶段、错误类型、进程号和字节数，不记录敏感内容。

## 验证

- [x] `cargo fmt --check --manifest-path src-tauri/Cargo.toml`
- [x] `cargo test --locked --manifest-path src-tauri/Cargo.toml ssh_askpass::tests --lib`：13 passed
- [x] `cargo test --locked --manifest-path src-tauri/Cargo.toml ssh_transport::tests --lib`：11 passed
- [x] `cargo check --locked --manifest-path src-tauri/Cargo.toml`
- [x] `npx tsc --noEmit`
- [x] 使用 GitNexus `detect_changes` 检查变更范围：changed_symbols/processes 为空，risk low；Rust FTS 仍不可用。
- [x] 修复 Git Diff 多文件首次打开目标错位：首帧同步绑定 `initialFilePath`，新增导航回归测试。
- [x] 未运行 `npm run tauri dev/build`；真实 MFA 主机不可用，未做平台实机验收。
- [ ] 发布前收集一次真实失败样本，连同普通 CLI-Manager 日志一起验证诊断字段足够定位问题。

## 风险点

- stdout 必须只包含 MFA 响应，prompt 只能写 stderr。
- 终端回显必须在成功、EOF、错误路径恢复。
- 交互 fallback=1 与后台 one-shot=0 的行为不能改变。
