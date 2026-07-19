# Web 端工程实施

## Goal

基于现有 Web 端设计文档启动可持续迭代的独立 Web 工程。首批先完成工程骨架、双主题全局框架和工作台空状态，后续按 P0→P3 逐步接入 Rust Web 服务、桌面协议与业务页面；SSH 相关页面、协议和入口暂不实施。

- Changelog Target: `[TEMP]`

## Requirements

- Web 前端与现有 Tauri 前端隔离，避免浏览器构建加载 `@tauri-apps/*` 运行时。
- 复用仓库现有 React、TypeScript、Vite、Tailwind 和 Lucide 技术栈，不新增 UI 框架。
- 首批实现浅色、深色、跟随系统三种主题及浏览器本地记忆。
- 首批实现响应式全局框架：桌面导航/侧栏/主区/辅助区与移动端单栏/底部导航。
- 首批实现工作台空状态、动态问候、建议卡、输入框、模型与权限占位控制、设备同步状态。
- 用户可见文案同时支持 `zh-CN` 与 `en-US`，时间保持 24 小时制。
- 数据使用显式 Mock/缓存快照，不伪装为真实桌面回执或业务事实。
- 后续 Rust Web 服务保持模块化单体、SQLite3 单实例，不提前引入 Redis。
- SSH、文件、Git、Worktree 与 Hook 能力统一通过桌面 operation 执行，Web 服务不直接访问本机资源。

## Acceptance Criteria

- [ ] Web 工程可独立启动和生产构建，不依赖 Tauri WebView。
- [ ] 桌面宽度下呈现导航、上下文侧栏、工作台和辅助区；移动宽度下无整页横向滚动并显示底部导航。
- [ ] 浅色、深色、跟随系统可切换并持久化，切换不改变功能布局。
- [ ] 工作台建议卡只填充可编辑 Prompt，不直接触发执行。
- [ ] 离线/缓存/同步状态有文字标识，Mock 数据不会显示为桌面确认成功。
- [ ] 新增文案在中英文下均可显示，图标按钮具备可访问名称。
- [ ] TypeScript 类型检查和 Web 生产构建通过。
- [x] SSH、文件、Git、Worktree 与 Hook 管理入口仅在设备在线且声明对应 capability 时可执行。
- [x] 高风险写操作必须经过 Web 目标确认和桌面原生确认，桌面再次校验项目、路径、Worktree、Git 与 Hook 边界。

## Definition of Done

- 当前阶段代码、类型检查和构建通过。
- 关键响应式布局经过桌面和移动视口检查。
- 变更范围通过 GitNexus 变更检测或等价直接检查确认。
- 后续阶段保持可增量接入真实协议，不将 Mock 固化为业务数据源。

## Decision (ADR-lite)

**Context**：现有 `src/` 是 Tauri 桌面前端，入口和大量模块直接依赖 Tauri API，浏览器构建不能安全复用该应用入口。

**Decision**：新增独立 Web 前端包，共享设计语言和可复用的纯 TypeScript 代码，但不直接复用桌面应用入口；首批先落地 UI Shell 与 Mock 数据边界，再接入 Rust Web 服务。

**Consequences**：短期存在两个前端入口，但浏览器与桌面运行时边界清晰；后续只在出现真实复用需求时提取共享包，避免提前重构桌面代码。

## Out of Scope

- SSH 私钥、密码、凭据写入和浏览器终端流。
- 浏览器 PTY/xterm。
- 多用户、组织身份、细粒度授权管理、设备撤销和浏览器会话管理页面。
- 供应商、备份与状态栏设计器等本轮未授权能力。
- 为共享而重构现有桌面前端。
- Redis、多实例和微服务拆分。

## P0-S2 Extension

- 新增独立 Rust Web 服务与共享协议包，完成本地单用户登录、设备配对、设备/浏览器 WebSocket、历史快照和幂等对话操作。
- 浏览器使用 HttpOnly、SameSite=Strict Cookie；密码使用 Argon2 哈希，服务端不提供默认密码。
- 设备连接首帧必须为 hello；已配对设备验证 token，未配对设备只允许配对和心跳。
- 浏览器事件持久化 sequence 并支持 afterSequence 补传；慢客户端使用有界队列并断开重连。
- 操作只有桌面最终回执才能进入终态；离线设备禁止创建新操作。
- 验证包含 Rust format/check/test、Web typecheck/build 和前后端契约检查。

