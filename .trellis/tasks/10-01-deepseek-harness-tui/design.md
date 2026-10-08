# Design

## Boundaries
官方 DSH 拥有 Agent/profile/存储；dsh-TUI 拥有交互界面。正常安装实际只执行 `dsh-tui`/`dst`，会话选择交给原生界面；管理器保留明确 ID 恢复。旧源码/直接宿主命令仍兼容，仅这些旧入口保留受管理 bridge，不改用户 profile。下方 10-01 的过程记录由最新修复章节覆盖。

## Native startup root-cause fix (2026-10-02)
根因陈述：管理器在启动边界把针对外部源码链接的 React preload 无条件应用于普通安装 profile，令渲染器/TUI 与外部 usehooks-ts 依赖使用不同 React dispatcher，触发 `useRef` null 和宿主退出码 1；修复落在命令生成与预加载激活边界。

因果证据：使用用户实际普通目录 profile（0.12.0）、全局官方宿主（0.2.0-rc.2）、同一项目目录与隔离偏好，原正式 manager preload + bridge 精确复现 useRef 堆栈和安全模式提示；仅移除 preload 时真实 TUI 会话列表和合法 UUID 正常显示。未进入安全模式、安装插件、改写用户代码或发送模型提示。此前通过的隔离 profile 是链接本地源码，不能代表普通安装。

用户明确要求像 pi/codex 一样启动，因此普通 launcher 在执行时也保持 `dsh-tui`/`dst`：只读 preflight 后不挂载 bridge，不追加 preload 或清理环境的 Shell 脚本。保留用户环境与字面参数，明确 ID 仍经既有环境传递；默认新 UUID 不再自动采集。只读 IPC 增加 managerPatchPath 所有权提示，移除旧保存命令中本应用 cache 的保留 overlay，不创建文件或修改用户 patch。普通预检不再限定私有 registry/0.12.x；旧直接宿主 prepare 仍验证 bridge 兼容。React preload 仅允许外部源码链接；canonical profile 内的正常包及内部链接跳过。

发现清单（GitNexus 不可用，契约 + rg；共享 resolvePtyLaunch 入口风险较高，但行为改变限于 DSH）：
- resolvePtyLaunch 的本机与 SSH 分支：新建、分屏、Workspan、失效进程恢复、detached 启动共用；按 launcher/直接宿主区分。其他 CLI 分支确认不变，定向回归验证。
- deepseek_tui_preflight / inspect_profile：项目保存与启动共用，只读元数据检查解除 bridge 版本限制；ownership hint 不写 cache。prepare_launch / inspect_bridge：只用于旧直接宿主入口。
- isDeepSeekTuiLauncherCommand / stripDeepSeekTuiManagerPatch：单命令分类及旧 overlay 清理，保留用户 patch、-- 后 prompt 和显式恢复 ID。
- React resource：普通目录守卫与外部链接兼容闭包；真实 Node 测试覆盖 external hook package，不重写第三方源码。
- ConfigModal 与双语 messages：删除专属配置区，创建/编辑/克隆共用；只删除对应文案，旧 source env 保留。
- TerminalProcessManager / terminalStore / saveSessionToSidebar：现有显式 ID、环境与稳定命令持久化不需改动；默认无 bridge 自然不产生新 identity。
- PTY spawn/Windows PATH/daemon transport、history/provider/hook：确认无关，不修改。新旧进程差异在重新创建 DSH 时生效。

场景矩阵：普通安装、profile 内部依赖链接、外部源码链接；原生 launcher 与旧直接宿主；PowerShell/pwsh/CMD/Bash/zsh/sh/fish、WSL/SSH；空参数/用户 patch/-- 字面参数/已保存旧 cache patch；新会话/明确 ID/未知 ID/活 daemon attach/失效进程恢复；项目/Worktree/含空格 cwd；用户 NODE_OPTIONS 与恢复环境保留。窗口焦点、托盘、分屏、Workspan、UI 模式、hook 有无不参与命令分类和模块依赖身份；桌面交互与真实 guest 验收仍需独立记录，不以纯测试代替。

