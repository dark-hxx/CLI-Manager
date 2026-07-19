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
