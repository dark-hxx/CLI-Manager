# 验证与交付边界

## 已完成的验证

- 本轮失败假会话与精确恢复回归：Web conversation 10/10；服务端 conversation 专项 3/3、全量 43/43；Tauri Web conversation 14 项通过、1 项环境测试忽略；直接启动参数 4/4。
- 本轮大型主库写锁回归：usage schema 3/3、request log 8/8，覆盖健康 Schema 不重放一次性回填、按 request ID 主键替换与缺失文件清理；现场数据库查询计划确认不再扫描全部 session usage rows。
- 本轮构建检查：`npm run web:typecheck`、`npm run web:build`、`npm run build`、apps/server 与 src-tauri `cargo check` 均通过；`git diff --check` 无 whitespace error。src-tauri 全库 fmt check 仍仅被本轮开始前已有的 `src-tauri/src/provider/database.rs` 单行格式阻断，本轮 Rust 文件符合 rustfmt。
- 服务端 40 项测试通过：正文事件事务/去重、设备与用户隔离、绑定迁移隔离、单次票据/过期/撤销、设备身份认证、状态 ACK 重放。
- 共享协议 6 项测试通过。
- 最终 `cargo test --manifest-path src-tauri/Cargo.toml --lib web_`：29 项通过，1 项环境依赖测试默认忽略；覆盖运行时、设备、精确序号 ACK、可靠发送队列和 daemon v2 握手。
- 环境依赖测试另行显式执行通过：裸 `codex` / `claude` 经运行时共用解析器找到 Windows 启动器并实际执行 `--version`。
- 桌面 TypeScript 检查通过；直接 CLI 启动参数 3 项测试通过。
- 真实本机 Codex app-server 两轮只读冒烟通过：initialize、首轮增量与最终正文、退出进程后恢复同一 thread、第二轮保留上下文。使用现有 Provider，不改用户配置。
- 新生成的 release `cli-manager-codex-proxy.exe` 再次执行 `scripts/webConversationRuntime.smoke.mjs` 通过：initialized/streamed/resumedInNewProcess 均为 true、turns=2；不是仅依赖旧 debug 程序的结果。
- Web 7 项测试及生产构建通过。390×844 浏览器模拟检查通过：两轮消息不重复、项目切换隔离、中英文切换、无横向溢出、受限账号控制隐藏；这是模拟接口 UI 检查，不是物理手机端到端测试。

## 范围及限制

- 本轮未再次调用真实外部 Provider：`scripts/webConversationRuntime.smoke.mjs` 因未设置 `CLI_MANAGER_TEST_CODEX` 按设计立即退出，未访问外部服务或修改用户配置；17:29 版曾通过真实两轮 Codex 冒烟，本轮新增逻辑由本地协议、服务端、数据库及构建测试覆盖。
- CLI 执行与回复消费由 Rust 后台管理，启动后不依赖 Hook、终端渲染或 React 计时器。Web 请求的项目解析与入口分发仍使用已加载的桌面工作区桥。
- Codex 支持原生桌面审批；Claude 结构化 print 模式若需要无法交互的工具授权，返回明确失败，不绕过权限。Web 不支持 TUI 专用的 yolo/full-auto 启动参数；需要使用普通启动命令和可用的 CLI 配置。
- 真实 Codex 协议测试通过，但尚未在物理手机上端到端测试整个新安装版。Claude/WSL、桌面最小化/多窗口及原生审批交互未做完整人工验收；WSL 不支持的 Windows 配置路径明确拒绝。
- 手机二维码要求已配对设备配置可达 HTTPS 地址；本机内嵌服务仍只绑定回环，不包含公网隧道部署或防火墙开放。
- 历史正文只同步用户主动选择的会话，并只同步 user/assistant text；不上传工具参数。服务端缓存当前没有自动清理期限。
- 旧版本 daemon 没有原子空闲关闭协议；安装测试前应退出旧桌面应用。新版检测旧协议并在无待处理操作时替换，忙碌则明确拒绝。