## P0-S3 Desktop Device Adapter

- Tauri 桌面端由 Rust 托管 `/ws/device` 长连接；窗口隐藏、最小化或进入托盘时连接不依赖 React 组件生命周期。
- 设备 ID 和非敏感连接配置持久化到本地应用数据目录，设备 Token 只保存到系统原生凭据库。
- 支持首次配对、自动重连、心跳、历史快照和 operation 回执；远程地址必须使用 `wss://`，仅 loopback 允许明文 `ws://`。
- Web 新对话必须显式选择来自桌面历史快照的项目上下文；继续对话携带 `source/sessionId/projectKey/cwd`。
- 桌面只允许 `conversation.start` 与 `conversation.prompt`，并校验本地项目、Worktree、CLI 类型、Hook 和非空 Prompt；SSH 项目继续排除。
- operation 严格由桌面推进 `accepted -> running -> terminal`，CLI `Stop/StopFailure` Hook 决定成功或失败；重复 operation 不重复执行。

### P0-S3 Acceptance

- [ ] 未配对设备可生成短期配对码，浏览器认领后 Token 不进入前端状态、日志或普通配置文件。
- [ ] 有效 Token 可重连；错误 Token、非法协议或远程明文 WebSocket 不会建立可信连接。
- [ ] 历史快照可在 Web 端形成明确项目上下文，新对话不依赖桌面当前焦点或当前 Tab。
- [ ] Claude/Codex 的新对话和历史恢复对话可创建真实本地会话并提交 Prompt。
- [ ] Hook 缺失、项目/Worktree 不存在、CLI 不匹配或 SSH 项目会返回结构化失败，不执行任意命令。
- [ ] 窗口隐藏或最小化时 Rust 连接保持；前端恢复后可继续消费待处理 operation。
- [ ] Rust/TypeScript 检查和相关测试通过。

## P0-S4 Management Operations

- 统一扩展 operation kind，覆盖 SSH 主机查询/检测、项目文件管理、Git、Worktree 与 Hook 安装/修复/测试/卸载。
- 浏览器只提交结构化参数；桌面根据本地项目、Worktree、SSH Host 和 Hook 配置解析可信路径与凭据引用。
- 文件、Git、Worktree、SSH 主机和 Hook 等写操作要求浏览器先确认，并在桌面端再次弹出不可由远端伪造的原生确认；`confirmed=true` 只表示浏览器意图。
- SSH 密码、私钥、credentialRef、identityFile、proxyCommand 和完整环境变量不得进入 Web payload、result、日志或缓存。
- 设备 capability 决定可用入口；离线、缓存过期或版本不兼容时仅保留只读展示。

### P0-S4 Acceptance

- [x] Web 可查询 SSH 主机摘要、检测客户端/连接/远程路径，不回传本机密钥与凭据字段。
- [x] Web 可列目录、搜索、创建、重命名、复制、移动和删除项目内文件，所有路径由桌面 canonicalize。
- [x] Web 可读取 Git 状态/分支并执行 Fetch、Checkout、建分支、暂存、提交、Pull、Push、丢弃和未跟踪文件删除。
- [x] Web 可列出、创建、检查依赖、合并和删除 Worktree，危险生命周期操作必须确认。
- [x] Web 可检测、安装、修复、测试和卸载 Claude/Codex Hook，配置目录只由桌面设置解析。
- [x] Rust/TypeScript 定向检查与 operation 契约测试通过。

## Technical Notes

- 产品范围：`docs/web-design/01-产品范围与实施计划.md`
- 设计系统：`docs/web-design/03-全局框架与设计系统.md`
- 状态验收：`docs/web-design/13-状态矩阵与验收标准.md`
- 后端架构：`docs/web-design/14-Web后端技术架构.md`
- 首批视觉基准：`docs/design/web-complete/light/01-global-shell-desktop.png`、`docs/design/web-complete/light/03-global-shell-mobile.png`
