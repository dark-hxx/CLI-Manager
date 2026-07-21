# Web bridge daemon process

## Goal

将桌面端 Web 设备桥接从 Tauri 主进程拆到独立 `cli-manager-web-daemon.exe`，保持 `apps/server` 独立部署，桌面继续拥有本地项目、PTY、CLI、文件、Git、Worktree、Hook 和原生确认权限。

Changelog Target: `[TEMP]`

## Requirements

- daemon 负责 Web Device WebSocket、配对、Token、心跳、重连、历史上报和有界 operation 队列。
- Tauri 通过 `127.0.0.1` NDJSON IPC 连接 daemon，现有 `web_device_*` 命令、事件和 `apps/server` API 保持兼容。
- Token 只由 daemon/系统凭据库持有，不进入 WebView、普通日志或 JSON profile。
- 桌面退出后 daemon 可继续保留 Web 连接和待处理 operation；桌面重连后继续执行。
- `web_device_validate_context` 以及本地 operation 执行仍留在 Tauri/React。
- 开发版与安装版使用独立 discovery 文件；daemon 崩溃、旧 discovery、版本不匹配必须可恢复。

## Acceptance Criteria

- [ ] 可生成并启动 `cli-manager-web-daemon`，完成 loopback 鉴权和状态握手。
- [ ] 配对、状态、历史快照和 operation 回执经过 daemon 转发，现有前端调用无需改协议。
- [ ] operation 仅在桌面确认后发送 accepted/running/terminal，队列有界且按服务端 ACK 清理。
- [ ] 桌面退出后 daemon 保持连接；桌面恢复后可接收未完成 operation。
- [ ] Token 不出现在状态 payload、日志和 WebView。
- [ ] Rust 检查/测试、前端类型检查通过，契约和功能清单已更新。

## Out of Scope

- 不把 `apps/server` 合并进 daemon。
- 不把 CLI、PTY、文件、Git、Worktree、Hook 执行下沉到 daemon。
- 不修改浏览器 HTTP/WebSocket API 和 `crates/web-protocol` 公共帧定义。