## 数据升级与回滚

- 新增 migration 0006（消息/手机授权）与 0007（状态重放证据）；服务启动自动迁移，属于新增表/字段。
- 更新独立部署的 Web 服务时，应先停服务并备份其数据目录的 SQLite 数据库（含一致的 WAL 检查点或整个停止后的数据目录），再启动新版服务。桌面内嵌 Web 服务随安装包更新。
- 旧服务不认识新消息帧。桌面与独立服务需一起升级；回滚须同时恢复旧程序和升级前的数据库备份，不删除迁移记录来伪装兼容。
- 本次不推送远程、不安装到生产环境。安装包为本地测试 NSIS，使用已有 local bundle 配置关闭自动更新签名产物。

## 打包复现

- 本轮根因修复包于 2026-09-08 19:32:08 生成：`src-tauri/target/release/bundle/nsis/CLI-Manager_1.3.9_x64-setup.exe`，25,674,389 字节，SHA-256 `9D7D8B578ADD8FED437937CB8A351E0D931DEFB6E6DDCE09AFF501AF07B48C78`。完整 `tauri:build:local -- --bundles nsis` 退出码 0；release 目录中的 codex-proxy、PTY daemon、Web daemon 均在本轮重新编译，Tauri 多 bin 封装配置保持生效。
- 命令：`npm run tauri:build:local -- --bundles nsis`，版本沿用 1.3.9。
- 首次打包前端通过，但 Windows 资源编译器 `rc.exe` 不在当前 PATH，Rust build script 失败。仅给重试进程 PATH 前置 `C:\Program Files (x86)\Windows Kits\10\bin\10.0.22621.0\x64`，不修改系统配置或源码。
- 重试成功：桌面/Web 生产构建、Rust release、NSIS 封装均完成（退出码 0）。最终安装包 `src-tauri/target/release/bundle/nsis/CLI-Manager_1.3.9_x64-setup.exe`，25,665,691 字节，2026-09-08 15:23:38（本机时间）。
- 产物审查发现自动二进制发现仅封装 codex-proxy：在 Cargo.toml 显式声明同路径的四个 bin 目标后，运行 `npm run tauri -- bundle --bundles nsis --config src-tauri/tauri.local.conf.json` 重新封装成功。未改动已编译源码；最终 installer.nsi 第 637–639 行确认纳入全部三个后台程序。
- SHA-256：`0F874CB035272E714A54C4928B724BFA2CCCE74EAFBF1C4D40AA72506BB0F786`。发布目录的主程序、daemon、web-daemon、codex-proxy 均为本次新编译产物；安装脚本引用本次 Web 资源。

## 安装验收回归（15:35）

根因陈述：Provider profile 的写入使用应用 Provider Home 解析出的 Codex 配置目录，但 Web 运行时复用的 profile 读取器只接受进程环境变量 `CODEX_HOME`，桌面安装版没有该变量时在跨模块边界错误失败；项目错开则是侧栏与顶部同时暴露上下文切换，快捷启动未同步对话上下文，消息发送仍读取旧选择。修复落在 profile 路径解析源头和 Web 上下文状态入口。

发现清单：

- `codex_app_server_proxy::load_codex_profile_overrides`：已修复，优先显式 `CODEX_HOME`，缺失时使用桌面 Provider Home 的 Codex 目录。
- `provider::scope::prepare` / `write_codex_profile`：已确认写入路径正确，不增加兜底或重复写入。
- `useAppModel::selectedProjectContext`：已修复，以侧栏维护的 context key 为唯一选择，不再由旧 session 隐式使其失效。
- `ProjectTree::submitStart`：已修复，项目/Worktree 快捷启动先同步对话上下文；group 启动没有唯一上下文，保持不切换。
- `Workbench` 顶部上下文：已改为只读展示，移除重复下拉。
- 服务端 operation/context 校验、桌面 canonical path 校验、历史绑定：确认继续作为安全边界，无需修改。

