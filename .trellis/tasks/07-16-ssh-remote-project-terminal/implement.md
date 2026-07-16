# SSH 远程项目 / 远程终端执行计划

## 1. 实施目标

本执行计划只覆盖 P1 SSH 远程终端 MVP：SSH 主机管理、SSH 远程项目、远程路径选择/检测、系统 OpenSSH PTY、连接状态、恢复元数据，以及全应用能力降级。远程文件、Git、Worktree、历史、Hook 和统计不在本次实现范围。

## 2. 实施前置

- 总体设计已批准。
- UI 已批准，最终稿见 `ui/project-type-tabs-v3.png` 等页面。
- Changelog Target 为 `[TEMP]`，最终完成时更新 `CHANGELOG.md`。
- 实现前加载 `trellis-before-dev`，重新读取 frontend/backend spec index。
- 修改任何函数、类或方法前必须运行 GitNexus `impact`；当前 MCP 不可用时使用项目本地 GitNexus CLI。HIGH/CRITICAL 风险必须先告知用户。

## 3. Discovery List

### 数据与项目模型

- `src/lib/types.ts`：Project/CreateProjectInput/TerminalSession 类型。
- `src-tauri/src/lib.rs`：SQLite migration。
- `src/stores/projectStore.ts`：项目 CRUD、树构建、排序与分组。
- `src/components/ConfigModal.tsx`：新增/编辑终端表单。
- `src/lib/db.ts`：数据库初始化边界。

### 终端启动与恢复

- `src/stores/terminalStore.ts`：createSession、split、duplicate、restore、PTY invoke。
- `src-tauri/src/commands/terminal.rs`：`pty_create` IPC。
- `src-tauri/src/pty/manager.rs`：本地进程/PTTY 启动。
- `src-tauri/src/daemon/protocol.rs`、`client.rs`、`server.rs`：daemon 创建与 attach 协议。
- `src/lib/sessionSnapshotPersistence.ts`：会话快照。
- `src/components/TerminalTabs.tsx`、`XTermTerminal.tsx`：Tab 状态和连接反馈。

### 项目树与能力入口

- `src/components/sidebar/index.tsx`、`ProjectTree.tsx`、`TreeNodeItem.tsx`：项目打开、右键菜单、标识。
- `src/lib/terminalProject.ts`：项目/会话归属解析。
- `src/stores/fileExplorerStore.ts`、`gitStore.ts`、`worktreeStore.ts`：SSH 项目能力阻断。
- `src/components/files/FileExplorerSidebar.tsx`、`components/git/*`：统一不支持空态。
- `src/components/HistoryWorkspace.tsx`、统计入口：避免使用远程路径匹配本地历史。

### 设置、安全、同步与 i18n

- `src/components/SettingsModal.tsx`、`settings/pages/*`：SSH 主机页入口。
- `src-tauri/src/credential_store.rs`：未来凭据引用边界；MVP 不保存密码。
- `src/stores/syncStore.ts`、`src-tauri/src/sync/*`：同步过滤。
- `src/lib/i18n.ts`：zh-CN/en-US 文案。
- 日志模块：主机、认证和代理信息脱敏。

## 4. 分阶段实现

### Stage 1：领域模型与数据库

状态：已完成并通过阶段 review（2026-07-17）。验证：SSH migration 定向 Rust 测试、`cargo check`、`npx tsc --noEmit`。

1. 新增 `ssh_hosts` 表及索引。
2. 为 `projects` 增加 `environment_type`、`ssh_host_id`、`remote_path`。
3. 旧项目迁移为 `local`，不改变现有 `path` 行为。
4. 增加 TypeScript 类型、SSH Host store 和 CRUD。
5. 添加数据库迁移/修复路径测试。

验收：升级前项目列表、排序、分组和启动行为不变；SSH 主机可持久化但不含秘密。

### Stage 2：SSH 主机设置页

状态：已完成并通过阶段 review（2026-07-17）。验证：SSH 参数构建 Rust 单测、`cargo check`、`npx tsc --noEmit`；运行时视觉与真实服务器连接列入最终人工验收。

1. 设置导航增加“SSH 主机”。
2. 实现主机列表、手动分组、搜索、添加、编辑、复制、删除。
3. 实现基本信息、认证策略、跳板/代理、连接、初始化分区。
4. MVP 认证支持 SSH Config、Agent、IdentityFile、密码/交互询问；不保存密码。
5. 实现 OpenSSH 探测和结构化测试连接命令。

验收：配置、测试和错误诊断完整；敏感数据不进入 SQLite/日志。

### Stage 3：新增终端类型 Tab 与 SSH 项目

状态：已完成并通过阶段 review（2026-07-17）。验证：`npx tsc --noEmit`；最终人工验收需检查本地/SSH 草稿切换、编辑锁定类型和本地表单零回归。

1. 在现有 `ConfigModal` 顶部增加“本地项目 / SSH 远程项目”Tab。
2. 本地 Tab 保持现有字段、校验和行为。
3. SSH Tab 显示主机、远程路径、浏览/检测、公共 CLI 配置。
4. 两套草稿分别缓存，切换不丢输入。
5. SSH 项目隐藏 Shell/Worktree，展示 P1 能力提示。

验收：本地表单零回归；SSH 项目可创建、编辑、分组、排序和删除。

