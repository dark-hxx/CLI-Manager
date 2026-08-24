# OSC 52 本机剪贴板验证（2026-08-17）

## 根因与发现清单

- 根因位于宿主终端 OSC / 鼠标边界：PTY 已转发 OSC 52，前端只处理颜色查询，不写入 Tauri 剪贴板。远端 GUI/`xclip` 写不到 Windows。修复落在 `terminalOscParse` + `useTerminalOsc` + `useTerminalDisplay` + `XTermTerminal`。
- 触点：`src/lib/terminalOscParse.ts`、`src/hooks/useTerminalOsc.ts`、`src/hooks/useTerminalDisplay.ts`、`src/components/XTermTerminal.tsx`、`src/App.tsx`、`src/terminal/browser/TerminalMouseInteraction.ts`、`src/stores/settingsStore.ts`、`src/lib/syncSettings.ts`、`src/lib/i18n.ts`、`ShortcutSettingsPage.tsx`、`.trellis/spec/backend/terminal-osc-color-contracts.md`。
- 确认无关：Rust `osc_color.rs` 仍放过非 10/11 OSC；`systemClipboard.ts` 复用；不改 PTY ACK / daemon 分帧。
- 场景：live 写剪贴板；replay/reset 不写；query 回包；设置关闭；普通拖选 vs Alt 交给 TUI；`Ctrl+Shift+C` 阻止检查元素。

## 验证结果

- `node --test scripts/terminalOsc52.test.mjs scripts/terminalOsc.test.mjs scripts/terminalMouseInteraction.test.mjs`：26 项通过。
- `DISPLAY=:11 bash scripts/terminalOsc52.clipboard.e2e.sh`：live / tmux / replay 三项本机 X11 剪贴板 e2e 通过。
- `npx tsc --noEmit`、`git diff --check`：通过。
- 未在 Windows Tauri 窗口对 Grok 做端到端手测。

## 未覆盖

- Tauri `clipboard-manager` 插件路径依赖桌面 WebView；此处用同一 hook + 本机 `xclip` 验证解码与写剪贴板语义。
- Chromium 检查元素在部分 WebView 版本仍可能有独立绑定，需在 `tauri dev` 下确认 `preventDefault` 生效。

---

# SSH NVM Codex 启动环境修复验证（2026-07-28）

## 根因与发现清单

- 根因位于本机 SSH Proxy 到远端 Codex 的进程启动边界：普通 SSH 终端使用交互式登录 Shell，能通过用户启动脚本加载 NVM；托管代理此前使用非交互登录 Shell `-lc`，远端因此返回 `codex: command not found`，cc-connect 最终只显示“无法连接远端 Codex app-server”。修复落在 `SshCodexLaunch::remote_command`，使代理与终端使用相同的用户环境发现规则。
- 远端启动改为交互式登录 Shell `-lic`，但 Shell 初始化阶段的 stdout 全部导向 stderr；仅在执行 `codex app-server` 时恢复原始 stdout，避免 `.bashrc` banner、NVM 初始化输出或其他 profile 文本污染 JSON-RPC 流。
- 代码触点确认：`SshCodexLaunch::remote_command` 负责远端命令构造；预检和正式托管共用该启动计划，因此同时修复；OpenSSH 参数、AskPass 凭据、Provider 注入、Git `safe.directory`、取消托管恢复和 cc-connect 源码均未改动。
- 运行场景确认：NVM、fnm/asdf 等依赖交互式 Shell 初始化的用户工具路径可被发现；系统 PATH 中已有 Codex 的主机保持兼容；有无初始化输出均由 stdout 隔离保护协议；认证方式、跳板/代理、窗口焦点、分屏及桌宠显示状态不改变该启动逻辑。
- `SshCodexLaunch.remote_command` 属于预检和正式托管共享的 CRITICAL 调用面；本次只调整远端 Shell 启动与文件描述符路由，并通过真实 SSH 探测、单元测试和代理端到端测试复核。

## 验证结果

- 真实 SSH 只读探测通过：非交互登录 Shell 无法找到 NVM 中的 Codex；交互式登录 Shell 能解析远端 Codex 0.145.0，并且 app-server 在 stdin EOF 后以状态 0 退出。
- `cargo test --locked --manifest-path src-tauri/Cargo.toml codex_app_server_proxy::tests --lib`：13 项通过。
- `cargo test --locked --manifest-path src-tauri/Cargo.toml commands::cc_connect:: --lib`：57 项通过。
- `npm run test:codex-proxy:e2e`：4 项通过。
- `cargo fmt --check --manifest-path src-tauri/Cargo.toml`、`cargo check --locked --manifest-path src-tauri/Cargo.toml`：通过。
- `npm run tauri:build:local -- --bundles nsis`：通过，仅生成 NSIS；安装包为 `src-tauri/target/release/bundle/nsis/CLI-Manager_1.3.1_x64-setup.exe`，17,502,968 字节，SHA-256 `798516D71D8C1F10DAA26892C343C3F3A498C4693573E45FF18FC4C18BF39539`。

## 未覆盖与测试边界

- 已验证真实 SSH、远端目录和 Codex app-server 启动，但未使用真实 Telegram/飞书/微信/企业微信消息完成“手机消息 -> 远端 Codex -> 回复”全链路；需由安装包复测消息平台侧行为。
- 本次未复制安装包、未停止用户服务、未修改 cc-connect 源码或全局安装。

---

# 桌宠 Agent 状态与 SSH 托管身份修复验证（2026-07-27）

## 根因与发现清单

- 根因位于终端运行态与 Agent 回合态的聚合边界：`codex` 及其 SSH 进程会跨多个回合长期存活，Shell OSC 和 PTY 重绘只能证明进程/终端有活动，不能证明当前 Agent 回合仍在执行；修复因此落在 `terminalStore` 状态生产与桌宠状态聚合层，由 Hook/daemon 回合事件保持权威，PTY 输出只允许短暂补充空状态。
- SSH 托管不可选的另一根因位于终端身份绑定边界：远端 Hook 未回传 `cliSessionId` 时，桌宠直接过滤了该会话，后端代理没有机会接收原远端线程 ID；修复保留可恢复候选，并通过已登记 SSH Agent 的远端历史做唯一、限时、非空、SSH Codex 且排除其他打开终端已占用 ID 的匹配，零匹配或多匹配均拒绝。
- 安装包复测仍失败的根因同样位于身份绑定边界，但只发生在 `codex resume --last`：上一版只能提取显式 Session ID，`--last` 被当成新会话并错误套用创建时间窗口。运行日志在 22:22:47、22:23:11 返回 `remote_handoff_ssh_session_not_found`，只读历史库同时确认目标项目的最近会话已更新但创建时间早于终端启动。本次将启动命令分类为新建、显式恢复、`--last` 和交互选择；`--last` 只绑定项目范围内更新时间唯一最新且未被其他终端占用的 SSH Codex 会话，交互选择和并列结果继续失败关闭。
- 状态触点已覆盖：`handleShellRuntimeEvent`、`handleCliHookEvent`、PTY 输出活动、daemon 状态、桌宠快照与传输指纹；终端创建、分屏、恢复及 daemon attach 均保留 PTY 创建时间。
- 托管触点已覆盖：资格判断、远端历史同步、唯一身份选择、Zustand 绑定与持久化、桌宠平台/会话二级菜单、中英文状态与错误提示。
- 确认无须修改：cc-connect 源码及全局安装、Rust Codex proxy、托管启动/取消协议、SSH 凭据和 Provider 注入链；现有后端仍只接收经过前端严格绑定的原 `cliSessionId`。
- 场景复核：本地 Agent 仍要求可信停止态；SSH 无 Hook 空闲态可尝试唯一识别；已知 `running`/`attention`、WSL、SSH Worktree、交互认证、缺失 Host 均继续拒绝；多终端通过已占用 ID 和歧义检测防串线。窗口焦点、分屏位置、最小化/托盘不参与身份选择。
- codebase-memory 已用 `moderate` 模式刷新，抽查确认新状态解析入口只由桌宠快照调用，新 SSH 身份解析只由托管协调器调用；`terminalStore` 与远端历史/托管主流程仍属于 HIGH/CRITICAL 风险调用面，因此采用失败关闭和独立回归测试。GitNexus CLI 因 npx 包缺少 `tree-sitter-kotlin` 无法建立本地索引，已按规范降级为 codebase-memory 调用路径分析、SSH 契约、源码与 Git diff 复核。

## 验证结果

- `node scripts/desktopPetStatus.test.mjs`：3 项通过，覆盖完成/失败/审批状态不被后续 PTY 输出重开，以及空状态活动提示过期。
- `node scripts/resumeCliArgs.test.mjs`：7 项通过，覆盖新会话、显式 Session ID、`resume --last` 和交互选择分类，并回归原参数清理/恢复命令构造。
- `node scripts/sshCodexSessionBinding.test.mjs`：8 项通过，覆盖新会话限时唯一匹配、显式旧会话恢复、`--last` 旧会话恢复，以及旧/空/本地/已占用/并列/交互选择拒绝。
- `node scripts/remoteHandoff.test.mjs`：4 项通过，覆盖缺失 ID 时先阻止运行态、SSH 空闲态进入身份恢复及原资格矩阵。
- `node scripts/desktopPetTransport.test.mjs`：4 项通过，桌宠可见托管状态纳入传输指纹。
- `.\node_modules\.bin\tsc.cmd --noEmit`、`npm run build`、`cargo fmt --check --manifest-path src-tauri/Cargo.toml`、`cargo check --locked --manifest-path src-tauri/Cargo.toml`：通过。
- `cargo test --locked --manifest-path src-tauri/ssh-agent/Cargo.toml`：70 项通过；仅有未修改测试模块的既有 unused-import 警告。
- `npm run tauri:build:local -- --bundles nsis`：通过，仅生成 NSIS；安装包为 `src-tauri/target/release/bundle/nsis/CLI-Manager_1.3.1_x64-setup.exe`，17,505,631 字节，SHA-256 `6E56F5FE2E3CAF44139F58BA532264570FD772ACD6E02EE19F9D3193EDBEFC88`。

## 未覆盖与测试边界

- 已连接真实 SSH Codex 主机完成远端目录、Codex 发现和 app-server 启动探测；消息平台对话、远端历史唯一识别及取消恢复仍需使用安装包做一次完整链路冒烟。
- 未启动桌面窗口手动切换中英文；新增键已由 `zh-CN`/`en-US` 类型约束和生产构建覆盖。

---

# SSH Codex 会话远程托管验证（2026-07-27）

## 根因与发现清单

- 桌面宠物把 SSH Codex 会话显示为“空闲”时，资格判断仍将缺少远端 Hook 的 `none` 状态解释为“状态未知”，因此按钮始终禁用；本次只对 SSH 放行该候选状态，已知 `running` / `attention`、本地未知状态和 WSL 行为保持不变。
- 实测两个独立 Codex app-server 不能权威读取对方进程中的活动状态：第二个进程会返回 `idle` / `notLoaded`，提前 `thread/resume` 还可能把未结束 Turn 解释为中断。因此预检只验证 SSH 与 app-server 基础链路，不加载或恢复仍由桌面 PTY 持有的线程；已知运行态继续由现有状态链阻止，托管失败走现有本地恢复链。
- 原托管资格、后端目录校验、Codex 启动和取消后恢复均只支持桌面本地目录/进程，没有携带 SSH Host、远端路径和认证信息；本次在原 cc-connect 托管链上增加本机 OpenSSH 传输，没有修改 cc-connect 源码或全局安装。
- 新增 `cc_connect_handoff_preflight`，在释放原 PTY 前验证消息平台上下文、SSH 配置/凭据/远端目录和 Codex app-server。SSH 托管会话数据使用本地占位目录，真实 POSIX 路径仅作为远端 transport 元数据。
- Codex Proxy 复用结构化 SSH Config、Agent、私钥、已保存密码、跳板机、HTTP/SOCKS5/ProxyCommand 和自定义 Config；远端注入项目环境、有效 `CODEX_HOME` 与登记目录的 Git 信任配置，序列化环境不包含密码。
- Proxy 将远端 app-server 的任务开始、审批、完成和失败事件转入现有托管 Hook 通知链，Telegram、飞书、微信和企业微信共用同一实现，不要求远端安装 Hook。
- 取消托管通过现有 SSH PTY 解析器在原 Host/路径恢复同一 `cliSessionId`；SSH 项目或路径发生漂移时进入可见的恢复失败状态。SSH Worktree、WSL、`password_prompt` 和 `interactive` 首版明确拒绝。
- GitNexus CLI 因 npx 包缺少 `tree-sitter-kotlin` 失败；已降级刷新 codebase-memory moderate 索引并结合 SSH/PTY/Hook 契约、源码和测试完成影响复核。资格判断与 cc-connect/Proxy 启动链风险为 HIGH/CRITICAL。

## 验证结果

- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过。
- `cargo check --locked --manifest-path src-tauri/Cargo.toml`：通过。
- `cargo test --locked --manifest-path src-tauri/Cargo.toml`：本功能相关测试全部通过；全量结果为 744 项通过、1 项忽略、1 项失败。唯一失败为未修改的既有 `commands::hook_settings::tests::install_then_uninstall_pi_extension`，单独执行可稳定复现，与 SSH/cc-connect/Proxy 调用链无关。
- `cargo test --locked --manifest-path src-tauri/Cargo.toml codex_app_server_proxy::tests --lib`：13 项通过。
- `cargo test --locked --manifest-path src-tauri/Cargo.toml commands::cc_connect:: --lib`：57 项通过，包含跳板 Host 缺失时禁止退化为直连的回归测试。
- `node scripts/remoteHandoff.test.mjs`：4 项通过，覆盖 SSH 无 Hook 空闲候选、已知运行态拒绝、Host/认证/Worktree 拒绝、WSL 拒绝及本地兼容。
- `npm run test:codex-proxy:e2e`：4 项通过。
- `.\\node_modules\\.bin\\tsc.cmd --noEmit`：通过。
- `npm run build`：通过，Vite 完成 6696 个模块转换。
- `git diff --check`：通过，仅有仓库现有 Windows 行尾提示。

## 未覆盖与发布边界

- 已使用真实 SSH 主机验证已保存密码链路、远端目录及 Codex app-server 启动；尚未执行真实手机消息 -> 远端 Codex -> 取消后本地恢复的端到端冒烟，安装包测试仍应覆盖 Agent、私钥、跳板/代理和 Host Key 异常。
- 未启动 Tauri 窗口手动切换中英文；新增文案已由 TypeScript 完整键约束和生产构建覆盖。
- `npm run tauri:build:local -- --bundles nsis`：通过，仅构建 NSIS；产物为 `src-tauri/target/release/bundle/nsis/CLI-Manager_1.3.1_x64-setup.exe`。本次未复制安装包、未停止用户服务、未 push。

---

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

## 桌面宠物首版验证（2026-07-16）

- 已从最新主分支创建并在 feat/Desktop-pets 开发，功能提交为 feat: add downloadable desktop pets。
- 新增独立透明桌宠窗口、设置入口、双击会话跳转、后台 daemon 状态聚合、位置恢复、置顶、尺寸、状态气泡、全屏隐藏和位置锁定。
- 新增公开宠物中心、远端/缓存/随包三级目录降级、下载与 SHA-256 校验、更新、切换、卸载和本地 .clipet 导入。
- 三只首版宠物包及预览已随应用提供；Rust 测试校验目录哈希与实际内嵌包完全一致。
- 宠物包限制为 manifest.json、PNG、WebP 和安全 SVG；路径穿越、符号链接、HTML、JavaScript、可执行文件、危险 SVG、超大压缩包和解压膨胀均会被拒绝。
- 已安装宠物固定保存到 ~/.cli-manager/pets，不使用版本化 Tauri 数据目录，覆盖安装或重新安装应用不会主动清理。
- npx tsc --noEmit：通过。
- npm run build：通过，Vite 完成 6617 个模块转换；仅保留既有的大 chunk 警告。
- cargo check：通过。
- cargo test desktop_pet --lib：5 项通过、0 项失败。
- rustfmt --check src/commands/desktop_pet.rs --edition 2021：通过。
- 全量 cargo fmt --check 被本次拉取的上游文件 git_worktree.rs、daemon/server.rs、lib.rs 既有格式差异阻断；未为了本功能改写这些无关上游文件。
- 已拉取并合并 origin/master 的 2402c72，同时保留上游 cc-connect 设置与本次桌宠设置入口。
- 尚未启动 Tauri 窗口手动检查透明背景、拖动位置和中英文切换；本次未打包安装包。

## 桌面宠物启动修复验证（2026-07-17）

### 根因与修复范围

- 主程序启动失败位于 React StrictMode 生命周期与 Tauri Store 插件边界：不可取消的初始化会在 StrictMode 探测阶段重复启动，多个 Store 又并发读取，导致真实用户数据下启动 I/O 竞争并卡在初始化页。
- 设置、会话和同步 Store 的 load() 已增加 single-flight 合并；基础启动改为设置、会话、同步、项目串行完成后再开放首屏、请求日志同步、桌宠协调器和延迟任务。
- 桌宠透明空窗位于运行时 WebView 创建与前端入口路由边界，不是宠物 CSS 或素材问题；改为由 Tauri 配置预创建隐藏的 desktop-pet WebView，并使用原生窗口 label 选择桌宠入口。
- 桌宠位置只在用户开始拖拽后持久化；程序自动放置到右下角不会把默认位置误写成固定坐标。

### 验证结果

- npm run build：通过，Vite 完成 6618 个模块转换；仅有既有的大 chunk 警告。
- cargo check：通过。
- cargo test desktop_pet：5 项通过、0 项失败。
- npm run tauri build -- --no-bundle：通过，生成 src-tauri/target/release/cli-manager.exe。
- 使用真实数据目录冷启动最终 release：设置阶段 18.3 ms、Store 阶段 371.4 ms、项目阶段 18.8 ms，均未超时；首屏约 495.4 ms。
- 最终 release 同时存在可响应的主窗口和 190x210 透明桌宠窗口；使用 Windows PrintWindow 抓取窗口本体，确认状态气泡与宠物像素均已绘制。
- 旧动态窗口对照测试在 PrintWindow 中为全透明，静态窗口方案在相同方式下正常渲染。
- 自动放置后 desktopPet.position 保持 null；测试结束后用户设置已恢复到测试前 SHA-256 F18933890B0FA134857E70637D5538F5F219C817DA29F157765276B0FF047112。
- git diff --check：通过，仅输出工作区既有的 LF/CRLF 转换提示。
- 已刷新 codebase-memory 索引并执行变更影响检测；变更限定在启动编排、三个 Store 加载、桌宠协调/入口/窗口配置和本验证记录。

## Codex Pets 兼容验证（2026-07-17）

- 保留 `.clipet` 导入、在线目录、更新和卸载链路，同时新增 `pet.json + spritesheet.webp` 的 Codex Pets ZIP 解析。
- V1：支持省略 `spriteVersionNumber` 的 1536×1872、9 行精灵图。
- V2：支持 `spriteVersionNumber: 2` 的 1536×2288、11 行精灵图；已核对用户提供的 `shinobu-q.codex-pet.zip` 为 VP8L V2 文件头。
- 启动设置页与“重新扫描”都会读取宿主机 `~/.codex/pets`；外部宠物标为只读，不允许 CLI-Manager 删除。
- 手动导入的 `.codex-pet.zip` 安装到 `~/.cli-manager/pets/installed`，同 ID 同时存在时自管副本优先，卸载后可回退到外部副本。
- ZIP 安全边界继续覆盖路径穿越、符号链接、未知文件、条目/压缩包/解压体积上限；Codex WebP 另外校验 20 MiB 上限和 V1/V2 精确尺寸。
- `cargo test desktop_pet --lib`：9 项通过、0 项失败。
- `.\\node_modules\\.bin\\tsc.cmd --noEmit`：通过。
- `npm run build`：通过，Vite 完成 6620 个模块转换；仅有既有的大 chunk 警告。
- `npm run lint`：项目未定义 lint script，无法执行。
- 本次未生成安装包；等待用户明确要求打包后再执行。

## 桌宠状态与多任务菜单修复验证（2026-07-17）

### 根因与触点

- 根因位于桌宠状态聚合边界：daemon 已保存打开会话的最新 Hook 任务状态，但 deriveDesktopPetSnapshot 对所有已打开会话直接跳过 daemon 数据，只读取前端瞬时状态；前端状态缺失时因此错误显示“空闲”。
- 右键菜单的数据契约只携带单个优先目标，且菜单固定在 190×210 窗口底部，无法表达多个会话，扩展后也会被透明窗口边界裁切。
- 已修改：src/lib/desktopPet.ts（状态合并、完整目标列表）、src/hooks/useDesktopPetCoordinator.ts（中英文菜单标签）、src/desktop-pet/DesktopPetApp.tsx（目标选择与事件发送）、src/desktop-pet/desktopPet.css（全窗口菜单、滚动与省略）、src/lib/i18n.ts（中英文文案）。
- 已确认复用且未修改：App.tsx 的 handleActivateHookNotificationTarget，继续负责关闭历史视图、切换项目/Worktree scope、激活对应 Workspan/分屏会话并恢复/聚焦主窗口。
- 已确认无须修改：terminalStore Hook/Shell 状态机、Rust daemon Hook 状态生产、PTY 生命周期和桌宠原生窗口尺寸；本次只修复桌宠消费与展示层的丢失契约。

### 验证结果

- 纯逻辑场景验证通过：打开会话的前端状态缺失时采用较新的 daemon running；较新的前端 done 不被旧 daemon 状态覆盖；daemon-only 会话仍进入目标列表；多目标按既有优先级选择主状态。
- .\node_modules\.bin\tsc.cmd --noEmit：通过。
- npm run build：通过，Vite 完成 6620 个模块转换；仅有既有的大 chunk 警告。
- 190×210 固定窗口样式验证：8 个任务时菜单完整落在窗口内，任务区出现纵向滚动，项目名、会话名、状态和“当前”标记可见，底部三个操作按钮不被裁切。
- 本次未打包；尚需在真实 Tauri 窗口手动覆盖同 Workspan、跨 Workspan、分屏深层会话、主窗口最小化/托盘及中英文切换。

## cc-connect 微信扫码授权增量验证（2026-07-18）

- 设置页微信平台新增“微信扫码授权”真实入口；点击后调用已校验的 cc-connect v1.4.1 原生 `weixin setup`，没有实现替代协议，也未修改 cc-connect 源码或全局安装。
- 原生进程将二维码写入 CLI-Manager 专用临时目录；后端校验 PNG 签名与 2 MiB 上限后通过 Base64 IPC 返回，前端在固定 264×264 弹窗中展示并每 800 ms 轮询刷新。
- 手机确认后，后端从临时 TOML 结构化读取 Token 与 `@im.wechat` 用户 ID，将已有显式允许用户去重合并，复用 profile 事务把 Token 写入 Windows 凭据管理器并重新生成仅含环境变量占位符的托管 TOML。
- 原始 Token 不经过 WebView/IPC；成功、失败、取消、设置页卸载、应用退出以及下次应用启动均会清理临时配置、二维码和输出文件。
- 同一时间只允许一个扫码授权进程；受管 cc-connect 运行或启动中时拒绝授权。Windows Job Object 与显式取消共同保证页面关闭和应用退出后不遗留子进程。
- 授权继承远程连接的代理开关与手动/7890/10808 自动代理解析；代理关闭时继续清理继承代理环境。
- 场景检查覆盖：未保存的新微信配置、已有允许用户重新授权、二维码生成中/等待确认/自动刷新、成功导入、原生进程失败、用户取消、设置页关闭、应用退出、代理开/关、cc-connect 运行中和重复点击。窗口焦点、分屏、Worktree 与 hook 状态不参与该独立设置流程。
- `cargo check` 通过。
- 指定本机 cc-connect v1.4.1 执行 `cargo test commands::cc_connect::tests --lib` 通过：30 项通过、0 项失败；真实 `config format` 同时验证普通四平台配置和扫码授权临时配置。
- `.\\node_modules\\.bin\\tsc.cmd --noEmit` 通过。
- `npm run build` 通过：Vite 完成 6621 个模块转换；仅保留既有的大 chunk 警告。
- 尚未使用真实微信账号扫描二维码，避免未经确认操作外部账号；本次未打包、未 push。

## cc-connect 远程 Codex app-server Provider 兼容修复（2026-07-18）

### 根因与发现清单

- 根因位于 CLI-Manager Provider 包装器与 Codex app-server 的进程参数边界：包装器无条件执行 `codex --profile <项目 Provider> app-server`，而本机 Codex CLI 0.144.5 明确拒绝 app-server 使用 `--profile`，进程立即退出，cc-connect 因此只得到 `initialize: EOF`。
- 运行日志证明微信授权链路正常完成 `ilink ready-for-poll`、`platform ready`、`message received`；失败发生在消息进入 Codex 子进程后的 0.3~1 秒内，与微信 Token、允许用户和项目路径无关。
- 已修改 `cc_connect.rs`：Provider 包装器、命令字符校验、真实包装器启动预检、Provider 密钥环境注入及对应测试。
- 已修改 `ccswitch.rs`：仅将已解析的 base URL、model 与 wire API 以 crate 内只读字段提供给远程启动链路，不改变 Provider 解析、数据库或本地终端启动行为。
- 已确认无需修改：cc-connect 源码/安装、微信扫码授权、四个平台协议配置、项目切换命令、Windows 凭据存储、Git safe.directory 和代理继承。

### 修复与场景覆盖

- app-server 不再使用 `--profile`；包装器改用 Codex CLI 支持的全局 `-c` 覆盖固定的 `cli_manager_remote` Provider，强制传入项目登记的 base URL、env key、wire API 和可选 model。
- Provider 密钥仍只注入 cc-connect/Codex 子进程环境，不进入包装脚本、托管 TOML、日志或错误消息；包装器动态值拒绝控制字符及 Windows cmd 注入字符。
- 启动 cc-connect 前使用同一包装器和同一 Provider 环境实际启动 `app-server --listen stdio://`，关闭探测 stdin 后校验退出码；不兼容时在设置启动阶段返回已脱敏的原始 stderr。
- 平台场景：微信、Telegram、飞书、企业微信共用同一 Agent 启动链路；修复不依赖平台协议。
- Provider 场景：项目显式 Provider、全局回退 Provider、带/不带 model、默认 responses wire API、切换项目后重启均使用当次数据库解析结果；无 Provider 的既有行为保持不变。
- 会话场景：首次会话与恢复会话都由 cc-connect 启动同一 app-server；YOLO、代理、窗口焦点、分屏、Worktree 和 hook 状态不改变 Provider 参数生成。