场景检查：普通项目/Worktree 的点击和快捷启动会同步；历史选择仍反向同步项目上下文；group/多选启动不猜测单一项目；窗口焦点、最小化、分屏、Hook 安装状态不参与浏览器选择状态。Local 项目使用桌面 Provider Home；WSL 的已知配置路径限制保持不变；SSH 对话仍明确不支持。

回归验证：新增 Provider Home fallback 单测通过；Web 对话/启动参数共 11 项测试通过；Web typecheck、Web production build、桌面 production build、Rust Web 专项 29 项均通过。最终 release 代理真实两轮 Codex 冒烟再次通过（流式输出、跨进程恢复、上下文保留）。

回归安装包：`src-tauri/target/release/bundle/nsis/CLI-Manager_1.3.9_x64-setup.exe`，25,664,497 字节，2026-09-08 16:15:03（本机时间）；SHA-256 `80A4C0EA8C6C4487EB5E10AAA66CE10231F9F23AF7A2958A1B962A20B265C7F8`。NSIS 清单确认包含 codex-proxy、PTY daemon、Web daemon。本轮未在用户浏览器里代替用户执行最终人工点击验收。

## 安装验收回归（17:30）

根因陈述：现场 `test` 项目的 `cli_args` 为 `resume 019fc591-8a0b-7872-95b5-49c591ed4db1`。旧链路把该终端子命令原样放到 `app-server` 前，实际执行成 Codex TUI；无 TTY 子进程因此在 initialize 前退出。现场 Web 服务在短时间内多次重启，而旧停止逻辑只轮询两秒且没有保存/等待线程句柄；活跃 WebSocket 会让旧 router 与 SQLite pool 继续存活，新服务重开同一数据库后形成跨 pool 写锁竞争。会话事件又使用先读后写的 deferred transaction，并发状态写可使事务升级触发 `SQLITE_BUSY_SNAPSHOT`。

发现与修复：

- 前端启动解析与 Rust 执行边界都会剥离 Codex/Claude 终端恢复选择器；新建/恢复只由已校验 operation 的 `sessionId` 决定。
- CLI stderr 改为最多捕获 32 KiB，仅映射成稳定诊断码，不返回 Prompt、回复、URL、路径或凭据原文。
- 托管 Web server 保存线程句柄；start/stop 在同一 runtime 锁下串行，stop 等待旧线程退出。服务端 graceful shutdown 最多两秒，随后关闭仍活跃连接，使旧 SQLite pool 确定释放后才允许重启。
- conversation event 在校验读取前使用 `BEGIN IMMEDIATE` 预留 SQLite writer，避免 deferred transaction 读取旧快照后升级失败。
- 主数据库 `cli-manager.db` 与 Web 数据库 `web-server.db` 已区分；本轮只修改后者的服务生命周期和会话写事务，没有把桌面历史库的慢写问题混入该修复。

回归验证：服务端 42 项、共享协议 6 项、Rust Web 专项 31 项通过（另 1 项环境测试默认忽略）；Web/桌面 TypeScript 与两个生产构建通过；启动参数 4 项、并发 writer 和活跃连接 shutdown 回归通过。debug 与最终 release Codex proxy 均完成真实两轮只读冒烟，覆盖 initialize、流式正文、跨进程 thread/resume。`git diff --check` 通过；`apps/server` fmt check 通过，`src-tauri` 全库 fmt check 仅被既有 `provider/database.rs` 单行断言格式阻断，本轮文件已由 rustfmt 格式化。

最终安装包：`src-tauri/target/release/bundle/nsis/CLI-Manager_1.3.9_x64-setup.exe`，25,670,405 字节，2026-09-08 17:29:30（本机时间）；SHA-256 `18B6ADCF8FC9AC3130E8C38589EB9EB278004C7B29F9CEECCE364C35ACCC2FA5`。NSIS `installer.nsi` 第 637–639 行确认包含 codex-proxy、PTY daemon、Web daemon。
## Web 真实 PTY 终端交付（22:39）