## Configuration follow-up (2026-10-02)
用户要求与其他 CLI 完全统一，移除 DSH 专属高级选项与源码选择组件。影响范围为 ConfigModal 的单一挂载点、仅此组件使用的中英文文案及说明；默认命令、预检、项目环境 JSON 和恢复协议不改写，旧源码配置保留兼容。GitNexus 不可用，编辑前按契约与符号引用完成范围检查。创建/修改/克隆、本机/WSL/SSH 和旧源码 env 场景均不再显示专属配置区。

## Native launcher simplification
用户要求常规命令直接 `dsh-tui`。沿用已授权 task/TEMP；安装版 descriptor/default builder 改为该原生启动器，prepare 不再展开 `dsh-tui`/`dst` 为直接宿主。源码高级入口与明确保存的旧宿主命令保持兼容。管理器 overlay 仍仅在执行时追加，stable metadata 不含 bridge 路径；不为命令显示而修改用户 profile 或安装包装命令。

GitNexus 无 callable，契约 + rg 影响检查：`buildDeepSeekTuiCommand`（projectStartupCommand/ConfigModal/restore）、`prepareDeepSeekTuiCommand`/`withDeepSeekTuiPatch`（native/guest launch）、`buildResumeCliArgs`（sidebar continue）、`buildResumeCommand`（无项目恢复 fallback）、`preflight::inspect`（两个 IPC→项目保存/native launch），中等风险，编辑前已向用户报告。跨层契约、DB 与 daemon 协议无新增字段。

场景：新建/旧项目/编辑/克隆、直接原生 `dsh-tui` 或 `dst`、高级源码模式、明确旧 `dsh --profile dsh-tui` 自定义命令、leading host patches/flag-shaped value、first app token/显式 literal separator、同目录并行/明确恢复、Windows PowerShell/CMD/Bash 与 WSL/SSH。原生 launcher 负责自己的 host/app boundary，管理器 patch 必须插在第一个 app token 之前；guest 保留原 launcher 与环境传输但不部署本机 bridge。源码模式不要求全局 launcher。窗口焦点/分屏/托盘/cwd/Worktree/hook 不改变命令解析；既有会话不被替换。

## Impact and discovery
GitNexus 无可调用工具，按 fix-triage-guide 使用契约 + rg 降级；不声称图谱 impact/detect 成功。
- CLI descriptor 与命令生成：项目下拉、sidebar/Tab 图标、startup consumers；中等。
- ConfigModal/API/i18n：创建编辑克隆、现有 env JSON；中等。
- Rust DeepSeek IPC：宿主/profile 只读校验与 launch patch；中等。
- terminalLaunch：local/WSL/SSH/default/custom startup/resume；中等。
- TerminalProcessManager：仅在 dedupe 之后旁路读取 bounded OSC，ACK/流控不变；中等。
- terminalStore restore/persist：较高风险，验证存活 attach、死进程/未知 ID、多 Tab ID 隔离。
- Web button/runtime/marker：确认移除所有产品触点。
- history/providers/hook 完成通知：本批不新增能力声明，确认无错误 Claude fallback。

## Scenario matrix
窗口当前/其他/失焦/托盘、sidebar mode/focus mode：保持既有终端展示与焦点 owner，不新增完成通知。
分屏当前/其他/深层、多 Tab、Workspan：PTY UUID 精确绑定，同 cwd 也不猜最近 ID。
PowerShell/Pwsh/CMD/Bash：命令 literal quote 与 TUI 输入；WSL/SSH 用自己的宿主及 profile，本机源码不映射 guest。
Worktree/.git 文件/目录缺失：cwd 复用既有逻辑；不把源码目录当项目 cwd。
Hook 装/没装/另一个 CLI：不借用其他 CLI 能力；DSH session bridge 独立。
旧 dsh 项目/旧 Web startup/自定义脚本、显式参数/字面 prompt separator、有效/无效 ID、profile 缺失/未构建：分别测试并记录边界。