### 验证结果

- 已用本机 Codex CLI 0.144.5 复现旧命令的明确错误：`--profile only applies to runtime commands ...`。
- 已用同版本 Codex 验证等价的 `-c ... app-server --listen stdio://` 配置可正常启动并在 stdin 关闭后以 0 退出。
- `cargo check`：通过。
- `cargo test commands::cc_connect::tests --lib`：32 项通过、0 项失败，覆盖包装器参数顺序、无 model 分支、命令注入字符拒绝、启动错误与密钥脱敏。
- `cargo test commands::ccswitch::tests --lib`：33 项通过、0 项失败。
- `.\\node_modules\\.bin\\tsc.cmd --noEmit`：通过。
- `npm run build`：通过，Vite 完成 6621 个模块转换；仅保留既有的大 chunk 警告。
- `rustfmt --check --edition 2021 src/commands/cc_connect.rs src/commands/ccswitch.rs` 与 `git diff --check`：通过。
- 尚未操作真实 Provider 发起模型请求，避免未经确认消耗外部账号额度；本次未打包、未 push。

## Codex 会话远程托管验证（2026-07-19）

### 功能与边界

- 后端定向测试覆盖托管标识校验、通知身份字段、cc-connect 会话注入/清理、复用 ID 拒绝、Windows 项目哈希和四平台会话选择。
- 前端候选会话只接受本地 Codex、有效 `cliSessionId`、登记项目与可信停止状态；托管锁会阻止关闭 Tab 和取消分屏，恢复失败会保留可重试蒙层。
- 已确认 Telegram、飞书、微信、企业微信配置和授权入口在上游合并后仍存在；没有修改 cc-connect 源码。
- 上游终端架构合并后，托管暂停/恢复已接入 `TerminalProcessManager`，源码扫描确认不存在旧 `pty_create`、`pty_close`、`pty_write` 或 PTY status event 监听残留。

### 自动验证

- `cargo test commands::cc_connect --lib`：38 项通过、0 项失败，覆盖 6 项托管测试以及微信/企业微信、Provider、代理、项目切换和可执行文件检测回归。
- `cargo test commands::ccswitch --lib`：33 项通过、0 项失败。
- `cargo check`：通过。
- `.\node_modules\.bin\tsc.cmd --noEmit`：通过。
- `npm run build`：通过，Vite 完成 6642 个模块转换；仅有既有的大 chunk 警告。
- `node scripts/terminalProcessManager.test.mjs`：2 项通过。
- `node scripts/ptyHostSocket.test.mjs`：7 项通过。
- `node scripts/terminalReplay.test.mjs`：8 项通过。
- `node scripts/fileExplorerIgnore.test.mjs`：9 项通过。
- `git diff --check`：通过，仅有工作区既有的 LF/CRLF 转换提示。

### 界面与入口回归

- 通过浏览器 Tauri mock 验证中文桌宠纵向菜单、四会话向左扇形卡片、仅显示可托管会话的选择模式、活动托管锁标识及“暂停并取消托管”操作；长项目/会话名未与相邻控件重叠。
- 点击桌宠候选卡片实际发出 `remote-handoff-start-request`，payload 为所选 `sessionId`；终端蒙层按钮实际发出 `remote-handoff-cancel-request`，确认不是无调用方的静态 UI。
- 中文活动托管蒙层在 900×600 下无溢出；480×300 短 Pane 可滚动到底并完整显示取消按钮。
- 英文 `recovery_failed` 蒙层正确显示恢复说明、长项目/工作目录/Provider 和“Retry Local Resume”，无控件重叠。
- 上述桌宠与蒙层场景浏览器控制台均无 error/warn。

### 未执行

- 未通过真实 Telegram、飞书、微信或企业微信账号发送托管/取消通知；该操作会重启当前受管 cc-connect 并影响真实外部账号，需要单独的账号级冒烟确认。
- 本次未生成安装包，也未 push。

## 多平台托管与紧凑宠物菜单验证（2026-07-19）

### 自动验证

- cargo test commands::cc_connect：40 项通过、0 项失败，新增旧 profile 迁移和多平台 TOML 测试。
- 设置 CLI_MANAGER_TEST_CC_CONNECT 指向本机官方 cc-connect v1.4.1 后，真实 config fmt 检查通过四平台同时启用的托管配置。
- cargo check、TypeScript noEmit 与 npm run build 均通过；Vite 完成 6642 个模块转换，仅保留既有的大 chunk 警告。
- git diff --check 通过，仅输出仓库既有的 LF/CRLF 转换提示。

### 界面与边界

- 临时静态渲染截图验证 156 px 纵向操作区、四个平台毛玻璃列表和 440 px 完整面板预算；平台卡片、状态、副标题和宠物锚点没有重叠，截图保留在 src-tauri/target/pet-menu-preview.png。
- 平台不可用状态覆盖远程连接停止、凭据缺失、允许用户缺失、飞书无历史聊天和微信无上下文令牌；托管开始时后端再次校验，避免菜单快照过期导致错误接管。
- 旧 profile.json 只自动启用原 current platform，其他平台凭据继续保留在 Windows Credential Manager；用户首次启用其他平台时需要补充该平台 allowFrom。

### 未执行

- 未启动或停止用户当前安装目录中的 CLI-Manager/cc-connect，也未向真实机器人发送消息。
- 本次尚未生成 NSIS 安装包，也未 push。

## 跨平台远程托管 Hook 通知验证（2026-07-19）

### 功能与场景

- 托管启动时仅向受管 cc-connect 进程注入 daemon Hook 地址、令牌和本地会话 ID；无托管记录时显式移除这些内部变量，避免普通远程连接串到旧会话。
- daemon 独立维护任务状态和周期计时：UserPromptSubmit 开始监控，PermissionRequest 立即提醒，Stop/StopFailure 结束监控，缺少结束事件时按基础超时与用户提醒间隔进行状态未知提醒。
- Telegram、飞书/Lark、微信和企业微信共用 handoff.json 中固化的 platformSessionKey 与 cc-connect send；只通知当前托管平台，不广播到其他已配置平台。
- 事件必须同时匹配 source、localSessionId 和可用时的 cliSessionId；取消托管或切换平台会使旧投递任务在发送前失效。
- 最小化、托盘和前端重连不参与调度；daemon Hook 缓存回放只恢复界面状态，不会重复远程发送。
- Hook 未安装或 daemon 不可达时不会猜测任务运行状态；权限通知只提醒，实际批准/拒绝仍由 cc-connect 原机器人会话处理。

### 自动验证

- cargo test --lib：518 项通过、0 项失败、1 项按环境要求忽略。
- cargo test commands::cc_connect --lib：45 项通过，覆盖四平台文案、会话双 ID 归属、权限去重、设置默认值/区间和 Hook 环境。
- cargo test daemon::server --lib：10 项通过，Hook 状态、缓存、WebSocket 与 PTY daemon 回归通过。
- .\node_modules\.bin\tsc.cmd --noEmit：通过。
- npm run build：通过，Vite 完成 6642 个模块转换；仅保留既有的大 chunk 警告。
- git diff --check：通过，仅输出仓库既有的 LF/CRLF 转换提示。
- codebase-memory-mcp 已按最新工作区重建 moderate 索引并完成变更影响扫描。

### 未执行

- 未向真实 Telegram、飞书、微信或企业微信账号发送测试消息，避免影响用户当前机器人和外部账号。
- 未启动、停止或替换用户安装目录中的 CLI-Manager/cc-connect；本次未生成安装包，也未 push。

## 大型 Codex 会话远程恢复修复验证（2026-07-19）

### 根因与触点

- 根因位于 Codex app-server 到 cc-connect 的 JSONL 传输边界：原 Session ID 和 rollout 均正常，Codex 已恢复完整上下文，但单行 `thread/resume` 回复为 10,566,391 字节，超过 cc-connect 约 10 MB 的读取上限；随后 cc-connect 回退执行 `thread/start`，产生漂移 Session ID。
- 新增 `codex_app_server_proxy.rs`，完整接收大回复后仅转发 cc-connect 实际消费的线程 ID、目录、模型与推理强度；代理不修改 Codex 内部已加载的历史上下文。
- `cc_connect.rs` 只让包装器的 `app-server` 模式经过代理，并从 `handoff.json` 注入预期原 Session ID；其他 Codex 命令保持原行为。
- `handoff_session.rs` 的异常取消只接受当前原 ID，或身份历史明确包含原 ID 的后继线程；没有增加删除 Codex Session/rollout 的代码。
- 已确认无需修改 cc-connect 源码/安装、平台协议、Provider 配置、本地 Codex 恢复、前端入口和两个 Codex rollout 文件。

### 自动与真实链路验证

- `cargo test --lib`：561 项通过、0 项失败、1 项忽略。
- `npm run build`：通过，Vite 完成 6668 个模块转换；仅保留既有的大 chunk 警告。
- Rust 格式检查：通过。
- 真实恢复原 Session `019f5e8b-2d11-76d1-89b4-a0c0ff20d111`：Codex 原始回复 10,566,391 字节，代理转交 176 字节，Session ID 保持原值，cwd/model/reasoning effort 正确。
- codebase-memory 已用 moderate 模式刷新并完成变更影响检测；GitNexus MCP 未暴露，已用源码、`rg`、Git diff、测试和真实协议恢复结果补充复核。

### 发布产物

- NSIS：`src-tauri/target/release/bundle/nsis/CLI-Manager_1.2.10_x64-setup.exe`，SHA-256 `084E582847D63E0BE8F789B08120DFFDDC2C976BFC90EAE1546DE418E54C1C96`。
- MSI：`src-tauri/target/release/bundle/msi/CLI-Manager_1.2.10_x64_en-US.msi`，SHA-256 `86A5756BB49D2793E21746B1D2F231BDBB9C1410F559DCDE3B8FF7D24EC8DB0F`。
- Release EXE：SHA-256 `7F63FC46432115F1616B8B18D8083E5B89F13E41EE2382A79230DD6236A5C695`。
- 当前异常托管在最终回复前继续运行；已要求延迟停止 cc-connect、移除 `s3` 和 handoff 记录，同时保留原 Session `019f5e8b-2d11-76d1-89b4-a0c0ff20d111` 与漂移 Session `019f7a9b-01c1-75e3-aa9c-0e59ca43a7ef` 的全部 Codex 文件。

## 远程单轮任务时限可视化配置（2026-07-20）

### 功能与兼容性

- “设置 -> 远程连接”新增“单轮任务时间上限”分钟输入框，允许 `0~1440`；`0` 按 cc-connect v1.4.1 官方配置语义表示禁用绝对时限。
- 保存后写入受管 `config.toml` 的顶层 `max_turn_time_mins`，Telegram、飞书、微信和企业微信共用该值；cc-connect 正在运行时沿用既有事务自动重启并生效。
- 旧 `profile.json` 缺少字段时保持 CLI-Manager 原有的 15 分钟默认值，避免升级后行为突变；后端拒绝超过 1440 分钟的请求。
- 新增中文、英文设置文案，英文继续使用 24 小时时间格式的全局规则。

### 验证

- `rustfmt --check --edition 2021 src\commands\cc_connect.rs`：通过。
- `.\node_modules\.bin\tsc.cmd --noEmit`：通过。
- `cargo test commands::cc_connect --lib`：49 项通过、0 项失败，覆盖旧配置默认值、`0/1440` 边界和 `1441` 拒绝路径。
- `cargo test --lib`：562 项通过、0 项失败、1 项按环境要求忽略。
- `npm run build`：通过，Vite 完成 6668 个模块转换；仅保留既有的大 chunk 警告。
- 设置 `CLI_MANAGER_TEST_CC_CONNECT` 指向本机 cc-connect v1.4.1 后，受管配置通过真实 `config format` 校验；官方 `config example` 同时确认 `0` 表示禁用时限。
- 未启动或停止用户安装目录中的 CLI-Manager/cc-connect，未向真实机器人发送消息；本次未生成安装包，也未 push。

## WSL 桌面宠物内存增长根因修复（2026-07-20）

### 根因陈述与发现清单