根因陈述：问题位于 Web 展示层与桌面 PTY 的跨边界设计，旧主流程消费结构化 conversation 事件并渲染聊天卡片，不能保证呈现 CLI 的原始 TUI 输出；连接故障另位于内嵌服务启动就绪边界，线程创建即报告 running 且 bind 前已触碰存储。修复落在真实 PTY 传输协议、桌面 bridge、浏览器 xterm 和服务生命周期源头，不在卡片组件或浏览器重试处增加兜底。

发现清单：

- crates/web-protocol、apps/server/src/ws.rs：新增并验证 terminal attach/detach/input/resize/output/status 帧；设备归属、移动 scope、Session ID、输入大小和 resize 范围已覆盖。
- src-tauri/src/web_daemon.rs、commands/web_device.rs：daemon 与非 daemon 兼容路径均接入有界终端命令队列，local daemon 协议升至 3，旧 1/2 协议升级可回收。
- src/hooks/useWebDeviceBridge.ts：复用现有 TerminalProcessManager / PtyHostSocket，16ms 合并输出，PTY replay reset 转为 xterm reset；不创建第二套 CLI 进程。
- apps/web/src/WebTerminal.tsx、views.tsx、useAppModel.ts：主工作区替换为 xterm，按项目启动结果中的 PTY ID attach，输入/resize 双向转发；项目、设备、主机页和登录状态切换时 detach。
- apps/server/src/lib.rs、commands/web_server.rs：先 bind 再打开存储和更新设备状态，完整初始化后才置 running，失败/20 秒未就绪会回收线程。
- 历史会话、文件/Git 管理、Provider、主数据库 usage schema：确认不属于真实终端数据面，本轮不扩展修改；既有结构化会话数据仍可保留，但不再由 Web 主界面自动导入或渲染。

验证结果：

- npm run web:typecheck、npm run web:build、npm run build：通过。
- cargo test --manifest-path crates/web-protocol/Cargo.toml：7/7 通过，含终端帧 serde round-trip。
- cargo test --manifest-path apps/server/Cargo.toml：45/45 通过，含终端 scope/边界及 bind 失败无数据库副作用。
- cargo check --manifest-path src-tauri/Cargo.toml：通过；cargo test --manifest-path src-tauri/Cargo.toml --lib web_ 初跑 30/31 通过、1 项环境测试忽略，唯一失败为测试写死 local daemon 旧版本 2；改为跟随 PROTOCOL_VERSION 后聚焦复测通过。
- node apps/web/src/conversation.test.mjs：10/10 通过；git diff --check 无 whitespace error，仅有仓库现有 CRLF 提示。
- codebase-memory moderate 索引已刷新；detect_changes(compare master) 因当前长期功能分支相对 master 包含大量既有变化而输出噪声，未报告额外 impacted symbols，最终范围继续以本轮触点 diff、契约和上述构建/测试界定。

交付边界：自动化已覆盖协议、认证范围、服务生命周期、类型和构建；没有替用户安装新包，因此尚未在物理手机和当前真实 Provider 上执行新安装版的键入、Ctrl+C、审批、刷新重连与桌面/Web 同屏人工验收。当前实现交付单个活动 Web 终端；多 PTY 标签列表和多端输入/resize 控制权仲裁留作后续增强。

打包结果：src-tauri/target/release/bundle/nsis/CLI-Manager_1.3.9_x64-setup.exe，25,819,538 字节，2026-09-08 23:05:07，SHA-256 340503EFC01BFE14D1BFB026B859E6CF62D5D239712C3324DD981CD765B5210C。NSIS installer.nsi 第 637-639 行确认包含 codex proxy、PTY daemon 和 Web daemon；主程序及三个后台 release 二进制均为本轮新编译产物。最终重打包已包含异步项目启动防串上下文与防重复提交检查，打包命令退出码 0。