## Native bridge compatibility
原生身份捕获使用 dsh-TUI 的内部 `lib/types/adapter/channel/host-registry.js`，读取 composition-root 的前台 Channel `.sessionId` 并订阅注册/状态变化；并非上游公开稳定 API。只读预检限定插件 0.12.x 和必要构建文件，不兼容时返回 `deepseek_tui_bridge_unsupported`，不调用 Agent 私有动作。Bridge 读取实际 `CLI_MANAGER_TAB_ID`，按 PTY 发 OSC UUID；缓存按代码内容寻址、原子写入，只保存管理器代码，不保存身份或凭据。
WSL/SSH 不注入本机 bridge、不做本机 profile 预检；明确的会话 UUID 可传递，guest 新会话身份暂不自动捕获，未知身份恢复为新会话。WSL 合并既有 WSLENV 转发恢复/home/Node 模式变量，保留用户 flag，不自动转换 profile 路径。
实机 TUI 渲染、输入/粘贴/缩放、Ctrl+C、双会话身份与重启恢复仍以验证记录中的实际结果为准；此设计不据单元测试宣称通过。

## Rollback
无 DB migration；env source key 保持，新增 bridge 文件受 appcache 管理。用户 profile 和官方/plugin 源码不改。

## Mixed global host / linked TUI rendering investigation
分诊为根因修复：DSH runtime module resolution 边界选择了全局 bundle 的 React peer，而 linked TUI 自己的 React dependency 仍来自本地，导致同一 React renderer/component/hooks 链持有两份 dispatcher。全局宿主和隔离宿主版本、入口字节及已比较的 416 个依赖 entry/version 对相同；不能用简单版本不匹配解释空白。

发现清单：官方 SDK `resolveBundleDir` 的 installation-anchor-first 保证内置 bundle 所有权；`routeLinked` 的 peer 路由将 usehooks-ts 的 caller 转成 global TUI/package.json declarer。前台 UUID 和 Ink render-return 已完成，故不是管理器 OSC、TTY 查询、settingsReady 或 PTY 输出消费造成初始化等待。晚注册/仅 bare React 的探针未恢复 UI，并显露 useRef null；必须验证整个 React 包出口及该 declarer 边界，不能把两个对象相同直接当作界面验收。

GitNexus 无 callable，契约 + rg 的预编辑影响范围：`launch::prepare_patch`/`DeepSeekTuiLaunchInfo`（两个 DeepSeek IPC 与 immutable cache，风险中等）、`resolvePtyLaunch`（本机默认/自定义/源码/恢复启动；共享入口风险较高但改变仅限 native DSH 分支）、`preflight::inspect`（只读宿主/profile 校验）、manager-owned resource 与 opt-in ConPTY tests。命令/UUID持久化、history/providers、PTY transport、daemon protocol 与 Windows PATH 已确认无需修改。

场景：全局安装/隔离安装/源码宿主，profile 普通目录/链接本地源码，React development/production，用户已有 NODE_OPTIONS（含其他 preload），路径含空格/编码字符，新建/恢复/同目录并行，PowerShell/pwsh/CMD/Bash 与 guest WSL/SSH。修复只能作用于原生 DSH 运行时：不修改用户安装、profile 或第三方源码，不改变内置 bundle 优先级；guest 不注入本机路径。窗口焦点/托盘/分屏/Workspan、Worktree 与 hook 有无不改变进程内模块身份；既有进程需重新启动后才能加载新解析逻辑。纯诊断源码 instrumentation 不得进入产品或用于最终 smoke 验收。

单变量因果结果：只统一整个 React 包解析闭包（react / jsx-runtime / jsx-dev-runtime / compiler-runtime，并包含 SDK declarer anchor）便恢复 global+linked fixture 的真实帮助正文和 UUID；对齐 profile React、对齐实际 host-bundle React 两方向均恢复，均不再 useRef null。选择 host-owned 方向以保留 SDK 已有 shared peer 所有权：只将 linked TUI 自己偏离的 React 引用归一，不替换 SDK 选择的内置 bundle。manager preload 原样调用 nextLoad，不改写第三方源码、不输出诊断；只在带合法管理器 Tab UUID 的实际 DSH host 子进程初始化，其他 Node 入口不读取 profile、不注册 hook。