- 根因位于 PTY 活动状态跨窗口传输与桌宠 WebView 渲染边界：WSL 持续输出会每秒刷新 `ptyOutputActivityAt`，旧协调器随每次快照变化重复跨窗口发送并重建事件监听；桌宠同时以隐藏探测图和 `background-position` 精灵动画持续解码/绘制透明 WebView，长期运行会放大 IPC 队列、React 重渲染和 WebView2/GPU 资源占用。
- 已修改 `useDesktopPetCoordinator`：配置与快照按可见语义去重、单飞发送并合并最新状态，READY 才强制重发；事件监听改为稳定注册；相同 daemon 轮询结果复用旧数组；桌宠不可见时停止 daemon 轮询，并用一次性 TTL 刷新保证输出停止后从 working 正确回落。
- 已修改 `desktopPet.ts` / `desktopPetTransport.ts`：快照推导支持显式时钟；working 状态的纯时间戳变化不再触发跨窗口投递，成功状态时间戳、目标顺序、状态、托管信息等可见变化仍会投递。
- 已修改 `DesktopPetApp` / `desktopPet.css`：桌宠禁用、自动全屏隐藏、原生窗口隐藏或 document 不可见时暂停动画；隐藏操作先本地停画，避免等待 IPC 回环。
- 已修改 `PetArtwork`：Codex Pets 精灵由双重的 probe 图片 + CSS background 改为单一 `<img>` 与 GPU transform 分帧；测量 canvas 用后释放 backing store，内容边界缓存限制为 128 条。
- 已修改 `desktop_pet.rs`：image-v1 资源增加单文件、SVG、4096 单边和 16MP 解码尺寸上限，阻止小压缩包携带超大解码位图；PNG/WebP 头与尺寸异常会在安装/读取阶段拒绝。
- 已确认无需修改：PTY 输出生产与每秒节流、TerminalStore 会话清理、桌宠原生窗口尺寸、cc-connect 源码/平台协议、远程托管菜单与取消流程。

### 场景覆盖

- 运行环境：本地 PowerShell/CMD/Pwsh、WSL/Bash 均走同一 PTY 活动去重链路；本机无 WSL，自动验证以持续更新时间戳模拟 WSL 高频状态。
- 可见性：正常显示、主应用失焦、桌宠原生隐藏、设置禁用、终端全屏自动隐藏时均有明确发送/动画策略；重新显示通过配置变更或 READY 强制同步最新状态。
- 会话：单会话、多会话、daemon-only、目标排序变化、attention/failed/done/success、working TTL 到期与远程托管状态都保留可见更新；success 的 3.5 秒展示时间戳未被去重。
- 宠物格式：内置 SVG 猫、image-v1 PNG/WebP/SVG、Codex Pets V1/V2 精灵均保持入口；托管菜单、扇形会话卡片和打开主窗口调用链未改动。
- 包来源：`%USERPROFILE%\.codex\pets` 外部只读包继续扫描；自行导入的 CLI-Manager 包在安装和后续读取时应用新增资源上限。

### 验证结果

- `.\node_modules\.bin\tsc.cmd --noEmit`：通过。
- `node scripts/desktopPetTransport.test.mjs`：4 项通过，覆盖 working 时间戳去重、可见状态变化、success 时间戳和 daemon 数组复用。
- `cargo test --manifest-path src-tauri/Cargo.toml desktop_pet`：11 项通过，覆盖 PNG 尺寸解析、4096 边界、超限像素及无效 PNG/WebP。
- `cargo check --manifest-path src-tauri/Cargo.toml`：通过。
- `npm run build`：通过，Vite 完成 6672 个模块转换。
- 使用本机 `shinobu-q` 1536×2288 Codex Pets V2 资源执行同源浏览器视觉验证：working 第 7 行、6 帧 transform 动画裁剪、内容边界测量与自适应缩放正确。
- `git diff --check`：通过，仅有仓库既有 LF/CRLF 转换提示。
- GitNexus CLI 基线仍因本机缺少 `tree-sitter-kotlin` 且无可用索引而不可执行；已降级用 codebase-memory moderate 重建索引、调用链追踪、源码/rg/Git diff 与实际构建测试复核。高风险触点为 App 桌宠协调主流程、DesktopPetApp 渲染入口及宠物包安装/读取链路。

### 限制与后续验证

- 本机没有 WSL，无法原样复现用户报告的 10GB 峰值；本次修复切断了已定位的持续 IPC/渲染放大链并为资源解码建立上界，但发布前仍建议在反馈环境执行至少 2 小时 WSL 持续输出 soak test，分别记录桌宠 renderer、主 renderer 和 GPU 进程的 Private Working Set。
- 本次未生成安装包、未启动或停止用户安装目录中的 CLI-Manager/cc-connect，也未 push。

## 停止远程托管后重复 Resume 参数修复（2026-07-20）

### 根因陈述与发现清单

- 根因位于“项目持久化 CLI 参数 → 公共会话恢复命令”的数据边界：保存到侧栏的项目会把旧 Session 的 `resume` 片段写入 `cli_args`，而远程托管取消、工作区恢复和历史恢复又为目标 Session 构造新的 resume 命令；旧实现无条件继承 `cli_args`，因此一条命令中出现两个 Session ID。
- 新增共享 `stripResumeCliArgs`，在 fresh resume 链路继承项目参数前移除 Codex/Claude 已有的 `resume <id>`、`resume --no-alt-screen <id>`、`resume --last`、`--resume <id>` 和 `--continue`，保留模型、沙箱、Provider 等普通参数。
- `appendResumeCliArgs` 已接入共享清理，覆盖远程托管取消后的本地恢复、工作区恢复和历史会话恢复；`buildResumeCliArgs` 复用同一规则，避免重新保存侧栏会话时规则漂移。
- 已确认无需修改：`terminalStore.resumeSessionFromRemoteHandoff`、`buildCliResumeStartupCommand`、`HistoryWorkspace` 调用入口、`resolveProjectStartupCommand` 的正常侧栏启动行为、Rust 托管后端、cc-connect 源码与平台协议。
- GitNexus 工具在当前会话未暴露；已降级使用 codebase-memory 调用链追踪、契约、`rg`、源码和 Git diff。公共 `appendResumeCliArgs` 的影响分析为 CRITICAL，直接覆盖历史恢复和终端恢复主流程。

### 场景覆盖

- 多会话/不同 Session ID：新目标 ID 保留且只出现一次，项目中旧 ID 被移除；Provider profile 只追加一次。
- 项目来源：普通项目参数、保存到侧栏的项目、重复保存的项目、Worktree 继承参数均走同一清理规则。
- CLI/环境：Codex 与 Claude 均覆盖；PowerShell/CMD/Pwsh、WSL/Bash 的 shell 包装位于此纯参数处理之外，不改变去重结果。
- 窗口焦点、分屏、最小化/托盘和 Hook 安装状态不参与命令构造，确认与本问题无关。

### 验证结果

- `node scripts/resumeCliArgs.test.mjs`：4 项通过，包含用户此次精确的 `fresh resume + cli_args 中旧 resume` 场景、两种 Codex 格式、Claude resume/continue、普通参数保留和 Provider 单次追加。
- `.\node_modules\.bin\tsc.cmd --noEmit`：通过。
- `npm run build`：通过，Vite 完成 6673 个模块转换。
- `git diff --check`：通过，仅输出仓库既有的 LF/CRLF 转换提示。
- 本次未生成安装包，未启动/停止用户安装目录中的 CLI-Manager 或 cc-connect，也未 push。

## 桌宠悬停菜单、尺寸调节与右键漂移修复（2026-07-20）

### 根因陈述与发现清单

- 漂移根因位于桌宠原生窗口移动事件与前端拖动状态的边界：菜单展开/收起通过 SetWindowPos 改变窗口坐标并触发 onMoved，旧拖动标记尚未清理时会把展开窗口左上角误持久化为宠物位置；修复在程序化窗口调整入口终止拖动跟踪并过滤预期移动事件，而不是在位置回显处兜底。
- 已修改 DesktopPetApp / desktopPet.css：宠物悬停 200ms 展开菜单、离开 350ms 延迟收起，保留右键备用入口；菜单内加入 40%～150%、5% 步进的尺寸滑条，并在拖出窗口时保持指针捕获和正确提交。
- 已修改 desktopPetMenu：实时缩放以折叠宠物窗口的底部中心为锚点，并约束在当前显示器工作区；异步菜单窗口任务继续只应用最新状态。
- 已修改 useDesktopPetCoordinator / desktopPet.ts：新增桌宠尺寸事件，尺寸与对应位置原子持久化；仅跳过桌宠已经应用的完全相同窗口配置，显示/隐藏或置顶状态并发变化仍会同步。
- 已修改 settingsStore / DesktopPetSettingsPage：尺寸设置改为数值百分比，并兼容迁移旧 small/medium/large 配置到 80%/100%/125%；设置页同步提供相同范围的滑条。
- 已修改 Rust 桌宠窗口尺寸边界：原生窗口最小缩放从 75% 放宽到 40%，最大值保持 150%；中英文文案同步更新。
- 已确认无需修改：宠物资源格式与下载/导入链路、状态推导、扇形会话卡片、远程托管协议、cc-connect 源码及平台适配。

### 场景覆盖

- 菜单交互：悬停打开、从宠物移动到菜单或会话卡片、离开延迟关闭、右键开关、Esc/设置变更关闭、滑条拖动期间离开窗口。
- 窗口状态：屏幕四角、负坐标副屏、100%/125%/150% DPI、程序化展开/收起、用户拖动、锁定位置和主应用失焦。
- 尺寸与兼容：40%、100%、150% 边界、5% 步进、旧三档配置迁移、菜单实时预览、设置页持久化和重启回显。
- 会话状态：无会话、单会话、多会话、远程托管平台/会话二级菜单均复用同一悬停窗口状态机；PTY、WSL、Worktree 和 Hook 数据链路未改变。

### 验证结果

- .\node_modules\.bin\tsc.cmd --noEmit：通过。
- node scripts\desktopPetSize.test.mjs：3 项通过，覆盖旧配置迁移、范围/步进归一化及原生缩放换算。
- node scripts\desktopPetMenuGeometry.test.mjs：11 项通过，覆盖多 DPI 四角定位、负坐标副屏、尺寸锚点和异步菜单竞态。
- cargo test --manifest-path src-tauri\Cargo.toml desktop_pet_window：2 项通过，覆盖 40%～150% 原生窗口边界及非法尺寸。
- cargo check --manifest-path src-tauri\Cargo.toml：通过。
- rustfmt --edition 2021 --check src-tauri\src\commands\desktop_pet.rs：通过；全仓 cargo fmt -- --check 仍受本分支既有的其他 Rust 文件格式差异影响。
- npm run build：通过，Vite 完成 6675 个模块转换。
- git diff --check：通过，仅输出仓库既有的 LF/CRLF 转换提示。
- GitNexus CLI 仍因本机缺少 tree-sitter-kotlin 无法执行；已降级为 codebase-memory moderate 重建索引、变更影响检测、rg、源码、Git diff 和构建测试复核。
- 本次未生成安装包，未启动/停止用户安装目录中的 CLI-Manager 或 cc-connect，也未 push。

## PR #160 审查意见修复与 V1.3.1 打包（2026-07-20）

### 根因陈述与发现清单

- 最终通知丢失的根因位于远程 Hook 事件状态机：超时提醒被错误建模为 Terminal，真实 Stop/StopFailure 因而被去重；修复将超时改为一次性“状态未知”提醒，仅真实完成/失败进入终态。
- 取消后旧通知的根因位于 handoff 持久化身份与 cc-connect 发送重试边界：旧实现仅在进入 worker 时校验一次；修复将发送拆为单次尝试，并在每次尝试前校验本地 Session、CLI Session、平台、平台会话标识和 startedAt。
- 凭据风险位于外部进程 stdout/stderr 到状态文件的持久化边界：旧清理仅去换行和截断；修复复用日志脱敏并收集平台凭据、Provider API Key、daemon Token 与敏感环境变量，状态文件只允许安全错误码，旧的不安全字段读取时会被替换。
- Resume 重复的根因位于项目 CLI 参数到 fresh resume 命令的解析边界：旧逻辑假设 Session ID 紧跟子命令；修复按 Codex CLI 的带值选项、无值选项、选择参数和位置参数解析，删除旧 Session/Prompt 并保留模型、沙箱和 Provider 配置。
- 已修改：cc-connect handoff 通知状态机与发送器、共享日志脱敏、Resume 参数清理与专项测试、npm/Cargo/Tauri 版本、CHANGELOG、PR CI。
- 已确认无需修改：cc-connect 源码、消息平台协议、托管记录 Schema、桌宠托管入口、终端锁定蒙层、SQLite Schema 和用户安装目录中的运行进程。

### 场景覆盖

- 超时后真实完成、超时后真实失败、重复终止事件、进度/权限提醒关闭或启用均保留明确状态。
- 通知首次成功、多次失败、重试期间取消、同一平台替换 handoff、切换平台/平台会话、记录读取失败均采用 fail-closed 校验。
- Telegram、飞书、微信、企业微信凭据，Provider API Key 和 daemon Token 均覆盖精确值与 token/secret/api_key/authorization/bearer 模式脱敏。
- Resume 覆盖 model、sandbox、config、profile、enable、all、include-non-interactive、no-alt-screen、旧 Session ID 与旧 Prompt 位于不同顺序。
- 本次行为与窗口焦点、分屏、最小化、WSL、Worktree 和 Hook 是否安装无额外分支；这些状态继续通过原托管入口提供同一 handoff 身份。

### 验证结果

