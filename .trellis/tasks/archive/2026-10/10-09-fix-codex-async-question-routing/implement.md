# Implementation

- [x] 分支检查、用户授权、V1.4.3、Replay/进程证据与调用点排查。
- [x] 在共同自动启动准备中加入 `--no-daemon`，接通 SSH；桥接环境注入与安装健康检查解耦。
- [x] 测试本地各 shell、新建/恢复、供应商配置保留、SSH 和多终端 Hook 精确绑定。
- [x] node --test 定向测试；npx tsc --noEmit；npm run check:architecture -- --strict；git diff --check。
- [x] 更新 CLI Hook 契约、CHANGELOG V1.4.3 和功能清单。
- [x] 记录证据、检查结果和人工复现步骤；用户于 2026-10-09 确认修复完成并授权提交，保留工作区其他任务变更。

## Verification

- 78 个定向用例通过：codexHookIsolation、terminalHookBinding、codexAsyncQuestionHook、codexManualInput、resumeCliArgs、deepseekTuiRuntime；其中 10 个测试覆盖启动隔离和桥接环境策略。
- npx tsc --noEmit 通过。
- 严格架构检查：1291 个文件、0 超过 2000 行、0 新违规。
- git diff --check 通过；既有 manager.rs 的 Git LF/CRLF 提示不属于本次代码修改。
- GitNexus detect_changes 已执行，返回 low，但仅识别既有 PTY Rust 改动，未覆盖本次 TS 符号；以定向源码调用链审查补足，不将该结果视为 TS 风险证明。
- 原先 features list 返回 stable false 和关闭 Hook 的无输入 TUI 启动成功不足以证明隔离；用户实时复现推翻该方案，已更正为 `--no-daemon`。
- 真实正式版 Hook 可执行文件与两个隔离 loopback 接收端测试，每端只收到自身测试 tab/token 对应事件；未向真实应用发送通知。
- 独立 Codex 交互探测因 Windows 启动访问拒绝未完成，测试监听器已停止；不宣称完整 Codex→Hook→桌面 UI 验证。
- 首轮 Hook 修复仅改 TypeScript；统计跟进已修改 Rust 查询路由并完成编译/测试。IPC 签名与 UI 文案未变，无需修改翻译；项目无独立 lint 命令。

## Manual acceptance

按仓库 quality-guidelines.md，不启动 CLI-Manager 服务或桌面 App 做自动 UI 验证。
在新版本中新建 3 个终端（首个与第三个为 Codex），先让首个完成，再让第三个发起 request_user_input_async：首个保持绿色，第三个显示提问状态，通知查看应激活第三个。回答后只更新第三个。再检查同路径、分屏/另一个 Workspan、最小化、WSL 和 SSH。
正式版与开发版同时运行时，在更新后的开发版中新建终端，即使开发版由正式版终端启动，也应只向开发版回调；无需因安装路径不同反复重装 Hook。自动启动命令应含 `--no-daemon`，手工输入需自行传入，远端 CLI 也需支持此参数。
旧 PTY 仅重启 Codex 或重连 daemon 都不会刷新回调环境，必须新建终端再按需恢复会话。未结束任何用户已有 Codex/daemon/PTY。用户已确认实际使用场景修复完成并授权提交；不将此确认扩展为每种平台和窗口组合均已实测。

## Follow-up verification: realtime stats

- 用户已确认 Hook 通知正常；统计原始日志含 12 条消息、模型与 Token，空白由新会话查询等待全量 catalog 引起。
- 后端新模块 codex_lookup 在 catalog 调度之前处理单条 Codex UUID 查询，沿用原解析器与标题覆盖，保留来源根/项目/身份边界，不改 tokensBound。
- `cargo test history --lib`：266 通过，含 4 个新增直查回归；覆盖未索引日志的消息、输入/输出/缓存 Token、模型、上下文和趋势，以及错误身份、项目、重复、删除与查询边界。
- 首次 fixture 缺少累计 total_tokens 导致 Token 断言失败；按真实日志补齐后重跑全部上述测试通过，未为测试削弱解析逻辑。
- `cargo check` 通过；新增 Rust 模块 rustfmt 检查通过。
- 22 个前端回归通过：terminalStatsPanel、historySessionIdentity、terminalMarkdownPreview、terminalMarkdownPreviewNavigation。
- 严格架构检查：1293 个源码文件、0 超限、0 新违规；diff 检查通过。
- 本轮开发版后端重新编译启动后，原会话可重新打开统计/点击刷新验收，无需为统计修复重建会话。未自动启动服务或桌面 UI；真实 WSL/SSH 桌面统计未实测。
