# cc-connect 首版验证

日期：2026-07-15

## 通过

- `cc-connect.exe --version`：v1.4.1，commit `5d4c96dd`。
- 本机 EXE SHA-256：`D3F7B0C673A4D5539A461639C98ECA054D18B1FA38FC1AFC6422A7BBF3A2B18D`，与上游 v1.4.1 `checksums.txt` 的 Windows amd64 值一致。
- 用包含 Agent 空密钥覆盖、完整命令限制和 Telegram 平台配置的临时 TOML 执行 `cc-connect config format --config ...` 成功；临时文件已删除。
- `tsc --noEmit` 全量通过。
- `npm run build` 通过：Vite 完成 6595 个模块转换并生成生产包；仅有既有的动态/静态混合导入和大 chunk 警告。
- 为恢复原有终端路径调用链，补回了上游 master 已存在的 `src/lib/terminalOscPath.ts`。
- Rust stable 已安装到 `F:\rust`：`cargo 1.97.0`、`rustc 1.97.0`、`rustfmt 1.9.0`、`clippy 0.1.97`。
- 新增 Rust 文件已执行 rustfmt，针对 `cc_connect.rs` 与 `credential_store.rs` 的格式检查通过。
- `cargo check` 已通过。
- `cargo test cc_connect::tests --lib` 已通过：5 项通过、0 项失败，覆盖版本/哈希、白名单、安全配置、日志脱敏，以及 Windows 普通路径、`\\?\` 扩展路径和 UNC 路径。
- 真实 Telegram 链路已验证：代理连接、Bot 鉴权、用户白名单、消息接收及 Codex 回复链路均已跑通。
- 修复 Windows 扩展路径泄漏：Agent `work_dir` 从 `//?/F:/...` 规范化为 `F:/...`，界面中的 cc-connect 可执行文件路径不再展示 `\\?\` 前缀。
- `git diff --check` 通过，仅输出工作区既有的 LF/CRLF 转换提示。
- 两轮后端并发/Windows API/安全审查及一轮前端审查完成，发现的高风险二进制信任、命令绕过、凭证继承和操作竞态已做本地缓解。

## 未完成或未执行

- 飞书真实账号链路尚未验证。
- 尚未启动 Tauri 窗口手动切换中英文；新增中英文键已由全量 TypeScript 检查与生产构建覆盖。
- Windows 路径修复后的安装包尚未重新生成，等待用户明确提出“打包”后执行。

## 代理与日志开关增量验证（2026-07-16）

- cargo test cc_connect::tests --lib 通过：12 项通过、0 项失败。
- 新增覆盖：旧配置缺少开关字段、代理关闭时忽略手动地址和本地端口、清理继承代理环境、关闭时暂不校验保留的代理地址。
- cargo check 通过。
- npm run build 通过；仅有既有的动态/静态混合导入和大 chunk 警告。
- git diff --check 通过，仅有工作区既有的 LF/CRLF 转换提示。
- 尚未启动 Tauri 窗口手动检查开关交互与中英文切换；本次未打包。

## 远程项目切换增量验证（2026-07-16）

- 新增 /cli_manager_list（兼容连字符写法），输出托管配置生成时 CLI-Manager 已登记的项目、路径、当前项目及不可用路径状态。
- 修复 Telegram 菜单展开全部项目的问题：托管配置只注册一个 `/cli_manager_switch <序号>` 命令，不再为每个项目生成 `cli-manager-switch-N` 命令或 alias。
- 单一切换命令调用 CLI-Manager 生成的参数校验脚本；脚本按与项目列表相同的快照将序号映射为项目 ID 摘要令牌，再请求已运行的 CLI-Manager 更新 profile/config 并延迟重启受管 cc-connect。
- 切换请求使用独立请求 ID 返回结果，避免并发切换复用同一结果文件；脚本严格拒绝缺参、零、负数、非数字、额外参数、越界序号及 PowerShell 注入形式。
- 切换参数不接受任意路径；/dir、/shell、/commands 等高风险命令仍保持禁用。
- 未修改 cc-connect 源码、全局 npm 包或可执行文件，仅使用其 v1.4.1 原生自定义命令参数能力。
- cargo test cc_connect::tests --lib 通过：17 项通过、0 项失败；包含真实 cc-connect v1.4.1 配置格式验证、Windows PowerShell UTF-8 清单输出、参数边界及 here-string + Base64 参数隔离验证。
- cargo check 通过。
- npm run build 通过；仅有既有的动态/静态混合导入和大 chunk 警告。
- 未执行真实 Telegram/飞书消息下的单实例回调与受管进程重启冒烟；需使用新构建安装包验证。

