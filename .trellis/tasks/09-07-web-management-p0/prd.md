# Web 管理 P0 基线接入与工作台

## Goal

接手 origin/feat/web-management-capabilities，在当前主干上恢复并验证 Web 管理 P0 核心链路：登录、设备配对/在线状态、工作区树、conversation.start/prompt、已有会话恢复、操作状态、离线失败反馈与桌面端确认。

## Requirements

- 在桌面端提供 Web 设备桥接设置：保存服务地址、设备名称、自动连接开关，并显示设备 ID、配对状态和在线状态。
- 支持一次性配对码生成、复制、清除和重新配对；配对凭据仅由 Rust 后端管理，不暴露到浏览器页面。
- 浏览器端提供登录后的工作台，可展示已配对设备、设备在线/离线状态和项目/分组/Worktree 工作区树。
- 浏览器通过 WebSocket 提交 `conversation.start` 与 `conversation.prompt`，支持恢复已存在的 CLI 会话，并接收 submitted、accepted、running、succeeded、failed、rejected 状态。
- 桌面端在执行浏览器请求前显示原生确认；设备离线、连接断开、超时和执行失败必须返回可识别的错误状态，刷新或重连不得重复执行同一操作。
- P0 不包含文件传输、独立 Git/历史/分析页面、SSH 对话和 Web Provider 管理；不得向 Web 暴露本地路径、环境变量、Provider 密钥或 SSH 凭据。

## Acceptance Criteria

- [ ] `npm run web:typecheck`、`npm run web:build`、`npm run web:server:check` 和 `npm run web:server:test` 通过。
- [ ] `cargo check --manifest-path src-tauri/Cargo.toml` 与 `npx tsc --noEmit` 通过。
- [ ] 设置页可保存 Web 设备配置，生成/复制配对码，并在连接后显示在线状态；断开后显示离线/停止状态。
- [ ] 浏览器登录并配对设备后能看到工作区树，启动新会话、发送消息和恢复会话均能收到完整状态闭环。
- [ ] 桌面端拒绝或取消原生确认时，浏览器收到 rejected/failed，不产生后台任务；重复请求使用幂等键不会重复创建会话。
- [ ] 浏览器刷新、WebSocket 断线重连和设备离线均有明确反馈，且不会泄露敏感配置。

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
