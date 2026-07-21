# Technical Design

## Boundaries

本次修改跨两个独立边界：

1. Windows daemon 到 PTY 子进程的环境构建。
2. React 退出编排到 PtyHost daemon 生命周期。

不改变现有 daemon 协议帧和会话恢复数据格式。

## Windows Environment Refresh

- 在 Windows PTY spawn 前获取当前用户的最新 Windows 环境块。
- 合并顺序为：daemon 进程环境 -> 最新 Windows 环境 -> `PtyLaunchOptions.env` 显式覆盖。
- `PATH` 不做普通整值替换：最新 Windows 用户路径优先，随后补回 daemon `PATH` 独有的临时条目，并按 Windows 大小写不敏感去重；显式 `PATH` 仍整值覆盖。
- 使用大小写不敏感的键合并，确保 `Path` / `PATH` 只有一项。
- 获取最新环境失败时保留 daemon 进程环境，避免终端完全无法创建，并写入警告日志。
- 仅 Windows 实现变化；Unix 保持原逻辑。

## Normal Exit Cleanup

- `closePty=true` 表示用户选择真正退出，应调用 PtyHost `close_all` 清理前台、隐藏和后台残留 PTY。
- `closePty=false` 仍仅用于“转入后台”，不关闭任何 PTY，也不请求 daemon shutdown。
- `pty_daemon_sessions` 不可用必须返回错误，不能用空数组冒充检查成功。
- 只有 daemon shutdown 成功（或明确返回无 daemon）才允许 `app_exit`；shutdown 抛错时中止退出并恢复遮罩。
- 保持现有顺序：自动同步 -> 快照落盘 -> close_all -> daemon shutdown -> app exit。
- `discardSessions` 只决定是否清理持久化恢复记录，不再决定是否使用 close_all。

## Compatibility

- 新环境只作用于新建终端，符合操作系统进程环境不可原地更新的语义。
- 项目/provider/hook 显式环境覆盖保持最高优先级。
- 正常退出会终止空闲 Shell；后台继续模式仍保护真实运行任务。

## Rollback

- Windows 环境刷新可独立回退到 `std::env::vars()`。
- 退出清理可独立回退到逐前台 session close；两项修改不依赖数据迁移。