- cargo check：通过。
- cargo test --lib：603 项通过、0 项失败、1 项因缺少指定 WSL 测试环境而忽略。
- 前端 TypeScript noEmit 检查：通过。
- resumeCliArgs.test.mjs：5 项通过。
- desktopPetTransport.test.mjs：4 项通过。
- desktopPetMenuGeometry.test.mjs：11 项通过。
- desktopPetSize.test.mjs：3 项通过。
- git diff --check：通过，仅有仓库既有 LF/CRLF 转换提示。
- GitNexus 索引因 tree-sitter-kotlin 安装失败而不可用，codebase-memory transport 同时关闭；已降级使用契约、rg、源码、Git diff、全量 Rust 测试和生产构建复核。
- 已同步并合并 origin/master 44f5695c，冲突仅为上游 1.3.0 与本分支 1.3.1 的五个版本字段，统一保留 1.3.1。
- 使用 tauri.local.conf.json 关闭 updater artifacts，仅构建 NSIS；产物为 src-tauri/target/release/bundle/nsis/CLI-Manager_1.3.1_x64-setup.exe，大小 19021755 字节，SHA-256 为 E13FCF061B1B2EFDB7FABBF63C6050F4F7781992DE23948C049F11FE0AE1A3B9。
- 未构建 MSI、未生成更新签名、未复制到 F:\cli-manager、未停止用户安装目录中的服务，也未 push。

## 桌宠菜单可配置与三卡滚动（2026-07-22）

### 功能与兼容性

- “设置 -> 桌面宠物 -> 显示与交互”新增“显示快捷操作菜单”和“悬停自动展开”两个开关；旧配置缺少字段时均默认开启，保持升级前行为。
- 快捷操作关闭后只保留任务卡片，窗口几何同步缩窄并把卡片贴近宠物，不留下原操作菜单占用的空白；没有任务时右键和悬停均不展开空窗口。
- 悬停自动展开关闭后仅右键可展开；双击当前会话、任务卡片点击、拖动、Esc 和离开窗口关闭逻辑保持不变。
- 普通任务与托管会话列表最多显示三张卡片，第四张起使用透明轨道、半透明绿色滑块的纵向滚动条；远程平台选择列表继续最多显示五项。
- 触点覆盖：settingsStore 默认值/迁移、桌宠设置真实入口、中英文文案、配置事件传输、DesktopPetApp 交互、窗口几何、卡片 CSS 和几何测试；Rust、PTY、Hook、远程托管协议及 cc-connect 均未修改。

### 验证

- 前端 TypeScript noEmit 检查：通过。
- desktopPetMenuGeometry.test.mjs：14 项通过，新增覆盖三卡高度上限、任务单栏缩窄、空菜单不扩窗和平台五项兼容。
- Node.js 22 环境下 npm run build：通过，Vite 完成 6678 个模块转换。
- git diff --check：通过，仅输出仓库既有的 LF/CRLF 转换提示。
- GitNexus CLI 本轮无法在时限内启动，已降级使用 codebase-memory、源码引用、rg、Git diff、几何测试和生产构建复核。
- 本次未生成安装包，未启动或停止用户安装目录中的 CLI-Manager，也未 push。

## PR #165 审查意见修复（2026-07-22）

### 根因与发现清单

- macOS Universal 缺失代理的根因位于 Tauri 打包前置脚本：Cargo 会把 `src/bin` 中的辅助程序作为各平台 bin 目标构建，但旧脚本只对 `cli-manager-daemon` 执行 `lipo`，新增 `cli-manager-codex-proxy` 后没有生成 Universal 产物。修复在统一辅助程序合并入口同时处理 daemon 和 proxy，并在任一架构产物缺失或 `lipo` 失败时给出具体二进制名称。
- 测试缺口位于单元测试与真实进程边界之间：原测试只能证明参数构造和文件复制，不能证明 GUI 子系统 proxy 能实际启动 CMD/EXE launcher、转发 JSONL、传递 Provider 环境和退出码。新增 Windows E2E 编译并启动真实 `cli-manager-codex-proxy.exe`，假 Codex 仅用于观测真实代理产生的子进程行为。
- 文档偏差位于“第三方 cc-connect 源码”和“CLI-Manager 内部 cc-connect 集成”的表述边界；CHANGELOG 与功能清单现明确前者未修改，后者包含代理准备、Provider 注入和启动环境调整。
- 已修改：`scripts/prepare-bundle-binaries.mjs`、新增 `scripts/codexAppServerProxy.e2e.test.mjs`、`package.json`、Windows release CI、CHANGELOG、功能清单与本验证记录。
- 已复核但未修改：`src-tauri/src/bin/cli-manager-codex-proxy.rs`、`codex_app_server_proxy.rs`、`commands/cc_connect.rs`、Cargo bin 自动发现和 `tauri.conf.json` 的 `beforeBundleCommand` 接入；远程运行链保持原样。
- GitNexus CLI 因其安装包缺少 `tree-sitter-kotlin` 无法重建索引；已降级为 codebase-memory moderate 重建索引、调用链风险追踪、源码/rg 和 Git diff。代理进程运行链被标记为 CRITICAL，因此本次只增加黑盒验证，不改其运行符号。

### 场景覆盖

- Windows launcher：覆盖 `.cmd` 与 `.exe` 两条真实 `Command` 分支、stdin/stdout JSONL 转发和非零退出码透传。
- Provider：覆盖未登记 Provider 的参数原样传递，以及登记 Provider 后 Base URL、env key、wire API、模型的 `-c` 注入；API Key 只在子进程环境变量中可见，不出现在参数、stdout 或 stderr。
- Windows 控制台：解析真实 proxy 的 PE Header，断言 `Subsystem == 2`（Windows GUI），避免 proxy 自身分配控制台；CMD/EXE 子进程继续由现有 `silent_command` 隐藏。
- macOS：Universal debug/release 按 Tauri 环境选择 profile，同时要求 ARM64、x64 的 daemon 和 proxy 均存在后逐一合并；非 macOS 或非 Universal 构建继续立即跳过。当前 Windows 主机无法实际执行 Apple `lipo`，最终由 macOS CI/打包环境验证。
- 窗口焦点、分屏、托盘、WSL、Worktree 与 Hook 安装状态不参与辅助二进制合并或代理进程协议，确认与本次改动无关。

### 验证结果

- `npm run test:codex-proxy:e2e`：通过，3 组检查覆盖真实 proxy 构建、PE GUI 子系统、EXE/CMD launcher、Provider 环境、密钥不进入参数/输出、JSONL 转发及退出码。
- `cargo check --locked --manifest-path src-tauri/Cargo.toml`：通过。
- `cargo test --locked --manifest-path src-tauri/Cargo.toml`：687 项通过、1 项因缺少 WSL 测试环境忽略；`install_then_uninstall_pi_extension` 失败。该测试对应的 `hook_settings.rs` 与 `origin/master` 完全一致，单独复跑仍失败，确认不是本次打包、代理或文档变更引入，按连续失败规则不继续重复执行。
- `node scripts/desktopPetMenuGeometry.test.mjs`：14 项通过；`desktopPetSize.test.mjs`：4 项通过；`desktopPetTransport.test.mjs`：4 项通过。
- `./node_modules/.bin/tsc.cmd --noEmit`：通过。
- `npm run build`：通过，Vite 完成 6688 个模块转换。
- `node --check`：新增 E2E 与 Universal 打包脚本语法检查通过。
- `git diff --check`：通过，仅输出仓库既有的 LF/CRLF 转换提示。
- 本次未生成安装包，未启动或停止用户安装目录中的 CLI-Manager/cc-connect，也未修改第三方 cc-connect 源码或二进制。

## PR #165 跨平台 Tauri Feature 隔离（2026-07-22）

### 根因与发现清单

- 根因位于 Cargo 目标依赖与 Tauri 平台配置边界：通用 `tauri` 依赖在 Windows/Linux 也启用了 `macos-private-api`，但对应的 `app.macOSPrivateApi = true` 只存在于 `tauri.macos.conf.json`；绕过 Tauri CLI 直接运行 Cargo 时，`tauri-build` 因 feature/config 不一致而终止。
- 修复落在依赖声明源头：通用依赖只保留跨平台 feature，`macos-private-api` 移入现有 macOS target dependency；未在 E2E 中注入 `TAURI_CONFIG` 或增加错误兜底。
- 已修改：`src-tauri/Cargo.toml`、Tauri 发布契约、CHANGELOG 与本验证记录。
- 已复核但未修改：`tauri.macos.conf.json` 继续启用私有 API；`verify-macos-window-controls.mjs` 可识别目标依赖；Windows proxy E2E 与 Release Workflow 继续使用真实直接 Cargo 构建作为回归门。
- `Cargo.lock` 无需更新；依赖包与版本未变化，仅调整既有 Tauri feature 的目标归属。
- GitNexus MCP 与项目本地 runner 均不可用，按仓库规则降级使用契约、Cargo metadata、关键词交叉引用和 Git diff 检查。

### 场景覆盖

- Windows/Linux：不解析 `macos-private-api`，直接 `cargo build/check` 不再与 macOS 配置发生冲突。
- macOS：目标依赖继续启用 `macos-private-api`，并与 `tauri.macos.conf.json` 保持一致。
- Tauri CLI 与直接 Cargo：常规平台配置合并链保持不变；不经 Tauri CLI 的 proxy E2E 也可构建。
- 窗口焦点、分屏、托盘、WSL、Worktree 与 Hook 状态不参与 Cargo feature 解析，确认与本修复无关。

### 验证结果

- Cargo metadata：通用 `tauri` feature 为 `tray-icon`、`protocol-asset`、`devtools`；macOS target 单独包含 `macos-private-api`。
- `node scripts/verify-macos-window-controls.mjs`：通过。
- `npm run test:codex-proxy:e2e`：通过，3 组真实 Windows proxy 检查全部成功。
- `cargo check --locked --manifest-path src-tauri/Cargo.toml`：通过。
- `git diff --check`：通过。

## PR #165 Windows Tauri 开发代理准备（2026-07-22）

### 根因与发现清单

- 根因位于 Windows 开发启动器与 Cargo 多二进制产物的边界：`src-tauri/Cargo.toml` 的 `default-run = "cli-manager"` 只构建主程序，而远程 Codex 托管在运行时从主程序同目录读取 `cli-manager-codex-proxy.exe`；因此直接执行 `npm run tauri dev` 会在首次远程托管时报告代理缺失。修复落在开发启动入口，在 Tauri 启动前构建实际被消费的 proxy，而不在运行时报错处增加回退或复制逻辑。
- 已修改：`scripts/tauri-cli.mjs` 在 Windows `dev` 入口执行锁定的 proxy Cargo build，转发 `--target`/`-t` 与 `--release`；新增黑盒脚本测试、npm 命令与 Windows release CI 门。
- 已复核但未修改：`commands/cc_connect.rs::write_codex_profile_wrapper` 继续严格要求同目录 proxy，`src-tauri/Cargo.toml` 的默认运行目标保持主程序，生产打包、macOS/Linux 代理路径与 app-server 协议均不变。
- GitNexus MCP 与本地 runner 不可用；按项目降级规则使用启动契约、`rg` 交叉引用、`cc_connect.rs` 消费端、Cargo 清单和 Git diff 进行发现与影响核对。

### 场景覆盖

- Windows 默认开发目标：先生成默认 debug proxy，再启动 Tauri。
- Windows 交叉目标：`--target`、`--target=<triple>`、`-t` 与 `-t=<triple>` 都归一化为 proxy Cargo 的 `--target`，确保 proxy 与主程序落在同一目标目录。
- Windows release 开发配置：`dev --release` 同步构建 release proxy，避免主程序与 proxy 分落 `target/release`、`target/debug`。
- 失败边界：proxy 构建退出非零时将其状态返回，Tauri 不会启动，也不会把缺失推迟到远程托管运行时。
- 平台和命令边界：非 Windows、`build` 和其他非 `dev` 子命令不触发开发 proxy 预构建；已有 dev config 注入和 WebView2 开发环境保持原行为。
- 窗口焦点、分屏、托盘、WSL、Worktree 与 Hook 安装状态不参与本启动产物选择，确认无关。

### 验证结果

- `npm run test:tauri-dev-proxy`：通过，8 组黑盒检查覆盖分离/内联的长短 target、release profile 与 `--` 参数边界、Cargo 先于 Tauri、构建失败阻断启动，以及非 dev 命令不预构建。
- `node --check scripts/tauri-cli.mjs` 与 `node --check scripts/tauriCliDevProxy.test.mjs`：通过。
- `node scripts/verify-macos-window-controls.mjs`：通过。
- `git diff --check`：通过。
- 未启动桌面应用，未生成安装包；本轮仅验证启动器分支与脚本语法，未重复执行此前已通过的真实 proxy E2E 和 Cargo 检查。

## SSH 显式地址直连被默认 Config 权限阻断修复（2026-07-22）

### 根因陈述与发现清单

