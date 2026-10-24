# 实施计划：资源管理器右键在此处打开 CLI-Manager

## 前置门槛

- [ ] 重新运行 GitNexus 分析并确认索引可用；对将修改的 Rust/TS 符号执行 upstream impact，若为 HIGH/CRITICAL 先停下报告。
- [ ] 审阅 `prd.md`、`design.md`，确认 P0/P1 与扩展项边界；本计划不包含扩展项实现。
- [ ] 保持任务状态为 `planning`，审阅通过后再执行 `python ./.trellis/scripts/task.py start ...`。

## 执行步骤

### 1. Rust 启动参数与可靠队列

- [ ] 在 `src-tauri/src/features/app/`（或现有 app 入口的最小模块）新增纯参数解析、路径校验和 `VecDeque` 请求队列。
- [ ] 在 `src-tauri/src/lib.rs` 注册队列 state、冷启动 argv 解析、single-instance 回调入队/事件通知和 `take_pending_open_terminal_requests` command。
- [ ] 保留已有后台会话参数行为；两个请求类型互不覆盖。
- [ ] 添加 Rust 单测：独立参数、等号参数、空参数、多请求顺序、中文/空格/UNC 文本、队列上限。

### 2. 前端请求消费与终端标签

- [ ] 新增 `src/features/terminal/api/externalOpenTerminal.ts`，封装事件监听、初始 drain、启动门控、错误映射和重复消费保护。
- [ ] 在 `useTerminalTabsController` 接入请求消费：复用 `createSession(undefined, cwd, title, undefined)`，关闭历史/切换终端视图/激活会话/聚焦窗口。
- [ ] 明确恢复会话 prompt 与外部请求的顺序，确保启动期间请求不丢失。
- [ ] 增加前端定向测试（可抽纯函数测试）：标题生成、根路径保留、请求顺序、失败后继续处理后续队列。

### 3. Explorer 注册与清理

- [ ] 修改 `src-tauri/installer/hooks.nsh` 或拆出受控 include，安装时写入 `Directory` 与 `Directory\\Background` 的 HKCU 菜单及 command 值。
- [ ] 升级时覆盖旧 exe 路径；卸载时只删除 CLI-Manager 自己的键。
- [ ] 加入脚本静态断言/文档化检查，确认 `%1` 与 `%V`、引号和 exe 路径均正确。

### 4. 国际化、日志与文档

- [ ] 在 `src/shared/i18n/messages/zh-CN` 与 `en-US` 对应领域增加路径无效、目录不可访问、创建失败等文案。
- [ ] 增加结构化日志字段，避免记录无关命令行参数或敏感内容。
- [ ] 实现交付时更新 `CHANGELOG.md` 和 `docs/功能清单.md`，版本使用 `V1.4.5`。
- [ ] 若实现阶段需要修改版本源，按 `.trellis/spec/guides/version-update-checklist.md` 同步 `package.json`、lockfile、Cargo、Tauri 配置；本规划阶段不提前改版本文件。

### 5. 验证与回归

- [ ] `npx tsc --noEmit`。
- [ ] `cd src-tauri && cargo test`（至少运行新增模块定向测试和现有 terminal/lib 测试）。
- [ ] `npm run check:architecture -- --strict`。
- [ ] 构建 NSIS 并在 Windows 环境手测：新装、升级覆盖、卸载清理、当前用户无管理员权限。
- [ ] 手测矩阵：冷启动/已运行/最小化或托盘、目录/空白处、中文/空格/`C:\`/UNC、多次快速触发、PowerShell/CMD/pwsh/Git Bash/WSL 默认 Shell。
- [ ] 运行 `gitnexus_detect_changes(scope="all")`，确认只影响预期符号、流程和文档；发现意外跨域改动先停下复核。

## 回滚点

1. 若单实例队列或启动门控出现回归，可先移除前端消费入口；Rust command/事件保留但不触发新会话。
2. 若 NSIS 注册影响安装，可独立回滚 `hooks.nsh` 的菜单宏，不影响应用内终端功能。
3. 若路径兼容问题仅发生在某类 Shell，回滚 Shell 选择改动，继续使用现有 `createSession` 作为唯一启动路径。

## 完成定义

- [ ] P0 验收标准全部通过，P1 无已知回归。
- [ ] 代码变更、`CHANGELOG.md`、`docs/功能清单.md` 和任务文档一致记录 `V1.4.5`。
- [ ] 仅在上述检查通过且 GitNexus 变更检测范围符合预期后，进入提交/PR 阶段。
