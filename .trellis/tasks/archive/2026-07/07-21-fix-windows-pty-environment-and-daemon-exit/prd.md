# Fix Windows PTY Environment and Daemon Exit

## Goal

修复 Windows 内部终端无法识别应用启动后新安装的 CLI，以及正常退出且没有运行任务时 PTY daemon 仍残留后台的问题。

## Changelog Target

V1.3.0

## Background

- Windows PTY 在 `src-tauri/src/pty/platform/windows.rs:364` 使用 daemon 进程启动时的 `std::env::vars()` 构建子进程环境。daemon 可跨 GUI 重启复用，因此系统或用户环境更新后，新建内部终端仍可能拿到旧 `PATH`。
- 正常退出在 `src/App.tsx:1212` 只关闭当前前台 PTY；daemon 的关闭请求在 `src-tauri/src/daemon/server.rs:1848` 只要发现任一 `alive` Shell 会话便拒绝。前端“运行任务”与 daemon“存活进程”的判断口径不同，空闲或隐藏 Shell 可导致 daemon 持续驻留。

## Requirements

- R1：Windows 每次创建新 PTY 时必须使用当前用户可获得的最新系统环境，至少保证系统/用户 `PATH` 更新能被新终端识别。
- R2：环境合并必须保留 CLI-Manager 进程的临时环境，并让项目/provider/hook 显式传入的环境变量保持最高优先级；Windows 环境变量键大小写不敏感。
- R3：正常退出且退出守卫确认没有运行任务时，必须关闭 daemon 中的全部 PTY 会话，再请求 daemon 退出。
- R4：“转入后台继续执行”必须继续保留 PTY 和 daemon，不得调用批量关闭或 shutdown。
- R5：退出前的终端快照与自动同步顺序保持不变；已存在终端不做热更新，仅新建终端使用刷新后的环境。
- R6：daemon 拒绝关闭时保留可诊断日志，不新增用户可见文案。

## Acceptance Criteria

- [ ] AC1：CLI-Manager/daemon 已启动后修改 Windows 用户或系统 `PATH`，新建 PowerShell、PowerShell 7、CMD 或 Git Bash 终端能获得最新路径。
- [ ] AC2：项目显式配置 `PATH` 时仍覆盖自动刷新的系统路径；其他项目/provider/hook 环境变量不丢失。
- [ ] AC3：正常退出且没有运行任务时，所有 PTY 会话被关闭，daemon 在退出流程结束后终止。
- [ ] AC4：存在运行任务并选择“转入后台”时，任务和 daemon 继续运行，可在下次启动时恢复。
- [ ] AC5：Windows 环境合并与 daemon 退出路径具备回归测试；Rust 检查、Rust 相关测试、TypeScript 类型检查通过。
- [ ] AC6：`CHANGELOG.md` 的 `V1.3.0` 修复章节记录两个问题。

## Out of Scope

- 不热更新已经启动的终端进程环境。
- 不修改 Windows PowerShell 与 PowerShell 7 的默认选择。
- 不改变 daemon 对真正运行中任务的保护机制或后台恢复协议。

## Technical Notes

- GitNexus MCP 当前不可用，代码触点按 `.trellis/spec/backend/pty-daemon-contracts.md`、语义搜索和 `rg` 结果确认。
- 影响面集中在 Windows PTY 环境块构建和前端退出编排；不修改 IPC 协议、数据库或配置 schema。