## 远程项目目录与 Provider 标识增量验证（2026-07-16）

- `/cli_manager_list` 按 CLI-Manager `groups.parent_id` 目录树输出项目，保留多级目录；没有有效目录的项目统一进入“未分组 / Ungrouped”。
- 每个项目固定显示 Agent 和 Provider：项目级 `provider_overrides` 优先；未覆盖时读取 cc-switch 当前 Claude/Codex 全局 Provider；cc-switch 不可用时安全回退为“跟随全局”。
- 同名项目可通过目录、Agent、Provider 和路径区分；当前项目标题也同步包含 Agent 与 Provider，不再只显示名称。
- 项目序号和切换脚本使用同一份树形排序快照，保证 `/cli_manager_switch <序号>` 与列表展示严格一致；项目 ID 摘要令牌算法未变。
- 新增中文/英文、嵌套目录、未分组、孤立目录、重复名称、项目级 Provider、全局 Provider 与 Provider 名称回退测试。
- `cargo test cc_connect::tests --lib` 通过：20 项通过、0 项失败。
- `cargo check` 通过。
- `npm run build` 通过；仅有既有的动态/静态混合导入和大 chunk 警告。
- 本次未修改 cc-connect 源码、全局 npm 包或可执行文件，且未打包安装包。

## cc-connect 可执行文件手动选择增量验证（2026-07-17）