接线：IPC 返回 immutable preload file URL 与 CMD batch 路径。前端 `withDeepSeekTuiPreload` 在执行范围读取真实 shell NODE_OPTIONS，并退出恢复；`getDeepSeekTuiLaunchSessionId` 两个 store callers 从 stable metadata 判定身份（中等风险，已有恢复测试覆盖），不解析临时脚本块。普通 CLI 和 WSL/SSH 不包装；NODE_OPTIONS 不覆盖到整 PTY。CMD fresh resume 清理在 wrapper 外，保证 batch 收到真正 TUI command，不让 `&` 将启动拆到作用域之外。

特殊路径：file URL 的 `!` 显式编码为 `%21`，再将 batch 中 `%` 转为 `%%`；template 注释/内容进 hash，避免转义协议升级后复用旧不可变文件。原用户 flags 只经 delayed expansion 取值，不被拼进缓存或重新解释成 shell 代码；调用原命令前禁用 delayed expansion，保留参数中的 `!`。

## Configuration UI refinement
用户明确要求与其他 CLI 统一。仅展示层调整：原生安装版的源码配置在环境变量之后的 advanced details 中默认收起；已有 root 在编辑/克隆时展开，折叠摘要保留 active 提示，guest 无 root 不展示。展开/折叠不修改 env JSON 或启动协议；旧 guest root 保留清除入口；无效 JSON 仍交给既有校验。GitNexus 无 callable，按契约+符号定位：DeepSeekHarnessFields 单一 ConfigModal caller，影响创建/编辑/克隆，风险低；不触及 PTY/backend/store。沿用本 task 与 TEMP 记录。

## Windows Conda PATH root-cause fix
分诊为根因修复：故障在 daemon → Windows 子进程的环境构造边界；刷新 PATH 的 fresh-first 顺序打散已激活的 Conda 前缀目录，PowerShell profile 重激活时按首尾前缀删除连续区间，连带删除其中的 npm。修复落在 `merge_windows_path`，保持父进程顺序并追加新目录，不为 DSH 硬编码 npm 路径。

发现清单（GitNexus 无 callable，使用 PTY daemon 契约 + rg）：
- `windows::spawn` → `build_environment_block` → `merge_environment` → `merge_windows_path`：唯一行为修改入口，所有 Windows 本机新 PTY 中等风险；已向用户说明范围。
- `current_user_environment`：仍使用当前用户 token 刷新，逻辑未修改。sandbox HKCU 不等于 jackie；真实用户验证在授权的 user context 完成。
- PowerShell profile / Conda activate：触发误删的消费者，仅用于只读复现；不修改用户 profile 或全局安装。
- project launch env / provider / hook：显式 PATH 最后整值覆盖，非 PATH 变量刷新优先级保留；不是启动参数、resume bridge 或保存命令的错误。
- ConfigModal / projectStartupCommand / TerminalProcessManager：正常项目 env 传递已确认，无需增加 DSH 专用环境补丁；sidebar 普通 shell 的行为无关。
- daemon 复用：既有 PTY 环境不会被代码修改，必须新建进程；当前开发 watcher 已重建 app/daemon，旧 daemon 死亡，新 daemon 14:11:30 启动。

场景：Conda 已激活/未激活、刷新新增工具目录、大小写等价/空 PATH 项、显式项目 PATH、刷新失败回退、PowerShell/pwsh/CMD/Git Bash/Windows WSL 宿主均沿同一本机环境入口；远端 SSH/Linux guest PATH 不在此修改内。窗口焦点/托盘/分屏/Workspan、cwd/Worktree、hook 有无不参与环境顺序判断；创建新 PTY 生效，存活进程保留自身环境。验证真实 PowerShell + Conda 触发路径，其他 shell 的独立手工验证不据此宣称通过。