### Stage 4：远程目录浏览与检测

状态：已完成并通过阶段 review（2026-07-17）。验证：远程路径引用/遍历拒绝 Rust 单测、SSH command 单测、`cargo check`、`npx tsc --noEmit`；真实 SFTP/SSH 服务器行为列入最终人工验收。

1. 实现短生命周期 SSH/SFTP 浏览会话。
2. 支持路径输入、面包屑、目录列表、刷新和选择。
3. SFTP 不可用时降级为手工路径 + `ssh test -d`。
4. 检测目录存在、可进入和 Git 仓库状态，仅展示结果，不启用远程 Git 面板。
5. 认证过程不创建正式终端、不进入历史。

验收：Agent/私钥/密码交互均可选择路径；SFTP 禁用时仍可创建项目。

### Stage 5：SSH Terminal Launch Plan

状态：已完成并通过阶段 review（2026-07-17）。验证：SSH Launch Plan、命令转义、daemon 协议和兼容性 Rust 单测、`cargo check`、`npx tsc --noEmit`。

1. 定义结构化 SSH Launch Plan 和 IPC/daemon 协议字段。
2. Rust 根据 Host 配置生成 OpenSSH 参数，前端不拼 SSH 命令。
3. 使用安全 POSIX wrapper 进入 `remote_path` 并执行启动命令。
4. 本地 `ssh` 进程作为现有 PTY/daemon 根进程。
5. 处理 Host Key、认证、超时、远端退出和本地进程异常。

验收：从项目树、分屏、复制 Tab、批量启动等所有入口打开 SSH 项目均使用同一 Launch Plan。

### Stage 6：会话状态、恢复与后台任务

状态：已完成并通过阶段 review（2026-07-17）。验证：会话状态持久化、断开分类、daemon attach/退出恢复路径 review、`cargo test --lib`、`cargo check`、`npx tsc --noEmit`。

1. TerminalSession 持久化 environmentType/sshHostId/remotePath/connectionState。
2. Tab/hover/侧栏显示连接主机和状态。
3. daemon attach 存活 SSH PTY；已退出会话显示断开，不重跑启动命令。
4. 网络断开、远端 shell 退出、本地 ssh 退出分别分类。
5. 系统资源面板明确仍为“本机资源”。

验收：本地与 SSH 会话混合分屏、Workspan、退出和恢复正确。

### Stage 7：Capability Router 与全应用降级

状态：已完成并通过阶段 review（2026-07-17）。验证：全应用能力入口审计、SSH 空路径本地误匹配根因修复、文件/Worktree 硬拒绝 review、`cargo test --lib`、`npx tsc --noEmit`。

1. 增加项目运行环境能力解析器。
2. 文件、Git、Worktree、历史、Hook、统计、Provider 等入口统一查询能力。
3. SSH P1 禁止调用本地 fs/git/worktree/history API。
4. 提供统一“远程环境暂未支持”空态与说明。
5. 命令模板、项目分组、Tab、Pane、Workspan 保持可用。

验收：遍历 `scenario-matrix.md` 的功能矩阵，无任何远程路径误入本地接口。

### Stage 8：安全、同步、i18n 与收尾

状态：已完成并通过阶段 review（2026-07-17）。验证：同步字段白名单与重新绑定 review、SSH 参数日志脱敏、zh-CN/en-US 文案检查、`cargo test --lib`、`cargo check`、`npx tsc --noEmit`。

1. 日志脱敏和远程命令转义测试。
2. WebDAV/导出排除秘密与机器相关私钥路径，导入后要求重新绑定。
3. 补齐 zh-CN/en-US 文案和 aria。
4. 更新 `docs/功能清单.md` 与 `CHANGELOG.md` 的 `[TEMP]`。
5. 关联 Issue #145 的提交说明。

## 5. 验证顺序

1. 针对新增/修改 Rust 模块执行定向 `cargo test`。
2. `npx tsc --noEmit`。
3. `cd src-tauri && cargo check`。
4. `cd src-tauri && cargo test`。
5. 手工验证 Windows OpenSSH 直连、Agent、私钥、密码交互、首次指纹、ProxyJump、SFTP 禁用、断网和恢复。
6. 手动切换 zh-CN/en-US，确认 24 小时制。
7. GitNexus `detect_changes({scope: compare, base_ref: master})` 或本地 CLI 等价检查。

不主动运行 `npm run dev/build` 或 `npm run tauri dev/build`，除非用户在当前轮明确要求。

## 6. 风险与回滚点

- 数据迁移风险：Stage 1 单独提交，确保可回滚且旧项目默认 local。
- PTY/daemon 高风险：Stage 5/6 分离提交，协议保持向后兼容。
- 命令注入风险：远程路径和启动命令必须经过专用构建器和测试，不允许组件字符串拼接。
- 能力误路由风险：Stage 7 在开放 UI 入口前完成。
- 跨平台风险：Windows 为 P1 首要验收平台；macOS/Linux 保持设计兼容但不虚假宣称已验证。

## 7. 进入实现条件

- [x] PRD 已批准。
- [x] 总体设计已批准。
- [x] UI 已批准。
- [x] `Changelog Target` 已记录。
- [x] 用户审阅并批准本 `implement.md`。
- [x] 执行 `task.py start`，进入 in_progress。