- 根因位于“CLI-Manager 结构化 SSH 配置 → 系统 OpenSSH 参数”的进程边界：显式地址主机已经由应用提供地址、端口和认证参数，但旧实现没有传递 `-F`，OpenSSH 仍会自动读取用户 `~/.ssh/config`；当该文件向其他用户/组开放写权限时，OpenSSH 在连接与密码认证前直接以 `Bad owner or permissions` 退出。
- 本机证据：`C:\Users\lenovo\.ssh\config` 所有者正确，但继承了 `CodexSandboxUsers` 与另一个 SID 的 Modify 权限；裸 `ssh -G` 可稳定复现相同错误。目标 SSH 端口可达，使用 `-F none` 后能够完成协议握手并进入服务器提供的 `publickey,password` 认证阶段，确认服务器与网络不是本次失败点。
- 修复落在共享 `SshTransportSpec::append_connection_args`：未指定自定义 Config、没有目标 Config 别名且未配置跳板路由的显式地址直连统一追加 `-F none`；交互终端和一次性诊断/Agent/Hook 请求自动复用，不在错误展示层增加重试或兜底。
- 已修改：`ssh_transport.rs` 的共享参数生成及专项测试、`commands/ssh.rs` 的真实诊断命令参数断言、SSH 远程终端契约、CHANGELOG、功能清单和本验证记录。
- 已确认无需修改：SSH 主机数据库 Schema、密码凭据存储与 AskPass broker、前端主机编辑器、系统 `~/.ssh/config` 文件及其 ACL、远端服务器配置、SSH Config 导入解析器。
- GitNexus CLI 当前没有可用索引；codebase-memory 影响追踪将共享 SSH 参数入口标记为 CRITICAL。调用面覆盖交互终端、连接测试、远端 Agent/Hook、历史 bridge 与后台任务，因此修复严格限定在“显式地址、无自定义 Config 且未配置跳板路由”状态。

### 场景覆盖

- 显式地址直连：指定私钥、密码提示、凭据保存密码和 Keyboard-interactive 追加 `-F none`；Agent 保留默认 Config 以支持 `IdentityAgent` 等设置，交互式 PTY 与一次性连接使用相同规则。
- SSH Config 与跳板：存在目标 Config 别名或配置任意跳板路由时继续读取用户默认配置，不追加 `-F none`；选择自定义文件时继续使用 `-F <绝对路径>`。
- 路由：端口、跳板机、HTTP/SOCKS5/自定义 ProxyCommand 参数构造未改变；`-F none` 只隔离未显式选择的默认配置。
- 平台与状态：OpenSSH 的 `-F none` 在当前 Windows OpenSSH 9.5p2 实测可用，并为跨平台 OpenSSH 约定；窗口焦点、分屏、托盘、WSL、Worktree 与 Hook 是否安装不改变参数选择条件。

### 验证结果

- `cargo test --locked --manifest-path src-tauri/Cargo.toml ssh_transport::tests`：9 项通过，覆盖显式地址隔离、默认 Config 目标/跳板别名、自定义 Config、交互/一次性连接、认证和代理路由。
- `cargo test --locked --manifest-path src-tauri/Cargo.toml ssh_launch::tests`：14 项通过，覆盖真实交互终端 Launch Plan。
- `cargo test --locked --manifest-path src-tauri/Cargo.toml commands::ssh::tests`：27 项通过，覆盖连接诊断、密码/交互模式、Agent 与 Hook 命令。
- `cargo check --locked --manifest-path src-tauri/Cargo.toml`：通过。
- `rustfmt --edition 2021 --check src-tauri/src/ssh_transport.rs src-tauri/src/commands/ssh.rs`：通过。
- `npm run build`：通过，Vite 完成 6688 个模块转换。
- `ssh -F none` 对目标主机的无密码探测成功越过本机 Config ACL 检查并抵达认证阶段；为避免在命令记录中传播用户密码，本次未用自动化脚本提交明文密码。
- 本次未修改用户 `~/.ssh/config` 权限、未写入远端文件，也未启动或停止用户安装目录中的 CLI-Manager。

## PR #165 合并阻断项根因修复（2026-07-23）

### 根因与发现清单

- macOS/Linux Codex wrapper 的问题位于原子文件替换与 POSIX 执行权限边界：普通文件写入受 umask 影响且内容未变化时会提前返回。修复统一在写入或复用后校正 `0755`，并增加权限回归测试。
- SSH Agent 的问题位于结构化 Host 模型与 OpenSSH Config 能力边界：当前模型没有 `IdentityAgent` 等字段，Agent 直连不能声称已完整描述认证。`-F none` 现仅用于私钥、密码、凭据引用和交互认证；Agent/SSH Config 继续读取默认 Config。
- Tauri 开发参数的问题位于 Tauri、Cargo runner 与应用参数的双层边界：第一个 `--` 后仍是 runner 参数，第二个 `--` 后才是应用参数。proxy 预构建现同步 target、release、profile、target-dir，并忽略应用区。
- Windows Codex shim 的问题位于 PATH 替换后的命令兼容边界：shim 置于 PATH 首位后必须保持原 wrapper 的普通命令行为。现仅在首个子命令为 `app-server` 时启用 JSONL 代理，其他命令透传 stdio、Provider 覆盖和退出码。
- 探测超时的问题位于启动器与真实后代进程的生命周期边界：只 kill 直接子进程无法回收真实 Codex，也可能让后代继续持有 stdout/stderr。Windows 统一使用 Job Object，macOS/Linux 使用独立进程组；超时、等待失败和启动器提前退出都清理所属进程树。
- Unix launcher 的问题位于 wrapper PATH 优先级与真实 Codex 解析边界：把裸字符串 `codex` 同时保存为 launcher 并把 wrapper 目录放到 PATH 首位，会让 app-server 和普通命令再次命中 wrapper 自身。现从原 PATH 解析并校验 wrapper 之外的可执行绝对路径，新增排除 managed wrapper 的回归测试。
- 触点已覆盖 `cc_connect` wrapper/托管进程、共享 `output_with_timeout` 调用方、SSH PTY/探测/Agent/Hook/bridge、Tauri 开发启动脚本、Codex proxy、契约、功能清单和 V1.3.1 CHANGELOG。数据库 Schema、前端 SSH 编辑器、第三方 cc-connect 源码及用户 Config 文件确认无须修改。
- GitNexus 在该 worktree 无可用工具入口，按项目规则降级为契约文档、`rg` 调用链和源码 diff；共享 `append_connection_args` 与 `output_with_timeout` 按高风险入口复核。

### 验证结果

- `node --check scripts/tauri-cli.mjs`：通过。
- `node --check scripts/tauriCliDevProxy.test.mjs`：通过。
- `node --check scripts/codexAppServerProxy.e2e.test.mjs`：通过。
- `npm run test:tauri-dev-proxy`：12 项通过，覆盖 Tauri/runner/application 双层边界及 target/release/profile/target-dir。
- 按用户要求未运行 Cargo 编译、Rust 测试、真实 Codex proxy E2E、Tauri dev/build 或桌面应用。

## 桌宠仅关注 Agent 终端（2026-07-23）

### 根因与发现清单

- 根因位于终端语义与桌宠状态聚合边界：桌宠此前只消费 PTY 输出、进程存活和 Hook 状态，没有区分由项目 `cli_tool` 启动的 Agent 终端与 `startup_cmd`/空 Shell 普通终端，因此前端、Java、Go 等长期进程会持续显示为工作中。
- 新增会话级 `isAgentSession`/`cliTool` 快照，创建终端时按项目是否配置 `cli_tool` 固化；恢复、daemon attach、分屏和远程托管恢复继续保留，旧会话缺少字段时从关联项目兼容推导。
- 新增桌宠设置 `agentSessionsOnly`，默认开启；过滤只落在 `deriveDesktopPetSnapshot` 的前台和 daemon 候选入口，不修改终端标签状态、后台任务面板、退出确认、PTY 或 Hook 状态机。
- 已修改：终端会话类型与创建/恢复链、桌宠协调器和快照聚合、桌宠设置迁移与独立窗口默认配置、设置页及中英文文案、Agent 终端分类纯逻辑测试。
- 已确认无需修改：Rust PTY/daemon 协议。daemon 任务通过 `sessionId` 与已持久化的 `TerminalSession` 配对，分类信息在主窗口关闭及重新 attach 后仍可恢复。
- GitNexus 未建立索引；`npx gitnexus analyze` 因其 npx 包缺少 `tree-sitter-kotlin` 失败，按仓库规则降级为 `rg` 调用点、真实源码、Git diff、类型检查和构建验证。

### 场景覆盖

- 本地、WSL 与 SSH 项目统一以项目 `cli_tool` 是否非空分类；自定义 CLI 工具也视为用户显式声明的 Agent。
- 未关联项目、`cli_tool` 为空、使用自定义启动命令或空 Shell 的普通终端，在开关开启时不进入桌宠任务、计数和状态选择。
- 开关关闭时保留原有全终端聚合行为；旧设置缺少新字段时迁移为默认开启。
- 前台多会话、分屏、后台 daemon、应用重启恢复和远程托管恢复均保留创建时分类；项目配置后续改变不会重写已运行会话的类型。
- Hook 安装与否只影响 Agent 会话的细分状态，不再决定终端类型；普通 Shell 中手动运行 Agent 且项目未配置 CLI 工具时按设计仍视为普通终端。

### 验证结果

- `node scripts/agentTerminal.test.mjs`：4 项通过，覆盖 Agent/普通分类、分类快照稳定性、旧会话兼容和开关关闭兼容行为。
- `node scripts/desktopPetTransport.test.mjs`：4 项通过。
- `node scripts/desktopPetSize.test.mjs`：4 项通过。
- `npx tsc --noEmit`：通过。
- `npm run build`：通过。
- `git diff --check`：通过，仅有仓库现有 Windows 行尾提示。

## SSH 远程目录浏览响应优化（2026-07-27）

### 根因与发现清单

- 根因位于桌面端 SSH bridge 调度边界：主 bridge 的 `hookDrain` 最长等待 2 秒，但旧调度只把外部 RPC 计入忙碌状态，文件请求会误判正在长轮询的主 bridge 为空闲并排在轮询之后；逐级目录 RPC 会把该等待重复叠加。修复落在 bridge 空闲槽与文件树请求消费层，而不是增加超时、重试或修改远端 Agent。
- 已修改 `src-tauri/src/daemon/ssh_agent_bridge.rs`：Hook 长轮询完整占用主 bridge 空闲槽；只读文件请求仅复用真正空闲的主 bridge，否则进入独立只读 lane；只读与 Git lane 改为请求驱动并保留 heartbeat。
- 已修改 `src/stores/fileExplorerStore.ts` 与 `src/lib/sshRemoteFiles.ts`：重复展开、紧凑目录链和路径定位复用已加载的 SSH children；关闭、切换和失败路径释放远程 consumer，并用请求序号及同 consumer 释放队列隔离快速切换竞态。
- 已复核但未修改 `commands/ssh_files.rs` 的文件 RPC、`commands/history.rs::history_remote_close` 的 consumer 释放入口、文件浏览组件调用方、远端 Agent `files.rs`/`protocol.rs`、协议版本和已发布 Agent 二进制。
- GitNexus 本地 runner 因缺少 `tree-sitter-kotlin` 无法刷新；按规则降级到 SSH 契约、codebase-memory、`rg`、源码和测试。完成后已重建 moderate 索引，并以 `HEAD` 为基线确认工作区只涉及预期的 5 个文件。

### 场景覆盖

- 主 bridge 正在 Hook 长轮询、外部请求已占用、连接中或真正空闲时，文件请求分别隔离、隔离、隔离或复用；文件请求不再进入已开始的 Hook 轮询队列。
- 独立只读和 Git lane 在有请求时立即处理，无请求时仅维持 heartbeat，不消费与其身份无关的 Hook spool；Git 串行读写语义保持不变。
- SSH 目录首次展开仍请求远端；折叠后重开、紧凑单目录链和终端路径定位复用已经加载的 children；显式刷新仍重新读取远端，避免缓存掩盖文件变化。
- 同项目重开、跨项目快速切换、加载中关闭和加载失败均不会让旧异步结果覆盖新项目，也不会让同 consumer 的延迟释放误关新 bridge。
- 本地文件项目、WSL、窗口焦点、分屏、托盘和 Worktree 不经过该 SSH 文件 bridge 调度；本次行为保持不变。

### 验证结果

- `cargo test --locked --manifest-path src-tauri/Cargo.toml daemon::ssh_agent_bridge::tests`：21 项通过、0 项失败。
- `npx tsc --noEmit`：通过。
- `npm run build`：通过，Vite 完成 6696 个模块转换。
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过。
- `git diff --check`：通过，仅有仓库现有 Windows 行尾提示。
- 全量 Rust 测试结果为 737 项通过、1 项忽略、1 项失败；失败的既有 `commands::hook_settings::tests::install_then_uninstall_pi_extension` 已单独复现，断言发生在未修改的 Pi Hook 卸载状态，与本次 SSH bridge 和文件树改动无调用关系。
- 尚未连接真实远端目录做交互延迟对比，也未生成安装包；该项留给安装包或开发模式下的实际 SSH 冒烟测试。

## Windows 桌宠首次显示任务栏缩略图修复（2026-07-27）

### 根因与发现清单

- 根因位于 Tauri 隐藏窗口首次显示与 Windows Explorer 任务栏登记的生命周期边界：桌宠虽然在静态窗口配置中设置了 `skipTaskbar`，但部分 Windows 11 环境会在后续 `show()` 时重新登记窗口；旧显示链路没有再次应用跳过任务栏属性，因此冷启动可出现缩略图，而关闭后重开又会自愈。
- 修复落在唯一的桌宠显示入口 `desktop_pet_window_sync`：Windows 下每次 `show()` 成功后幂等调用 `set_skip_taskbar(true)`，不通过延时、窗口样式覆写或前端重试掩盖竞态。
- 已修改 `src-tauri/src/commands/desktop_pet.rs`、`CHANGELOG.md` 与本验证记录。
- 已确认无需修改桌宠 React 渲染、窗口尺寸与位置、置顶策略、托盘逻辑、PTY daemon，以及 macOS/Linux 窗口行为。
- GitNexus CLI 未建立本仓库索引，按规则降级到 codebase-memory 调用图、`rg` 与源码复核；IPC 命令没有静态 Rust 调用方，实际入口为 `useDesktopPetCoordinator` 的 Tauri invoke，影响范围限定为桌宠窗口同步路径，风险为低。

