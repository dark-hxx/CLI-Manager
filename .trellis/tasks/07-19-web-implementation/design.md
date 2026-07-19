# Technical Design

## Frontend Boundary

- 新增独立 Web 包，拥有自己的入口、Vite 配置和样式入口。
- 不导入桌面 `App.tsx`、Tauri Store、PTY、SSH 或系统能力模块。
- 首批静态状态集中在 Web 包内，后续通过 transport/cache 接口替换 Mock。

## First Slice

1. Web package scripts and build entry.
2. Semantic theme tokens and local preference.
3. Responsive application shell.
4. Workbench empty state and prompt composer.
5. Minimal bilingual dictionary.

## Data Boundary

- SQLite3 保存用户哈希、浏览器会话、设备、配对码、历史摘要、operation 和浏览器事件，不保存 PTY、密钥或文件正文。
- 浏览器只能创建当前版本允许的对话 operation；设备离线时服务端拒绝创建，不做危险操作排队。
- operation 只有桌面回执能进入终态，浏览器事件使用持久化 sequence 支持断线补传。

## P0-S2 Service Boundary

- `apps/server` 是独立 Rust 模块化单体，不进入 `src-tauri`，同进程提供静态 Web、HTTP API、Browser WebSocket 和 Device WebSocket。
- `crates/web-protocol` 统一设备帧、浏览器事件和 API 领域类型，Serde 使用 camelCase 字段与 snake_case 状态。
- 浏览器身份使用 HttpOnly、SameSite=Strict Cookie；设备身份使用配对后签发的随机 token 哈希。
- WebSocket 发送队列有界；设备 sequence 在 SQLite3 去重，浏览器按用户游标回放。

## P0-S3 Desktop Boundary

- Rust `WebDeviceManager` 持有 WebSocket、重连、心跳、配对 Token 和待处理 operation 队列；React 不直接持有设备连接。
- Rust 只负责协议与秘密边界，真实 CLI 启动和 Hook 结果映射由桌面前端复用现有 project/worktree/terminal stores。
- Web 端从历史快照派生项目上下文，operation payload 显式携带 `source/projectKey/cwd`，继续会话额外携带 `sessionId`。
- 新会话复用项目启动命令；继续会话复用现有 Claude/Codex resume 命令与 provider override。
- 设备连接可在窗口不可见时持续；operation 在 Rust 内排队，WebView 恢复后再领取，避免事件丢失。

## Deferred Architecture

- 细粒度用户/设备/项目授权与撤销页面。
- 审批、取消请求、审计日志和设备任务并发配额。
- 项目、文件、Git、分析、供应商、Hook、备份与设置页面。

## Excluded

- SSH 全部能力。