- 根因确认：Windows 文件对话框和 Rust `canonicalize()` 会返回 `\\?\` 扩展路径；后端此前把该路径直接写入 profile，而前端优先展示 profile，导致界面重新出现扩展前缀。
- 根因确认：选择新程序此前只更新前端表单并禁用“重新检测”，没有把新路径提交给检测链路，因此仍显示旧程序的“已检测”状态。
- profile 读取与保存现统一转换为普通用户路径；已有 `\\?\D:\...` 和 `\\?\UNC\...` 配置无需手工修改即可正常回显。
- 新增只读的显式可执行文件检测 IPC；选择文件后立即校验文件、SHA-256 和版本，手动输入路径后也可点击“重新检测”。
- 本机 `D:\nvm\nvmnew\v22.19.0\node_modules\cc-connect\bin\cc-connect.exe` 验证存在，版本为 `1.4.1`，SHA-256 为 `D3F7B0C673A4D5539A461639C98ECA054D18B1FA38FC1AFC6422A7BBF3A2B18D`。
- `cargo test commands::cc_connect::tests --lib` 通过：24 项通过、0 项失败；新增覆盖扩展路径归一化和显式程序检测。
- `cargo check` 通过。
- cc-connect 设置页独立严格 TypeScript 检查通过。
- 全量 `tsc --noEmit` 仍被上游 `a7e773d` 引用但未提交的 `src/lib/syncSettings.ts` 阻断，并伴随 `syncStore.ts` 的既有 TS2538；本次改动未新增 TypeScript 错误。
- 未修改 cc-connect 源码、全局 npm 安装或用户配置文件；尚未打包和启动 Tauri 窗口手动验证。

## cc-connect Telegram 任务排队增量验证（2026-07-17）

- 日志确认 Telegram 已连接并能接收消息；无回复发生在消息进入 Codex app-server 后，后续消息因首个任务不结束而进入 cc-connect 队列。
- 进程树确认 Codex 全局 `codebase-memory-mcp` 卡在 `git -C F:\test\work\amz\amazon rev-parse --git-dir`，任务尚未进入模型请求阶段。
- 同一路径在未注入配置时触发 Git dubious ownership；通过 `GIT_CONFIG_COUNT/KEY/VALUE` 临时注入当前项目 `safe.directory` 后，命令在 1 秒内返回 `.git`。
- 修复仅写入 CLI-Manager 启动的 cc-connect 子进程环境，并由 Codex/MCP 后代进程继承；不会执行 `git config --global`，也不会信任当前登记项目以外的目录。

## cc-connect 项目 Provider、微信与企业微信增量验证（2026-07-18）

- 根因结论：远程 Codex 的 Git 信任与 Provider 路由缺失发生在 CLI-Manager 启动 cc-connect 的进程边界，因此修复落在受管子进程环境和 Codex 启动包装层，而不是在 Telegram 消息或 cc-connect 响应层增加重试。
- 远程 Codex 直接读取已登记项目的 `provider_overrides.codex.providerId`；项目默认 Agent 不是 Codex、但远程 Agent 手动选择 Codex 时，也会读取该项目的 Codex override 或当前全局 Codex Provider。
- 复用 cc-switch 的 Provider 解析与真实 `CODEX_HOME` profile 写入逻辑；CLI-Manager 托管的 `codex` wrapper 强制在 `app-server` 前传入 `--profile`，密钥只进入受管进程环境，不写入 wrapper、TOML 或项目目录。
- 微信个人号使用 cc-connect v1.4.1 原生 `type = "weixin"` ilink 通道，配置 Bearer Token、显式 `allow_from` 和按项目隔离的 `account_id`。
- 企业微信使用 cc-connect v1.4.1 原生 `type = "wecom"` WebSocket 智能机器人通道，配置 `mode = "websocket"`、BotID、Secret 和显式 `allow_from`；不实现额外协议，也未修改 cc-connect 源码或全局安装。
- 微信、企业微信凭据与 Telegram、飞书一致存入 Windows 凭据管理器；托管 TOML 仅保留环境变量占位符，Agent 子进程会清空平台凭据变量，避免密钥继续向下继承。
- 场景检查覆盖：本地终端会话已打开/未打开、项目默认 Claude/远程选择 Codex、项目级/全局 Codex Provider、代理开/关、日志开/关、四种消息平台及凭据缺失阻断；多窗口、分屏、Worktree 与 hook 状态不参与该独立受管进程链路。
- 触点清单已复核：`cc_connect.rs`（配置、凭据、项目快照、进程环境）、`ccswitch.rs`（Provider 解析/profile 写入）、`CcConnectSettingsPage.tsx`（真实设置入口）、`i18n.ts`（中英文）、cc-connect v1.4.1 `docs/weixin.md` / `docs/wecom.md` 与 `config.example.toml`（原生契约）；终端 PTY、daemon、Worktree 与 hook 调用链确认无业务改动。
- `cargo check` 通过。
- `cargo test commands::cc_connect::tests --lib` 通过：28 项通过、0 项失败。
- `cargo test commands::ccswitch::tests --lib` 通过：33 项通过、0 项失败，确认抽出的 Provider 查询与 profile 写入入口未破坏现有切换逻辑。
- 指定本机 cc-connect v1.4.1 可执行文件运行真实配置语法验证通过：Telegram、飞书、微信和企业微信四类托管 TOML 均通过 `cc-connect config format`。
- `git diff --check` 通过，仅有工作区既有的 LF/CRLF 转换提示。
- 全量 `tsc --noEmit` 仍被上游缺失的 `src/lib/syncSettings.ts` 和 `syncStore.ts` 既有 TS2538 阻断；本次新增设置页未产生新的 TypeScript 诊断。
- 尚未使用真实微信 ilink Token 或企业微信 BotID/Secret 做账号链路验证；本次未打包、未 push。