### 场景覆盖

- 冷启动启用桌宠、设置中关闭后重新启用、托盘运行后重新显示，均经过同一窗口同步入口并重新应用跳过任务栏属性。
- 窗口置顶开关、保存位置与大小调整仍在显示前完成，不改变现有行为；主窗口任务栏入口不受影响。
- `Alt+Tab` 与任务栏都依赖 Windows 原生窗口属性；本次只重新声明已有配置，不创建第二个窗口，也不改变窗口 owner。
- macOS/Linux 由编译条件保持原显示路径；窗口焦点、分屏、WSL、Worktree 与 Hook 安装状态均不参与该属性同步。

### 验证结果

- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过。
- `cargo test --locked --manifest-path src-tauri/Cargo.toml commands::desktop_pet::tests`：13 项通过、0 项失败。
- `cargo check --locked --manifest-path src-tauri/Cargo.toml`：通过。
- `npx tsc --noEmit`：通过。
- `git diff --check`：通过，仅有仓库现有 Windows 行尾提示。
- GitNexus `detect-changes` 因本地没有该仓库索引而不可用；降级刷新 codebase-memory moderate 索引并执行工作区变更检测，确认仅涉及 `desktop_pet_window_sync` 及预期的 CHANGELOG、验证记录。
- `npm run tauri:build:local -- --bundles nsis`：通过，仅构建 NSIS；安装包为 `src-tauri/target/release/bundle/nsis/CLI-Manager_1.3.1_x64-setup.exe`，大小 17,093,981 字节，SHA-256 为 `51956099BB6246982D1FE7E64A4B9C321A0AF795E24BB5332D1306A654B037C0`。
- 自动化验证无法直接断言 Windows Explorer 的任务栏缩略图状态，冷启动、关闭后重开及任务栏/Alt+Tab 表现需用本安装包在受影响的 Windows 11 机器上冒烟确认。

## SSH 历史会话详情身份校验修复（2026-07-28）

### 根因与发现清单

- 根因位于历史列表与详情的前端身份校验边界：SSH 缓存列表和远端详情按协议都将本地 `file_path` 留空，但新加入的共享校验要求文件路径非空，因此合法 SSH 详情在后端完成远端身份验证后仍会被前端固定拒绝为 `history_session_identity_mismatch`。
- 已修改 `src/lib/historySessionIdentity.ts`：本地/WSL 继续严格比较 source、session id 和规范化文件路径；只有双方都是 SSH 时才改用完整稳定 `session_ref`，并校验其 source、source instance、source session 和 transport 与顶层身份一致。
- 已修改 `scripts/historySessionIdentity.test.mjs` 与前端历史契约，覆盖无本地文件路径的正常 SSH 详情，以及实例变化、缺少引用、传输类型混用和引用字段漂移的拒绝路径。
- 已复核但未修改 `historyStore.openSession`、`historyStore.openSearchHit`、`HistoryWorkspace` 恢复按钮、Rust `history_remote_get_session`、远端 SSH Agent `history::get` 和远端历史目录；后端已有完整远端身份验证，问题只发生在响应返回后的共享前端守卫。
- codebase-memory 入向影响分析标记为 CRITICAL：共享函数同时控制详情打开、搜索命中、收藏快照回退和恢复按钮，因此修复保留非 SSH 语义并保持缺失/漂移身份 fail-closed。

### 场景覆盖与验证结果

- SSH 列表详情、搜索结果详情和恢复按钮接受同一完整远端会话引用；离线收藏快照只有保留相同 SSH 引用时才可回退。
- 本地、WSL、转换会话仍必须提供相同非空文件路径；旧的空路径对象不会因本次修复被放行。
- `node scripts/historySessionIdentity.test.mjs`：5 项通过。
- `node scripts/historyConversionState.test.mjs`：3 项通过。
- `node scripts/historyListRefreshState.test.mjs`：4 项通过。
- `node scripts/historyResumeProject.test.mjs`：3 项通过。
- `node scripts/remoteHandoff.test.mjs`：4 项通过。
- `npx tsc --noEmit`、`npm run build`、`git diff --check`：通过。
- 尚未连接真实 SSH 主机点击截图中的历史记录做交互冒烟；该项需由安装包或开发模式连接真实远端验证。

## SSH 主机目录选择器响应优化（2026-07-28）

### 根因与发现清单

- 根因位于 SSH 目录选择器的传输边界：项目路径与 CLI 配置目录两个选择器仍直接调用 `ssh_list_directories`，每进入一级目录都会启动新的 OpenSSH 进程并重复握手，也没有复用已读取目录；此前的 SSH 文件树优化没有覆盖这两个入口。
- 新增 `sshRemoteDirectories` 与 `useSshDirectoryBrowser`：已安装兼容 SSH Agent 时复用现有只读 bridge，未安装、不可用或返回受限结果时保持原有 OpenSSH 查询；目录结果使用 96 项 LRU 上限，显式刷新绕过缓存。
- 已修改 `ConfigModal` 与 `SshCliIntegrationDialog` 两个真实入口，统一接入缓存、请求序号和关闭/切换取消逻辑；旧请求不能覆盖新路径，关闭后不会继续触发新的回退连接。
- 已复核但未修改 `ssh_list_directories`、`ssh_remote_file_list`、daemon 的只读 lane、远端 Agent 文件协议和 consumer 释放命令；本次不改变认证、代理、跳板机、路径校验或已发布 Agent 协议。

### 场景覆盖与验证结果

- Agent 已安装时，同一次选择器浏览只支付首次 SSH 握手；返回上级或重复进入目录直接命中缓存，刷新按钮强制重新读取。Agent 未安装、版本不兼容、daemon 不可用或目录条目达到 Agent 上限时继续使用原 OpenSSH 路径。
- 项目目录与 CLI 配置目录、根目录与多级目录、快速连续切换、加载中关闭、切换主机、密钥/Agent/凭据引用/SSH Config/代理/跳板机均复用原结构化连接参数；交互式认证仍按既有契约拒绝无 PTY 浏览。
- `npx tsc --noEmit`：通过。
- `npm run build`：通过，完成 6702 个模块转换。
- `git diff --check`：通过，仅有仓库现有 Windows 行尾提示。
- 尚未连接真实高延迟 SSH 主机做首次握手与后续逐级浏览的耗时对比；需在开发模式或安装包中完成实际网络冒烟。

## cc-connect Codex 托管恢复 Provider 修复（2026-08-03）

### 根因与发现清单

- 根因位于 CLI-Manager app-server 代理与 Codex `thread/resume` 的配置边界：代理把只存在于进程级 `-c` 覆盖中的合成 Provider `cli_manager_remote` 再写入请求级 `modelProvider`；Codex 0.146.0 会从持久化配置层解析该请求字段，因此报 `Model provider cli_manager_remote not found`。
- 微信、Telegram、飞书和企业微信共用该 Agent 链路，平台收发、cc-connect 启动、原 Session ID、工作目录、项目 Provider 数据、模型目录和真实 `CODEX_HOME` 均已确认不是本次失败源。
- 修复删除请求级 Provider 注入及其无用参数传递；项目登记 Provider 继续由 app-server 启动时的 `-c model_provider`、Provider 定义和密钥环境强制生效。Session 防漂移、新线程拦截、SSH cwd 改写与文件投递提示保持不变。

### 验证结果

- `cargo test --locked --manifest-path src-tauri/Cargo.toml codex_app_server_proxy::tests`：18 项通过。
- `node scripts/codexAppServerProxy.e2e.test.mjs`：4 项通过。
- 使用新编译代理和真实 Codex 0.146.0 恢复原失败会话 `019fc591-8a0b-7872-95b5-49c591ed4db1`：恢复成功，Session ID 保持不变，模型为 `gpt-5.6-sol`。
- 对照验证保留请求级 `modelProvider` 时稳定复现原错误，删除该字段后同会话成功恢复。

## SSH Config 用户身份与 PtyHost 升级修复（2026-08-04）

### 根因与发现清单

- Hook 失败根因位于 SSH Config 连接身份与 Hook 元数据持久化的边界：Config 别名主机按设计不保存 `username`，但 Hook 检查、安装和卸载完成后仍直接用该空字段写入集成记录，固定触发 `ssh_user_required`。
- 修复通过本机 OpenSSH `ssh -G` 解析当前别名、Include、Match 和默认规则最终生效的 `User`，直连主机继续优先使用已登记用户名；解析结果接入 Hook 检查、安装、卸载及项目覆盖记录入口，不修改远端 SSH Agent 协议。
- SSH 启动失败根因位于持久 PtyHost 与新版本应用的进程生命周期边界：旧 daemon 有存活会话时会被保留，而创建 SSH 会话要求 daemon 与应用版本一致；旧逻辑在会话结束后也只报错，不会重新尝试升级。
- 修复统一 daemon 的版本和二进制传输能力检查：无存活会话时串行关闭旧 daemon、启动当前版本并重置前端旧传输；仍有存活会话时保留会话并显示明确的关闭提示，不强杀用户任务。
- 触点包括 `commands/ssh.rs`、`SshCliIntegrationDialog`、Hook 元数据 Store、`commands/terminal.rs`、`TerminalProcessManager`、`PtyHostSocket`、终端错误映射和中英文文案；SSH 认证、代理、跳板机、远端 Agent 制品、cc-connect 和普通本地 PTY 创建逻辑已确认不改变。
- GitNexus CLI 因其运行依赖缺少 `tree-sitter-kotlin` 无法建立索引；已降级使用 codebase-memory moderate 索引、调用路径、`rg`、源码和 Git diff 复核，工作区检测只包含上述预期链路。

### 场景覆盖与验证结果

- 覆盖直连显式用户名、SSH Config 别名解析、无法解析用户名、daemon 当前版本、旧 daemon 空闲自动升级、旧 daemon 存活会话阻塞，以及升级后的 WebSocket 重新连接。
- `cargo test commands::ssh::tests::`：29 项通过。
- `cargo test commands::terminal::tests::`：2 项通过。
- `node scripts/ptyHostSocket.test.mjs`：11 项通过。
- `node scripts/terminalProcessManager.test.mjs`：7 项通过。
- `cargo check`、`npx tsc --noEmit`、`cargo fmt --all -- --check`、`git diff --check`：通过。
- 尚未使用受影响用户的 SSH Config 和跨版本残留 daemon 做真实机器冒烟；需由安装包验证 Hook 检查/安装，以及保留旧会话和关闭旧会话后的 SSH 启动行为。

## cc-connect 项目无关连接配置（2026-08-04）

### 根因与发现清单

- 日志中的 `remote profile is stale; save it again from the current project list` 来自远程连接 Profile 对项目 ID、名称和路径的强一致校验；该校验发生在宠物选中会话的目标解析之前，因此设置项目与托管项目不同、项目移动或重新登记都可能直接阻断启动。
- 设置页已移除项目和 Agent 选择；后端使用固定控制工作区维持平台连接，宠物托管请求继续从真实终端会话传递项目、工作目录、CLI Session ID、Worktree/SSH 元数据，并在启动时读取该项目当前 Provider。
- `/cli_manager_switch` 改为保存独立 `runtimeProjectId`，启动时动态解析；无效目标回退控制工作区。旧平台 Session 与微信状态会复制到控制身份，活动中的旧托管直到取消后才迁移。
- 触点包括 cc-connect Profile 归一化/启动/自动启动、配置生成、项目切换、平台 Session 与微信状态迁移、托管预检/开始/取消、设置页和中英文说明；凭据存储、cc-connect 源码、SSH Agent 协议、终端挂起/恢复和 Hook 通知协议确认不改变。

### 场景与验证

- 覆盖无项目配置的控制待机、旧项目 Profile 迁移、平台 Session/微信状态保留、宠物选择不同本地项目、动态 Provider、持久化远程项目切换、项目移动/删除回退、活动旧托管取消兼容，以及本地/SSH 目标的既有工作目录验证。
- `cargo test commands::cc_connect::tests::`：48 项通过。
- `cargo test commands::cc_connect::handoff::tests::`：2 项通过。
- `node scripts/remoteHandoff.test.mjs`：5 项通过。
- `cargo fmt --all -- --check`、`cargo check`、`npx tsc --noEmit`、`npm run build`、`git diff --check`：通过。
- 尚未执行真实 Telegram、微信、飞书、企业微信授权及安装包冒烟；该项留给后续打包测试阶段。

## 桌宠状态气泡顶部裁切修复（2026-08-06）

### 根因与发现清单

