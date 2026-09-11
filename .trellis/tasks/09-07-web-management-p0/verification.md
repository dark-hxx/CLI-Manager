# P0 验证记录

## 已通过

- `npm run web:typecheck`
- `npm run web:build`
- `npm run web:server:check`
- `npm run web:server:test`（35 项）
- `cargo check --manifest-path src-tauri/Cargo.toml`
- `npx tsc --noEmit`
- `git diff --check`

## 交付范围

- 桌面端 Web 设备配置、配对码与在线状态生命周期已接入。
- 浏览器工作台支持设备/项目/Worktree 树、会话启动、Prompt、恢复和操作状态回执。
- 断线、离线、拒绝、失败及幂等请求沿用统一状态机；浏览器协议保持 ID-only，不暴露绝对路径、环境变量或凭据。

## 已知限制

- 原生确认、浏览器刷新/重连和真实设备配对仍需在 Windows 桌面环境执行人工冒烟；当前命令行验证覆盖编译、协议和服务端回归测试。
- P0 不包含文件传输、独立 Git/历史/分析页面、SSH 对话和 Web Provider 管理；这些能力属于后续阶段。
