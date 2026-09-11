# Implementation Plan

1. 配置独立 Web 前端包和根级启动/构建脚本。
2. 实现主题、国际化和基础 Mock 状态模型。
3. 实现桌面/移动响应式全局框架与工作台空状态。
4. 补齐可访问性、减少动画和移动安全区样式。
5. 运行类型检查、生产构建和差异范围检查。
6. 新增共享 Web 协议、Rust Axum/SQLx 服务、本地单用户认证和 SQLite3 持久化。
7. 实现设备/浏览器 WebSocket、配对、历史快照、sequence 补传和幂等 operation 状态机。
8. 前端接入真实认证、设备、历史和操作 API，修复契约差异并保持中英文错误文案。
9. 运行 Rust format/check/test、Web typecheck/build 和变更范围检查。
10. 实现 Tauri `WebDeviceManager`、系统凭据、配对、重连、心跳、历史快照和 operation 队列。
11. 桌面前端接入 Web operation，复用项目/Worktree/CLI 启动和 Hook 终态回执。
12. Web 工作台新增显式项目上下文并补齐 operation payload。
13. 在现有“远程连接”设置页增加 Web 设备配置与配对状态，保持中英文兼容。
14. 运行 Rust/TypeScript 定向检查、协议测试与 GitNexus 变更检测。
15. 扩展 operation kind、设备 capability 和服务端确认校验，覆盖 SSH/文件/Git/Worktree/Hook。
16. 桌面 bridge 复用现有 command/store 执行五类管理 operation，并对路径、项目和敏感字段做二次校验。
17. Web 增加统一管理面板、中英文文案、危险操作确认和结构化结果展示。
18. 更新 Web service contract、功能清单与 `[TEMP]` Changelog，完成定向验证后提交。
19. 补齐桌面原生危险操作确认、operation ACK/中断恢复、队列溢出恢复和 Web 结果脱敏。