- 根因位于桌宠 CSS 缩放与 Tauri 原生窗口尺寸的同步边界：宠物画面和状态气泡已按用户尺寸渲染时，隐藏窗口首次显示、WebView2 残留缩放或跨 DPI 显示器恢复可能仍保留基础 `190 x 210` 窗口，超出透明 WebView 顶边的气泡会被根节点裁切。
- `desktop_pet_window_sync` 现在按目标显示器 DPI 直接计算物理窗口尺寸，先应用目标位置和尺寸，显示后校验并在窗口管理器改写几何信息时重新应用；Windows 桌宠 WebView 同时恢复为 100% 页面缩放。
- 桌宠窗口发出 ready 事件后会强制重跑一次原生窗口同步，再发送配置与状态，覆盖首次显示时窗口尚未稳定的时序。
- 已修改 `src-tauri/src/commands/desktop_pet.rs` 与 `src/hooks/useDesktopPetCoordinator.ts`；已复核但未修改状态气泡 CSS、宠物资源解析、目录扫描、菜单展开几何、任务状态和远程托管逻辑。
- GitNexus MCP 当前未暴露；已降级使用 codebase-memory moderate 索引、调用路径、`rg`、源码和 Git diff。工作区检测仅包含上述两处实现及本验证记录。

### 场景与验证

- 覆盖宠物尺寸 40%～150%、显示器 DPI 100%/125%/150%、保存位置与默认位置、隐藏窗口首次显示、桌宠 ready 后恢复，以及 Windows WebView2 非 100% 残留缩放。
- `cargo test desktop_pet --lib`：15 项通过，包含新增的尺寸与 DPI 组合测试。
- `node --test scripts/desktopPetSize.test.mjs scripts/desktopPetMenuGeometry.test.mjs scripts/desktopPetTransport.test.mjs scripts/desktopPetStatus.test.mjs`：25 项通过。
- `npx tsc --noEmit`、`npm run build`、`cargo check`、`cargo fmt -- --check`、`git diff --check`：通过。
- 当前机器未复现 Issue #196 用户的 WebView2/显示器状态；最终仍需由受影响 Windows 11 机器验证内置小猫和 Codex Pets 在原尺寸设置下的气泡完整性。

## Codex app-server Provider Profile 回归修复（2026-08-14）

### 根因与发现清单

- 根因位于 CLI-Manager 原生 Codex 代理的命令参数边界：提交 `b84a7d68` 为锁定登记 Provider，在公共参数构造器中重新加入 `--profile`；该构造器同时服务 app-server 和普通运行命令，而 Codex 0.147.0 明确禁止 app-server 使用 `--profile`，导致 cc-connect 启动探针以退出码 1 结束。
- 修改 `src-tauri/src/codex_app_server_proxy.rs`：参数构造按命令类型区分；app-server 只接收完整的 `model_provider`、Provider name、base URL、env key、wire API、模型目录及可选模型 `-c` 覆盖，普通运行命令继续加载生成的 Provider profile。
- 修改 `src-tauri/src/commands/cc_connect.rs`：删除只为 app-server strict probe 镜像 Provider profile 的失效逻辑；真实 `CODEX_HOME`、登记 Provider 环境、模型目录和密钥脱敏保持不变。
- 修改 `scripts/codexAppServerProxy.e2e.test.mjs`：锁定 app-server 不得出现 `--profile`，同时保留普通命令必须携带 profile 的断言。
- 已复核但未修改：微信、Telegram、飞书、企业微信的平台配置与授权、cc-connect 源码及安装、SSH Codex 直连、会话 ID/cwd/Provider 校验、用户消息透传和文件投递上下文。
- GitNexus 与 codebase-memory MCP 当前未暴露；已按降级规则使用修复契约、`rg`、Git 历史和源码调用点完成影响分析。该启动边界影响全部本地 Codex 远程平台，风险为 HIGH。

### 验证结果

- 本机 Codex CLI 0.147.0：旧参数稳定复现 `--profile only applies to runtime commands`；去掉 profile、保留相同完整 `-c` Provider 覆盖后，`app-server --strict-config --listen stdio://` 正常启动并以 0 退出。
- 新编译的 Windows `cli-manager-codex-proxy.exe` 使用隔离 `CODEX_HOME`、受管 Provider name 和完整覆盖启动真实 Codex app-server 成功；未发起模型请求。
- `cargo test codex_app_server_proxy::tests --lib`：21 项通过。
- `cargo test commands::cc_connect::tests --lib`：48 项通过。
- `node scripts/codexAppServerProxy.e2e.test.mjs`：4 项通过，使用真实 Windows 原生代理二进制。

## cc-connect Codex 子进程 Provider 密钥转发修复（2026-08-14）

### 根因与发现清单

- 根因位于 CLI-Manager 受管进程环境与 cc-connect Agent 子进程环境的边界：CLI-Manager 只把登记 Provider 的动态密钥变量注入 cc-connect 父进程，却没有写入 `[projects.agent.options.env]`；cc-connect app-server 恢复线程后能选中正确 Provider，但模型请求阶段的 Codex 子进程缺少该变量，因此远程平台持续显示输入中并报 `Missing environment variable`。
- 日志确认平台消息已接收、Codex app-server 已启动且原 `cliSessionId` 已恢复；项目仍解析到登记 Provider，失败变量名也与该 Provider ID 的派生变量一致，排除了平台凭据、代理、工作目录、Session ID 和 Provider 选择错误。
- 修改 `build_managed_config_with_codex`：把 Provider 动态变量通过 `${VAR_NAME}` 占位符显式加入 Agent 环境；真实密钥仍只存在于受管进程环境，不写入 `config.toml`、日志或命令行。微信、Telegram、飞书和企业微信复用同一 Codex Agent 配置，因此同时覆盖。
- 已复核但未修改 app-server 代理参数、`thread/resume` 校验、Provider 数据库/密钥存储、SSH 托管和 cc-connect 源码。
- GitNexus 与 codebase-memory MCP 当前未暴露；已降级使用 Provider 契约、`rg`、生成配置、运行日志与源码调用点完成影响分析。变更只影响本地 Codex 受管配置生成，风险为中等。

### 验证结果

- `cargo test managed_codex_config_forwards_provider_key_without_persisting_secret`：通过，断言配置包含动态变量占位符且不包含 Provider 密钥、地址或名称。
- 使用本机 cc-connect `v1.5.0-beta.3` 执行 `managed_config_matches_installed_cc_connect_when_requested`：通过，生成配置可被已安装版本解析和格式化。
- `cargo test commands::cc_connect::tests --lib`：48 项通过。
- `cargo fmt --all -- --check`、`git diff --check`：通过，仅有仓库现有 Windows 行尾提示。
- 用户已完成真实远程托管消息冒烟，确认问题解决。

## 大型用量数据库首次升级启动修复（2026-08-14）

### 根因与发现清单

- 根因位于前端启动监控与 SQL 迁移的异步边界：上游迁移 27 会把旧 `request_logs` 全量写入 `usage_records`；当前环境有 1,398,185 条记录、主数据库约 1.2 GB，迁移超过固定 15 秒后仍在正常执行，但前端把“耗时较长”错误转换为 `startup_timeout:stores`，重试会重新加载 WebView 并中断迁移。
- 修改 `src/App.tsx`：15 秒阈值只切换为长时间加载提示，不再制造伪启动错误；真实 rejected promise 仍由既有初始化错误页处理。会话 Store 与主数据库拆为独立启动阶段，便于界面和日志准确定位。
- 修改 `src/lib/i18n.ts`：补齐中文和英文的会话恢复、数据库升级及长时间初始化提示。
- 新增 `scripts/appStartupLongMigration.test.mjs`：锁定长迁移不得进入失败页、数据库阶段和双语提示必须接入真实启动界面。
- 已确认未修改 SQLx 迁移 25～29 的版本、SQL 或校验和，未删除、裁剪或重写用户用量记录；项目加载、同步功能、会话恢复及真实启动异常处理保持原流程。
- GitNexus 工具当前未暴露；codebase-memory 对 `runStartupStage` 的影响分析覆盖全局 `App` 启动链路并判定为 CRITICAL，已结合启动日志、SQLite 迁移表、源码和 Git diff 复核。

### 验证结果

- `node scripts/appStartupLongMigration.test.mjs`：2 项通过。
- `npx tsc --noEmit`：通过。
- `npm run build`：通过，完成 6822 个模块转换。
- `git diff --check`：通过，仅有仓库现有 Windows 行尾提示。
- 未在用户正在使用的 1.2 GB 数据库上启动新包，以免关闭或干扰现有 CLI-Manager；安装包首次运行仍需等待一次性迁移完成，后续启动不再重复迁移。

## 百万级项目路径迁移后台化（2026-08-21）

### 根因与发现清单

- 根因位于 SQLx 启动迁移与历史用量维护边界：migration 32 对 `usage_records` 执行全表关联和相关更新，并要求一个启动事务完成；现场数据库约 3.3 GB，`usage_records` / `request_logs` 各约 164 万行，启动日志在 database 阶段等待超过 26 分钟仍未提交。
- `src-tauri/src/commands/db_repair.rs` 在数据库插件加载前仅为有历史行、已有 `project_path` Schema 且尚未应用 v32 的旧库登记原 v32 description/checksum；空库、缺 Schema 和已应用 v32 均保持标准 SQLx 行为。
- 同文件新增单飞后台回填：先构造唯一项目路径映射和临时 rowid 队列，再按 2,000 行短事务更新；route 路径按相同 source/session 从最新 session_log 继承。既有非空路径、重名项目和 SSH 项目不会被覆盖或猜测。
- `src/lib/db.ts` 在 `Database.load` 成功后非阻塞触发真实后台入口；`src-tauri/src/lib.rs` 注册命令。请求日志读取对空路径已有 bounded legacy project-key 兼容，因此回填期间仍可使用。
- 原 `MIGRATION_BACKFILL_REQUEST_LOG_PROJECT_PATH_SQL`、版本 32、视图和 checksum 未修改；统计口径、历史解析、Provider、远程托管与桌宠确认无关。
- GitNexus 未暴露且本地 `npx` 因缓存权限不可用；按 app-startup/history-stats 契约、`rg`、源码调用链、SQLite 现场数据和 Git diff 降级。变更触达 `getDb` 后全部 SQLite 消费者，风险 HIGH。

### 验证结果

- `cargo test --manifest-path src-tauri/Cargo.toml db_repair --lib`：15 项通过；新增覆盖原 checksum 登记、空库/缺 Schema no-op、唯一/歧义映射、50,005 行跨批次回填、route 继承、已有路径保护及重复运行幂等。
- `cargo check --manifest-path src-tauri/Cargo.toml`、`cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`、`node_modules/.bin/tsc --noEmit`、`git diff --check`：通过。
- `npm run tauri:build:local -- --bundles nsis`：通过，复用 npm/Cargo 缓存，仅生成 `CLI-Manager_1.3.7_x64-setup.exe`；SHA256 `002700BBD64E9579DC8A12DC1FE17011D0099EFBAFA6C2D8FA80584877FE46B8`。
- GitNexus `detect-changes` 无法执行：当前会话未暴露 MCP，本地无 CLI，`npx --offline` 也没有缓存包；已用契约、源码调用链、聚焦测试和最终 Git diff 完成降级范围复核。
- 打包前未主动操作仍由已安装 CLI-Manager 使用的 3.3 GB 真实数据库，避免干扰当前会话；现场诊断阶段只执行只读 Schema、迁移状态、行数和日志检查。
- 用户使用 NSIS 升级包对原 3.3 GB / 164 万行数据库完成真实升级启动冒烟，确认应用不再阻塞于 migration 32，测试通过。

## 微信授权 Profile 隔离修复（2026-08-24）

### 根因与发现清单

- 根因位于微信授权专用配置与常规 cc-connect Profile 校验边界：`start_weixin_authorization` 在启动 setup 子进程前调用 `normalize_profile`，会校验所有已启用平台；任一 Telegram、飞书或企业微信草稿的 `allow_from` 为空都会提前返回 `allow_from must contain at least one explicit user ID`。
- 新增 `prepare_weixin_authorization_platforms`：微信强制进入授权占位状态，旧微信 allowlist 无效时允许重新扫码；其他启用但 allowlist 无效的平台仅改为禁用并保留字段，配置有效的平台保持启用。随后仍复用严格 `normalize_profile` 校验公共字段，扫码完成后继续通过原 `parse_weixin_authorization_result` 强制 token 与 `@im.wechat` ID。
- 常规保存/启动、代理、二进制检测、凭据存储、授权 TOML 协议和 cc-connect 源码均未放宽或修改；前端仍使用原 IPC 和错误展示。
- GitNexus MCP/CLI 不可用且离线 npm 无缓存，已通过 cc-switch 契约、`rg`、源码、Git blame 和聚焦测试降级复核；影响仅限微信授权 Profile 准备及其结果保存，风险中等。

### 验证结果

- `cargo test --manifest-path src-tauri/Cargo.toml commands::cc_connect::tests:: --lib`：59 项通过；新增覆盖无效其他平台草稿隔离、有效平台保留、无效旧微信 ID 重授权和常规严格校验。
- `cargo check --manifest-path src-tauri/Cargo.toml`、`cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`、`node_modules/.bin/tsc --noEmit`、`git diff --check`：通过。
- Trellis context 校验通过。GitNexus `detect-changes` 因当前会话未暴露 MCP、本机无缓存 CLI 而无法运行；已使用契约、调用点、全部 cc-connect 单元测试和最终 diff 降级复核。
