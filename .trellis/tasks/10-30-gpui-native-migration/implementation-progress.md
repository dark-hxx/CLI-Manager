# 实施记录（2026-10-31）

- Windows 独立 WebView PoC 已完成真实窗口冒烟：child WebView 创建约 399.804ms，Markdown/HTML/PDF 三路协议导航、隐藏/恢复、逻辑到物理 bounds 更新和三张窗口截图均成功，PDF.js 页面截图可见。证据记录于 `research/windows-webview-smoke-2026-10-31.md`；该结果不覆盖产品 GPUI 窗口的焦点、DPI、Airspace、IME 和后代进程回收，因此 PreviewHost 总体验收仍未闭环。
- 修复 Windows `PreviewLifecycle.ps1` 调用不存在的 `GetWindowRect` 方法，改用已公开的 DPI 感知矩形接口；生命周期验证工具现在具备执行缩放、最小化恢复和后代进程回收检查的前置条件。
- Windows PreviewLifecycle 真实验证通过：窗口缩放与恢复保持 `983 × 822`，最小化/恢复成功；观察到 9 个 WebView2/conhost 后代进程，GUI 退出后 253ms 内全部退出且 10 秒窗口内无残留。跨显示器 DPI、焦点、Airspace 和产品壳六状态矩阵仍未闭环，原始证据见 `research/windows-webview-lifecycle-2026-10-31.md`。
- PreviewHost Airspace 新增 `OverlayRegistry`：维护活动浮层矩形并按实际预览槽位执行正面积相交判定；当前模态状态先注册窗口级保守矩形，后续可由具体浮层 prepaint bounds 替换，已补相交边界与替换回归测试。
- 本批 Airspace 验证：GPUI 108 项、Preview 15 项测试全部通过；严格架构检查为 1557 个源文件、0 个超限、0 个新增违规。测试启动仍输出已知 Windows `runtime error R6016`，最终退出码为 0。
- 按父 Design §9 建立 `functional-alignment.md` 功能对齐矩阵，逐项区分已接入核心路径、部分完成和未完成，补充代码入口、验证证据与下一步，后续以该矩阵驱动剩余迁移。
- GPUI 统计域开始接入：新增原生统计摘要页，复用历史状态计算会话数、消息数、Claude/Codex 来源数和收藏数，提供中英文入口；完整趋势图、Token、请求日志和跨项目筛选仍待实现。
- 统计摘要收口验证：GPUI 统计定向测试通过；严格架构检查恢复为 1558 个源文件、0 个超限、0 个新增违规。`main.rs` 新增状态已拆入 `settings_host.rs`，未通过压缩长行绕过文件长度约束。
- 统计页继续扩展：增加最近 7 天会话活动柱状图与 Claude/Codex 来源构成条，仍使用原生 GPUI 绘制；完整 Token 趋势、项目效率、请求日志和筛选联动仍待实现。
- 统计活动图补齐双语日期标签，活动分桶抽为可测试函数，覆盖今天、历史第 1 天、七天外与未来时间边界。
- GPUI 历史行接入 `history-core` 会话摘要的输入、输出及缓存 Token，统计页新增三项 Token 摘要卡片；Token 日趋势和完整构成图仍待实现。
- 统计页新增最近 7 天输入/输出 Token 双序列趋势图，复用历史行更新时间和 Token 字段；项目效率、请求日志和筛选联动仍待实现。
- GPUI 统计页接入 `core-db::ProjectRepo::request_log_summary`，按当前项目只读读取共用 `request_logs` 请求数；请求日志明细、来源/模型分组和跨项目筛选仍待实现。
- 请求日志聚合增加真实 SQLite 回归：当前项目只汇总匹配项目键的记录，不包含其它项目，并校验输入/输出/缓存 Token 字段。
- 请求日志统计新增来源/模型分组查询，GPUI 展示前 6 个构成项；明细列表、项目效率和筛选联动仍待实现。
- 请求日志聚合修复 Windows 路径边界：统一反斜杠为正斜杠后仅匹配项目自身或 `project/` 子路径，补充 `C:/project2` 与 `C:/project2x` 不串入回归；构成卡片补充请求数、输入 Token、输出 Token。统计域仍为部分完成，明细列表、项目效率和筛选联动未实现。
- GPUI 统计页接入当前项目最近 50 条请求明细，展示来源、模型及输入/输出 Token；项目效率和筛选联动仍未实现。
- GPUI 统计页接入 `usage_records` 项目效率摘要，展示请求数、完成数、Token 总量和平均耗时；筛选联动仍未实现。
- GPUI 统计页接入 Claude/Codex/全部来源与全部/近 7 天/近 30 天筛选，历史摘要及四类请求数据均随筛选刷新；更复杂的跨项目筛选仍未实现。
- GPUI 统计页增加全部项目与具体项目筛选，请求聚合、明细和效率统计支持空项目键表示全项目范围；真实窗口筛选交互仍需手测。
- GPUI 统计页的全部项目筛选已接入独立历史扫描，历史会话摘要和趋势使用全部项目会话集合；统计页真实窗口刷新与大历史库性能仍需手测。
- GPUI 开始接入扩展域：新增只读 MCP/Skill/部署实例概览和侧栏入口，暂不包含编辑、导入、部署、卸载与策略操作。

- PreviewHost 焦点与快捷键桥接已接入：wry child WebView 注册 IPC handler，按当前 GPUI Keymap 注入捕获脚本；IPC 事件在 250ms 宿主任务中解析并分发命令面板、分屏、关闭 Pane、历史、复制、分割调整动作，Esc 调回终端焦点。wry Windows 目标编译、Preview/GPUI 测试通过；真实 WebView 页面和 Alt+Tab 平台手测仍待完成。
- PreviewHost 自定义协议继续实施：wry 平台层注册 `climgr-preview://app/markdown/` 路由，提供最小预览壳、CSP 和未知路由 404；导航只允许内部协议、Windows 协议映射来源与 `about:blank`。项目文件 token、图片/PDF Range 资源路由和真实平台导航手测仍待完成。
- 预览资源服务继续实施：`AssetRegistry` 已按项目根 token 读取白名单文件，并为注册 PDF 提供单区间 `206` 响应、`Content-Range` 和 MIME；wry 协议闭包已接入该服务，测试增至 15 项。GPUI 当前创建路径尚未把真实项目根 token 注册进去，符号链接/平台手测仍待完成。
- GPUI 预览创建路径已注册当前文件树项目根为 `project` token，并把资源注册表传入原生 WebView；HTML 源码预览自动注入 `climgr-preview://file/project/<relative-path>/` base，项目内相对资源具备实际解析入口。真实窗口资源加载和平台手测仍待完成。
- PDF 预览入口已接入：打开 PDF 时保留外部降级状态，同时注册 `current` PDF token 并尝试创建/导航原生 WebView；切换 PDF 时重建宿主以更新闭包中的资源注册表。协议不可用时继续使用系统默认应用打开。真实 PDF 页面渲染、Range 请求和平台手测仍待完成。
- 本批收口验证：GPUI 106 项、Preview 15 项测试通过；Preview Windows 目标编译通过；严格架构检查为 1556 个源文件、0 个超限、0 个新增违规。测试启动仍输出已知 Windows `runtime error R6016`，最终退出码为 0。
- 预览链接行为继续收口：Keymap 生成的初始化脚本捕获外部 `http/https/mailto/file/ssh` 链接并发送 `openLink` IPC，GPUI 复用已有协议白名单的系统打开函数；`climgr-preview` 内部链接不被拦截。真实页面点击和平台浏览器手测仍待完成。
- 本批验证：`cargo test -p cli-manager-preview -p cli-manager-desktop-gpui -j 2` 共 106 项 GPUI 测试与 14 项 Preview 测试通过；`cargo check -p cli-manager-preview --target x86_64-pc-windows-msvc` 通过；严格架构检查恢复为 1556 个源文件、0 个超限、0 个新增违规。测试启动仍输出已知 Windows `runtime error R6016`，最终退出码为 0。
- PreviewHost 桥接协议继续收口：`cli-manager-preview` 新增 `BridgeEvent`/`ShortcutEvent` 强类型解析，校验 `ready`、`error`、`openLink`、`copy`、`shortcut` 的 payload 字段、布尔修饰键和可选按键值；预览协议测试增至 14 项。
- GPUI 预览窗口接线继续实施：`DesktopShell` 现在观察窗口 bounds、DPI、显示器变化和可见性，并把物理 `HostBounds` 同步到 `PreviewController`；打开 Markdown/HTML 文件时启动 PreviewHost 生命周期，切换项目时关闭旧实例。Windows/macOS 平台适配改为创建 child WebView，并补齐 bounds 与 HTML 加载接口。真实 WebView 控件命令执行、Airspace 遮挡和手动平台矩阵仍待完成。
- PreviewHost 命令执行继续收口：GPUI 壳现在持有原生 WebView 实例并消费 `Create`、`Navigate`、`RenderHtml`、`SetBounds`、`SetVisible`、`Dispose`；HTML 直接加载内容，Markdown 走可读源码 HTML，平台错误会转入失败状态。自定义协议资源、Airspace/焦点桥接和真实平台手测仍待完成。
- PreviewHost 回收继续收口：GPUI 窗口异步任务每 250ms 驱动 `PreviewController::tick`，隐藏超过 60 秒会消费 `Dispose` 并释放原生 WebView，窗口实体失效时任务退出。真实进程列表与平台手测仍待完成。
- PreviewHost Airspace 几何继续收口：文件预览槽位通过 `on_children_prepainted` 提供实际 GPUI bounds，按窗口 scale factor 转换成物理 bounds 后更新 WebView；已避免使用整窗 bounds 覆盖终端、Git 和编辑器区域。浮层相交时截图占位、焦点和快捷键桥接仍待完成。
- PreviewHost Airspace 浮层处理继续收口：当前 GPUI 设置、命令面板、退出/恢复确认、文件操作、Git 操作和 Worktree 对话框打开时自动隐藏 WebView，关闭后恢复；统一 OverlayRegistry、截图占位和焦点/快捷键桥接仍待完成。
- 本批验证：`cargo check -p cli-manager-preview -p cli-manager-desktop-gpui` 通过；`cargo test -p cli-manager-preview -p cli-manager-desktop-gpui -j 2` 共 105 项 GPUI 测试与 13 项 Preview 测试通过。Windows 测试仍输出已知 `runtime error R6016`，最终退出码为 0。
- PreviewHost 命令契约新增物理 bounds 与缩放因子，重复 bounds 不再重复发送；创建中、显示中和隐藏中的 WebView 均可接收尺寸/DPI 变化。GPUI `Window` 的 bounds 观察、真实平台 `set_bounds`、跨 DPI 手测仍待接线。
- `cli-manager-preview` 新增 Windows/macOS wry 平台适配模块：通过宿主窗口句柄创建原生 WebView，并提供 URL 导航和显示/隐藏操作；Linux 只暴露 Unsupported 实现。当前 GPUI `Window` 句柄接线、bounds/DPI/Airspace 和真实窗口手测仍待完成。
- PreviewHost 状态机新增平台命令队列：首次打开产生 `Create`，同窗口切换产生 `Navigate`，隐藏/恢复产生可见性命令，超时或 60 秒闲置产生 `Dispose`；新增实例复用和生命周期命令回归测试。真实 Windows/macOS WebView 控件仍待接入。
- 预览控制器补齐可用性查询、用户禁用/恢复和失败后重试接口；新增六类 WebView 状态 × Markdown/HTML/PDF 的自动化决策矩阵测试，确认不可用时始终保留可用降级路径。真实平台控件和手动 6×3 矩阵仍未宣称完成。
- 预览核心新增 `resolve_local_asset`：对 Markdown 相对图片先做百分号解码，再验证文档目录与项目根边界，拒绝 `%2e%2e`、绝对路径、远程 URI、查询串绕过和敏感文件；`cli-manager-preview` 测试增至 11 项。
- GPUI 原生 Markdown 降级路径补充公式源码块提示，并对普通链接和本地图片语法做可读文本归一化；新增公式、链接和图片解析回归测试。当前仍未把链接点击、项目内图片位图加载和公式排版误记为完成。
- GPUI 原生 Markdown 预览新增 GFM 表格：解析表头、对齐分隔行、数据行和空单元格，支持左/中/右/默认四种对齐标记与反斜杠转义竖线；fenced code 中的竖线不会触发表格识别，新增前后段落、代码块和表格边界回归测试。
- GPUI 文件预览补齐 HTML/HTM 外部打开：源码降级内容仍保留，点击操作调用系统默认应用；PDF、HTML、HTM 共用扩展名白名单并通过统一路径边界，新增回归测试。
- GPUI 设置修复深色主题持久化读取：`save_theme` 写入的 `dark` 值现在由启动加载恢复，新增共享设置回归测试。
- GPUI 冲突解决器完成逐文件暂存闭环：暂存成功后重新读取剩余冲突列表并加载下一文件，全部解决后清理面板；双文件真实临时仓库回归覆盖剩余冲突与草稿恢复。
- GPUI 冲突解决器按冲突路径保存编辑草稿：切换文件前从原生编辑器回读内容，重新打开时恢复对应草稿，成功写回并暂存后清理；场景覆盖多文件切换、当前文件编辑和真实 Git stage 流程，仍未宣称完整冲突工作区验收。
- GPUI 冲突解决器补齐冲突文件列表：通过 `git ls-files -u -z` 去重读取所有未解决路径，左侧列表支持选择并重新加载基线、当前分支、传入变更和合并结果；新增临时冲突仓库列表回归测试。`cargo check` 与 GPUI 99 项测试通过。
- 历史域开始落地共享增量读取基础：`cli-manager-history-core` 新增 `TailState`、`TailUpdate` 和 `TailLine`，按文件偏移读取新增字节，缓存未完成尾行，识别截断/替换并重置，坏 JSON 行由上层解析时跳过而不影响后续行；新增 4 项临时文件回归测试。
- 本批历史增量读取验证：`cargo test -p cli-manager-history-core -j 2` 共 13 项通过；GitNexus 对现有 `parse_detail` 影响为 MEDIUM、`apply_jsonl_line` 为 LOW，索引落后 74 个提交，新模块以源码搜索和定向测试补充确认。
- 历史核心继续新增 `TranscriptWatcher`：同一目录只注册一个 notify watcher，文件变化通过 tokio channel 合并后按各自 `TailState` 增量读取；支持先注册不存在文件、文件出现后首次读取和多文件批量刷新。定向测试增至 15 项；Tauri 现有 live transcript 线程模型尚未切换，P5 整体验收仍未完成。
- Tauri `live_transcript.rs` 已切换到共享 watcher：进程内只启动一个 tokio 监听任务，按路径聚合订阅并执行租约清理，删除原先每个 Entry 一个 `std::thread` + `recv_timeout` 的模型；通知订阅使用只返回变化路径的 API，避免与历史 Reader 重复读取正文，GPUI 历史 UI、首次扫描并发上限及 20 文件/300ms 实测仍待完成。
- GPUI 新增 `history` 模块和侧栏入口：按当前项目后台扫描 Claude/Codex JSONL，复用 `history-core::parse_detail` 生成标题、来源、更新时间、消息数和会话 ID，支持来源过滤、查询状态和最多 200 条可见结果；详情、虚拟滚动、取消搜索、收藏/标题编辑仍待完成。
- 本批历史入口验证：GPUI 68 项测试、history-core 15 项测试、双语资源 JSON 解析和 `npm run check:architecture -- --strict` 全部通过；严格架构结果为 1545 个源文件、0 个超限、0 个新增违规。已知 Windows `runtime error R6016` 仍会出现在测试启动输出，但测试最终退出码为 0。
- GPUI 历史列表继续接入首条会话详情：后台扫描时复用 `history-core::parse_detail` 保留消息角色、正文和时间戳，在原生页面下方展示最多 80 条消息；新增匹配转录解析回归测试。会话点击切换、详情虚拟化、分页和搜索取消仍待完成。
- 详情接入收口验证：GPUI 测试增至 69 项，新增转录行匹配与原生详情解析测试；架构严格检查仍为 1545 个源文件、0 个超限、0 个新增违规，双语资源解析通过。
- 本批门禁修复：历史详情视图调用拆分为多行，并将繁体转换表移至独立 `i18n` 模块；`main.rs` 从 2007 行降至 1949 行，严格架构检查恢复为 0 个超限、0 个新增违规。
- 本批历史交互继续收口：来源筛选按钮接入 GPUI 点击回调，All、Claude、Codex 可直接切换并立即刷新可见列表。
- 本批历史 P5 继续实施：首次扫描按 CPU 核数一半设置有界 worker，分片并行解析 JSONL，避免文件数量增长时无限创建线程。
- 本批历史交互继续实施：历史页获得焦点后支持键盘输入与退格查询，过滤逻辑保持在原生状态模型内，不启动阻塞式全量搜索任务。
- 本批历史性能继续实施：列表保留完整匹配结果但只按 200 条窗口构造 GPUI 行元素，滚轮通过有界偏移浏览大结果集。
- 本批 P5 验收补充：history-core 对同目录 20 个转录文件执行批量追加刷新，确认只复用一个目录 watcher、每个文件仅返回新增行，并记录 300 ms 内处理预算。
- 本批 Git P4 开始实施：新增按路径 `git status` 查询和状态合并模型，暂存、取消暂存、回滚后的单文件刷新优先走增量路径，异常时保留全量刷新兜底。
- 本批 Git P4 继续实施：GPUI 壳为当前项目启动一个共享 notify watcher，事件按批次合并后调用增量状态查询；重新加载项目时递增代次并丢弃旧 watcher 结果。
- 本批 Git watcher 生命周期收口：加入 oneshot 取消通道，项目重载会先终止旧监听任务，再建立新代次 watcher。
- 本批 Git P4 元数据继续实施：GPUI 状态读取优先用 git2 打开本地仓库并查询 HEAD、当前分支与 ahead/behind；打开失败时沿用 CLI 解析结果。
- 本批元数据收口：git2 成功时 status 不再携带 `--branch`，WSL UNC 跳过 Windows libgit2 并沿用 CLI 分支解析。无提交、detached HEAD、无上游与分叉元数据测试通过；引用列表仍使用 CLI，WSL 实机路径仍待验收。
- 根因与触点：`start_action` 把 Ready 替换为 Loading 后丢失完整状态，导致后续增量合并只能留下单文件结果；现保留原列表，缺少 Ready 基线时重新全量加载。`merge_paths` 同步合并元数据并移除已干净文件，`start_path_load` / `start_load` 按 watcher 代次拒绝过期结果。定向 Git 测试 12 项通过；未将 P4 整体验收勾选完成。
- 元数据收口验证：GPUI 全量 75 项测试通过，严格架构检查 1546 个源文件、0 个超限、0 个新增违规；`git diff --check` 仍报告既有 `CHANGELOG.md` 与 `src-tauri/Cargo.toml` 文件尾空行，未宣称差异检查通过。
- Git watcher 边界收口：访问事件被忽略，rename 保留新旧路径；`.git/index`、HEAD、refs、packed-refs、config、`.gitignore`、目录变化和超过 200 个路径触发全量刷新；真实临时仓库验证外部 `git add` 的 index 事件可在 3 秒预算内到达。P4 增量状态条目已勾选，P1 文件树 watcher 与 5,000 文件 ≤200ms 性能验收仍未完成。
- 本批性能基准：真实临时仓库创建 5,000 个未跟踪文件，单文件 `load_paths` 增量 status 查询耗时 42.4ms；仅证明状态查询层，列表 UI、Diff 滚动和主线程不阻塞仍待跨层验收。

- GPUI Git 变更面板新增已跟踪文件的整文件回滚确认流程：执行前确认，使用 `git restore --source=HEAD --staged --worktree` 同时清理暂存和工作区改动，成功后重新读取 Git 状态；未跟踪文件不进入回滚流程。
- GPUI 文件区接入新建文件、新建目录和重命名输入流程，复用文件域的项目根路径安全校验，操作完成后刷新文件树。
- GPUI Git 变更面板接入已暂存文件提交：原生输入提交消息，异步执行 `git commit -m`，成功刷新 Git 状态，失败保留错误提示。
- GPUI Git 面板接入本地引用浏览，读取 `refs/heads` 与 `refs/tags`，显示名称和短 SHA，并在状态刷新时同步更新。
- GPUI Git 引用接入分支/标签检出确认流程：分支执行 `git switch`，标签执行 detached checkout，成功后刷新文件树和 Git 状态，失败保留错误反馈。
- GPUI Worktree 域新增创建、列表和删除安全执行层：校验任务名、分支引用与 Git 注册路径，禁止删除主仓，保留异步接口供壳接入。
- GPUI Worktree UI 已接入创建/删除确认流程：创建复用原生输入编辑器并使用默认 Worktree 根目录，删除按真实注册路径确认；成功后异步刷新 Git Worktree 列表。
- GPUI Worktree 列表刷新增加加载代次校验，快速切换项目或连续执行操作时会丢弃旧异步结果；文件预览新增不依赖 WebView 的原生 Markdown 块解析与渲染，覆盖标题、段落、任务列表、编号列表、引用、分隔线和 fenced code。
- 新增 `crates/preview` 预览核心 crate：实现四类预览的降级决策、WebView 探测/创建超时/隐藏回收状态机、桥接消息 v1 白名单和 8 MiB 限制，以及项目根路径和敏感文件防逃逸校验；平台 WebView 宿主仍待接入。
- 预览核心协议层补齐内部 `climgr-preview://` 路由、配置端口 Live Server、外部 URL/脚本协议决策、MIME 白名单和单区间 PDF Range 解析。
- 预览核心新增懒加载 `Probe`：支持用户禁用、缓存清理和重新检测；Windows 通过受控绝对路径动态加载 `WebView2Loader.dll` 并读取版本，Linux 标记为不支持，macOS 使用系统 WebKit 状态。
- `PreviewController` 已将 Probe、Fallback、Host 状态机组合为统一打开/就绪/失败/隐藏/恢复/回收 API；打开请求先有降级结果，真实平台宿主接入后再切换为 WebView。
- GPUI 文件预览已接入 HTML 源码和 PDF 外部降级状态：PDF 在打开时跳过 UTF-8 读取，显示双语信息卡并通过系统默认应用打开，避免二进制内容误入原生编辑器。
- 本批 Worktree 执行层验证：3 项 Worktree 定向测试通过，覆盖名称校验、porcelain 列表解析和真实临时仓库创建/删除。
- 本批检出验证：GPUI 61 项测试通过，覆盖真实临时仓库分支切换和非法引用拒绝；`cargo check`、冒烟启动、双语 JSON 解析和严格架构检查通过，架构保持 1538 个源文件、0 个超限。
- 本批引用浏览验证：GPUI 60 项测试通过，新增本地分支/标签解析测试；`cargo check`、冒烟启动、双语 JSON 解析和严格架构检查通过，架构保持 1538 个源文件、0 个超限。
- 本批文件域与 Git 验证：GPUI 59 项测试通过，覆盖新建/重命名异步操作、提交消息校验和临时 Git 仓库真实提交；`cargo check -p cli-manager-desktop-gpui -p cli-manager-core-db`、GPUI 冒烟、双语 JSON 解析和严格架构检查通过，架构为 1538 个源文件、0 个超限。
- 本批验证：GPUI 56 项测试、`cargo check -p cli-manager-desktop-gpui -p cli-manager-core-db`、`cargo run -p cli-manager-desktop-gpui -- --smoke`、双语 JSON 解析和 `npm run check:architecture -- --strict` 全部通过；架构检查为 1537 个源文件、0 个超限。
- 本批 Worktree UI 验证：GPUI 63 项测试全部通过；`cargo check -p cli-manager-desktop-gpui -p cli-manager-core-db`、GPUI smoke、双语 JSON 解析和 `npm run check:architecture -- --strict` 全部通过，架构为 1538 个源文件、0 个超限。构建期间仍会出现 Windows `runtime error R6016` 输出，但命令最终成功退出。
- 本批原生 Markdown/异步代次验证：Markdown 定向测试 3 项全部通过；`cargo check -p cli-manager-desktop-gpui -p cli-manager-core-db` 与严格架构检查通过，架构为 1539 个源文件、0 个超限。测试进程仍会输出已知 Windows `runtime error R6016`，最终测试退出码为 0。
- 本批 PreviewHost 核心验证：`cli-manager-preview` 7 项测试全部通过，覆盖四类降级、创建超时与 60 秒回收、桥接消息白名单/大小限制、路径安全、导航来源、MIME 和 Range；GPUI/core-db 联合编译通过。当前仅完成平台无关核心，尚未宣称 WebView 可用性矩阵或真实嵌入完成。
- 本批探测层验证：`cli-manager-preview` 测试增至 9 项，覆盖禁用状态缓存/清理和 Windows 受控 Loader 路径约束；真实 WebView 控件创建、DPI/Airspace 和手动可用性矩阵仍待平台宿主接入。
- 本批控制器验证：`cli-manager-preview` 测试增至 10 项，覆盖降级打开和 WebView 生命周期编排；真实平台控件、DPI/Airspace 与 6×3 手动矩阵仍待接入。
- 本批三类降级 UI 编译验证：GPUI、Preview、core-db 联合编译和双语资源解析通过；平台 WebView 控件、DPI/Airspace 与 6×3 手动矩阵仍待接入。

用户已授权跳过当前门禁继续实施；未通过的门禁保留待验收状态，不据此宣称 M0 完成。

## 已落地

- GPUI 终端通过 `on_children_prepainted` 捕获首行实际 bounds，将窗口绝对鼠标坐标转换为终端局部坐标，修正布局偏移下的点击、滚轮和选区。
- GPUI 普通终端已接入本地拖动选择、高亮和 Ctrl+C 剪贴板复制；启用 VT 鼠标报告时选择逻辑让位给 PTY 鼠标协议。
- GPUI 终端接入滚轮：无 VT 鼠标报告时直接驱动 term-engine scrollback，启用鼠标报告时按当前协议编码 wheel 事件发送到 PTY。
- GPUI 属性渲染已读取 VT `RenderableCursor`，对可见光标单元格反转前景/背景，隐藏光标保持隐藏。
- GPUI 终端按窗口可用区域和 GPUI 实际字体 ascent/descent、字符 advance 计算列行，并在连接可用且尺寸变化时发送 daemon resize；鼠标坐标使用相同度量，终端元素填充工作区并保留纵向滚动。
- GPUI 终端渲染已从纯文本预览推进为原生 `StyledText` runs：按连续单元格属性合并前景/背景色、粗体、斜体、下划线、删除线，保留组合字符并跳过宽字符占位；模型缓存增量 damage，避免局部快照清空未变化行。
- 原生终端进入实施：共享 core::pty_frame、独立 pty-client、无 Origin 原生连接能力；已接入 GPUI 后台 VT 终端模型和属性渲染，恢复与退出契约待补齐。
- 新增 `term-engine` 与 GPUI `TerminalModel`：alacritty VT 解析在后台模型中消费二进制帧，拥有属性的 damage 快照供 UI 读取；session ledger 在 replay_reset 后重置游标，解析完成后才提交 ACK；当前 endpoint/session 使用显式环境变量，尚未完成生产 bootstrap、输入/IME 和完整重连。
- 原生客户端 Auth 增加 `client_features` 声明，pty-client 支持 `ws_binary_input_v1` 二进制写入及非 UTF-8 集成测试；字节 ACK 能力协商与恢复状态机仍待实现。
- 已加入 `ws_ack_bytes_v1`：daemon 按客户端协商选择字节或 UTF-16 流控计数，pty-client ACK 同时携带兼容字段；跨客户端旧协议路径保留。
- GPUI attach 支持显式 endpoint 和当前 data 根的 `daemon.json`/`daemon.dev.json` discovery，新增 discovery 读取测试；daemon 启动、create 丢失探测和自动重连仍待实现。
- GPUI 单会话 attach 已增加断线重连循环，退避从 250ms 到 5s，并在每次重连前读取当前 committed sequence；多会话恢复、missing 终止分类和生命周期取消仍待实现。
- `term-engine::input` 新增无 UI 依赖的键盘、粘贴和鼠标编码器及覆盖测试；GPUI 已接入 KeyDown、括号粘贴、鼠标、滚轮、IME 与普通终端选区。
- pty-client 新增 `create_or_probe`，对 create 成功响应做类型/会话 ID 校验，失败后 list 精确探测目标会话并 attach；完整多会话协调仍待接入 GPUI。
- 为 `create_or_probe` 增加回环传输回归，覆盖 create 拒绝后探测已有会话，以及 create 响应超时、迟到响应不阻塞 list/attach 的恢复路径。
- `term-engine` 新增可见屏 ANSI checkpoint 序列化，恢复模式、SGR、超链接、组合字符和光标；新增属性/光标 round-trip 测试，滚动历史及协议级上传恢复仍待接线。
- pty-client 新增 `checkpoint_replay_v1` 能力声明和独立二进制 checkpoint 上传 API，GPUI `TerminalModel` 暴露序列化入口；上传调度、接受/拒绝状态处理和完整恢复流程仍待接线。
- GPUI 终端从固定预览 session 改为项目选择驱动的 create-or-probe/attach；项目切换取消旧连接代次，断线退避恢复只保留当前项目会话。
- 项目 attach 在 discovery 尚未就绪时退避等待，并将明确 `session not found` 分类为终止结果；客户端保留 daemon 的具体错误消息供恢复分类使用。
- GPUI 终端输入已接入基础 KeyDown 到 `term-engine::input`，读取当前应用光标/Kitty 模式并通过当前连接发送二进制字节；IME、鼠标、滚轮、剪贴板选择路径已接入，文件拖放仍待实施。
- 根 Cargo workspace 与统一锁文件、构建目录。
- core：编码、Windows 参数、SSH 校验及启动参数、WSL、Git Bash、daemon discovery/circuit 等已抽取模块。
- core-db：41 个中立历史迁移、抽取前 SQL SHA-384 对照、SQLx migrator、WAL 读写池及 16 读/2 写压力验证。
- core-db：项目/分组完整记录、列表、ID 查询、一致性快照、祖先绑定路径解析、显式现有库只读入口。
- core-prefs：原子 JSON 更新、进程锁、未知字段保留、125 个前端设置默认值导出。
- GPUI：双语最小窗口、4970 个共享翻译键、Tokio 后台项目读取、项目选择及路径/Shell 显示。
- GPUI 自动读取默认/便携版/自定义数据根，`CLI_MANAGER_GPUI_DATABASE` 仍可覆盖；不自动创建或迁移用户库。
- core 共用数据根选择、路径规范化与链接检查；Tauri 保持启动切换与 repair 流程。
- 项目树预计算在后台完成，提供分组层级和展开/收起。

## 当前验证

- core 49 项、core-db 项目仓储 4 项、GPUI 2 项、Tauri app_paths 25 项及 Web listener 2 项测试通过；此前数据库迁移/池与偏好测试通过。
- GPUI 编译检查和默认语言窗口自动退出冒烟通过；本批 term-engine 11 项、pty-client 16 项、GPUI 8 项定向测试通过，未进行视觉人工验收。
- 架构严格检查通过：1522 个源文件，无超过 2000 行文件。
- 整个 workspace 编译检查通过，仅保留已有 fetch_update 弃用警告。
- GitNexus 全工作区检测为 high：42 个已跟踪变更文件、186 个符号、7 条流程；索引落后 74 个提交，新建未索引文件需以编译与定向测试补充覆盖。

- 本批完成 `session_status_push_v1`：daemon 与原生客户端完成能力协商，退出路径向支持该能力且已 attach 的客户端推送 `session_status`，旧客户端保留 `exit` 兼容帧；GPUI 对当前会话的 exited/error/failed 状态结束恢复重试。新增协议往返测试；pty-client 16 项、term-engine 9 项、GPUI 5 项定向测试及 src-tauri cargo check 通过。

- GPUI checkpoint 调度已接线：每 128 个解析并提交的输出帧生成当前可见屏 ANSI 快照并上传，消费 daemon 的 `checkpoint_accepted`/`checkpoint_rejected` 控制帧；尺寸来自 VT 引擎当前状态，上传不会推进或伪造 ACK 游标。

- pty-client 增加 `close_all` 与 `shutdown_if_idle` API，已具备退出守卫调用 daemon 有序清理的传输入口；GPUI 窗口关闭前的交互式 ask/background/minimize/discard 编排仍待接线。

- GPUI 壳新增 100ms revision 观察器，仅在终端模型产生新提交时调用 `cx.notify()`，解决后台输出已解析但预览不自动刷新的生命周期缺口。

- GPUI 窗口关闭钩子已接入 detach barrier：有活动 daemon 客户端时暂缓窗口移除，detach 完成后再 remove_window；没有活动客户端时直接走关闭降级。完整 ask/background/minimize/discard 退出分流仍待接线。

- term-engine 已补齐 bracketed paste 状态读取与包装编码测试；GPUI 原生 `EntityInputHandler` 已接入系统文本输入与剪贴板路径。

- GPUI 终端已注册 `EntityInputHandler`：IME marked text 不直接写入 PTY，commit/paste 才发送字节；焦点绑定终端区域并使用 bracketed paste 模式。普通终端选区、复制和原生字形坐标度量已接线。

- term-engine 新增 SGR/legacy 鼠标编码与 click/drag/motion/wheel 模式；GPUI 已接入三键按下/释放、拖动和滚轮事件，坐标换算复用 GPUI 实际字体度量。
- GPUI 新增无 UI 依赖的 `ExitCoordinator`，统一计算运行任务退出时的确认、后台、最小化和终止动作；后台模式在 daemon 不可用时降级为隐藏窗口。窗口弹窗、设置持久化和托盘入口仍待接线。
- term-engine 新增终端列级文本搜索与常见 URL 检测，`TerminalModel` 已提供搜索/URL 查询接口；搜索栏、点击打开和 URL 高亮 UI 仍待接线。
- GPUI 原生终端已将 URL 检测结果接入 `StyledText` runs，以蓝色下划线显示 URL；点击打开和搜索栏交互仍待接线。
- GPUI 普通终端已接入 URL 单击打开：通过系统默认程序处理 HTTP、HTTPS、file、SSH URL，终端鼠标报告模式仍保留 PTY 鼠标语义。
- GPUI 终端已接入 Ctrl+F 搜索交互、搜索结果计数和黄色高亮；搜索状态下的文本、退格、Esc 不再误发给 PTY。
- GPUI 搜索栏新增 `zh-CN`/`en-US` 翻译键，避免原生壳新增用户可见文案硬编码。
- GPUI 新增独立 `PaneTree` 数据模型，支持四方向拆分、活动 Pane、叶节点顺序与关闭折叠；实际多会话视图、拖拽 drop zone 和持久化仍待接线。
- GPUI 在 PaneTree 之上新增 `WorkspaceSessions` 会话表，绑定真实 PTY/伪会话、状态与关闭清理，并提供运行任务筛选；真实连接句柄和视图接线仍待完成。
- GPUI 新增 Hook/Shell 双源 `TabStatusSources` 合并模型，优先级与现有终端契约一致，默认退出筛选只认合并态 `running`。
- GPUI 当前项目终端已绑定 WorkspaceSessions 活动会话元数据，并在渲染前校验 session ID，避免项目切换竞态绘制旧会话；多句柄并行视图仍待接线。
- 活动会话绑定后跨 crate 回归保持通过：GPUI 24 项、term-engine 14 项、pty-client 16 项；架构严格检查为 1530 个源文件、0 个超限。
- GPUI 新增 `SessionRegistry` 并替换壳内散落的单会话模型/取消/连接字段；活动句柄已覆盖输入、resize、滚动、粘贴、渲染和窗口关闭，多句柄并行 Pane attach 仍待接线。
- SessionRegistry 接入后跨 crate 回归保持通过：GPUI 24 项、term-engine 14 项、pty-client 16 项；架构严格检查为 1530 个源文件、0 个超限。
- GPUI 当前项目新增 Ctrl+Shift+\ 分屏入口，创建独立 PTY/TerminalModel 并纳入 SessionRegistry；当前仍只绘制活动 Pane，多 Pane 同屏布局与切换 UI 待接线。
- 分屏入口回归完成：GPUI 24 项、term-engine 14 项、pty-client 16 项全部通过；架构严格检查为 1530 个源文件、0 个超限。
- GPUI 终端新增 SessionRegistry 会话栏，支持点击切换活动会话并重置尺寸/选区状态；多 Pane 同屏布局仍待接线。
- GPUI 终端已按 SessionRegistry 会话生成独立 Pane 容器，同屏显示各自 VT 快照并可点击激活；拖拽比例、树结构方向布局和 pane 级坐标仍待完善。
- 多 Pane 容器接入后回归通过：GPUI 24 项、term-engine 14 项、pty-client 16 项；架构严格检查为 1530 个源文件、0 个超限。
- PaneTree 新增嵌套布局边界计算和测试，输出归一化坐标供 GPUI 后续按比例渲染；实际像素布局、拖拽调整和坐标换算仍待接线。
- Pane 布局计算接入后回归通过：GPUI 25 项、term-engine 14 项、pty-client 16 项；架构严格检查为 1530 个源文件、0 个超限。
- 会话栏接入后跨 crate 回归保持通过：GPUI 24 项、term-engine 14 项、pty-client 16 项；架构严格检查为 1530 个源文件、0 个超限。
- GPUI 多 Pane 视图已接入 PaneTree 递归水平/垂直布局；每个 Pane 记录独立 bounds，鼠标选择、滚轮、URL 点击与 VT 鼠标报告按命中会话路由。
- GPUI 窗口关闭 detach barrier 已覆盖 SessionRegistry 中全部活动连接，多 Pane 会话逐一 detach 完成后再退出。
- GPUI 分屏终端已按每个 Pane 的实际 bounds 计算列行，并分别向对应 PTY 同步 resize。
- GPUI 新增 Ctrl+Shift+W 活动 Pane 关闭路径，取消对应 attach、清理 SessionRegistry/WorkspaceSessions 并切换到剩余 Pane。
- PaneTree 已支持最近分割节点的有界比例调整，GPUI 通过 Ctrl+Alt+方向键接入活动 Pane 的分割比例调整。
- GPUI 新增按项目 `sessions.json` 工作区快照，保存 PaneTree/比例/活动会话元数据；项目重新打开时恢复稳定 session ID 并复用 create-or-probe/attach。
- GPUI 原生壳已读取共享恢复设置，支持 `auto` 直接恢复、`ask` 双语确认区和关闭开关时清理当前项目快照。
- GPUI 已接入每进程一次的启动恢复守护：项目树加载后扫描快照，按 `auto/ask` 分流；恢复关闭时清理当前环境全部工作区快照。

## 本批验证（2026-10-31，Pane 布局与坐标路由）

- `cargo check -p cli-manager-desktop-gpui`：通过。
- `cargo test -p cli-manager-desktop-gpui -p cli-manager-term-engine -p cli-manager-pty-client -j 2`：GPUI 25 项、term-engine 14 项、pty-client 单元 7 项与 transport 9 项全部通过。
- `npm run check:architecture -- --strict`：1530 个源文件，0 个超限，0 个新增违规。
- `git diff --check`：仅保留工作区既有的 `CHANGELOG.md` 与 `src-tauri/Cargo.toml` 文件末尾空行警告。

## 本批验证（2026-10-31）

- `cargo test -p cli-manager-desktop-gpui -p cli-manager-term-engine -j 2`：GPUI 13 项、term-engine 11 项通过。
- `cargo test -p cli-manager-pty-client -j 2`：单元 7 项、transport 9 项通过。
- `npm run check:architecture -- --strict`：1525 个源文件，0 个超限，0 个新增违规。
- 本批新增搜索/URL 解析后重新运行 GPUI 13 项、term-engine 14 项测试，全部通过。
- URL 高亮接入后复跑 GPUI 13 项、term-engine 14 项、pty-client 16 项测试，全部通过；架构严格检查仍为 1526 个源文件、0 个超限。
- URL 单击打开接入后复跑 GPUI 14 项、term-engine 14 项、pty-client 16 项测试，全部通过；架构严格检查仍为 1526 个源文件、0 个超限。
- Ctrl+F 搜索交互接入后复跑 GPUI 14 项、term-engine 14 项、pty-client 16 项测试及双语 JSON 解析，全部通过；架构严格检查仍为 1526 个源文件、0 个超限。
- PaneTree 接入后运行 GPUI 17 项、term-engine 14 项、pty-client 16 项测试，全部通过；架构严格检查为 1528 个源文件、0 个超限。
- WorkspaceSessions 接入后 GPUI 测试增至 20 项，全部通过；会话表警告已清理。
- 当前跨 crate 回归：GPUI 20 项、term-engine 14 项、pty-client 16 项全部通过；架构严格检查为 1529 个源文件、0 个超限。
- 双源 Tab 状态接入后 GPUI 24 项、term-engine 14 项、pty-client 16 项全部通过；架构严格检查为 1530 个源文件、0 个超限。

## 尚未完成

- M1：完整 AppContext/EventSink、daemon/helpers 去 Tauri 化、全部领域仓储、生产连接池与偏好接入、旧库修复迁移适配。
- 壳基础：Worktree 树的选择/终端绑定已接入；完整主题 token、交互组件仍待完成，基础主题切换、Keymap 和动态语言切换已接入。
- 原生终端的多会话调度、完整字形布局与真实 DPI 度量仍需继续；PreviewHost、其余工作区/设置面板、桌面集成、发布切换仍需逐项实施与验收。
- M0 的 IME、性能、许可证、跨壳 checkpoint 等未全部通过；macOS 继续暂缓。

## 本批完成（2026-10-31）

- pty-client 新增 `attach_or_create`：先调用 daemon `list` 精确查找稳定 session ID，存在时携带已提交 sequence 直接 attach；只有会话不存在时才进入 create-or-probe，避免工作区恢复重复启动 PTY。
- GPUI 所有项目终端 bootstrap attach 已切换到该优先级路径；daemon 列表失败会保留为连接错误，不在无法确认现存会话时盲目 create。
- GPUI 工作区快照新增 `SnapshotWriter`：以脏标记合并短时间内的布局变化，10 秒节流并保证单飞后台写入；窗口关闭时取消延迟 worker 并强制刷出最后状态。
- GPUI 关窗已接入实际双语退出确认区：运行中任务可选择后台继续、最小化、停止任务并退出或取消；后台路径执行 detach，丢弃路径执行 close_all 后 shutdown_if_idle。
- GPUI 退出守卫已读取共享设置 `exitWithRunningTasksBehavior` 和 `backgroundIncludeFinishedTasks`，并按 Hook/Shell 合并状态决定是否拦截已完成任务。
- PaneTree 新增嵌套分割线命中和精确 resize API；GPUI 鼠标拖动分割线按根布局归一化坐标调整对应外层比例，并复用快照节流保存。
- PaneTree 新增五区 `DropZone` 与会话移动 API；GPUI 会话 Tab 通过原生 drag/drop 投放到中心、左、右、上、下区域，边缘投放会保留 session ID 并重建对应分屏方向。
- GPUI 会话拖动增加 `DragMoveEvent` 位置追踪和五区颜色反馈，目标 Pane 按 center/left/right/top/bottom 显示不同边框状态，drop 后清理预览。
- GPUI 将 daemon 连接生命周期接入 Shell 状态源：连接中/运行中、正常退出、失败和断线会同步到 `WorkspaceSessions`，正常退出或明确失败不再进入无限重连。
- GPUI pty-client 开始消费 daemon `hook_report` 控制帧，按 `tabId/tab_id` 绑定会话并更新 Hook 状态；Claude/Codex 的 attention、running、done、failed 与 Shell 状态通过 `TabStatusSources` 合并。
- GPUI 会话栏已绘制合并状态指示点，状态变化由后台轮询触发壳刷新。
- GPUI 壳新增中英文运行时切换与共用 `settings.json` 持久化，更新设置时保留未知字段；繁体转换和完整设置面板仍待完成。
- GPUI 壳新增明暗主题运行时切换与持久化，主窗口、侧栏、会话栏、终端 Pane 和退出区复用统一调色板；完整主题 token、系统跟随和强调色仍待完成。
- GPUI 壳新增 Ctrl+Shift+P 命令面板，支持按文本过滤语言切换、主题切换、关闭当前 Pane 和打开项目动作；完整 Keymap 配置和模块化动作注册仍待完成。
- GPUI 命令面板已接入上下方向键、Enter 执行、Escape 关闭和当前项高亮，基础键盘交互闭环完成。
- GPUI 项目切换已改为并行会话模型：不再清空全局 `SessionRegistry`，按当前 `WorkspaceSessions` 过滤视图，旧项目连接保持可恢复；切换前强制刷出当前快照。
- GPUI 新增基础设置视图并接入共用偏好写回，覆盖会话恢复开关/模式、运行任务退出行为和已完成任务后台筛选；完整设置域面板仍待迁移。
- GPUI 壳新增窗口激活观察和低功耗状态，后台终端 revision 轮询从 100ms 降为 500ms，重新激活会触发立即重绘；光标动画、资源采样和托盘隐藏状态仍待完整接入。
- GPUI 语言模型扩展为 `zh-CN`/`zh-TW`/`en-US` 三态，繁体使用统一字符转换入口生成当前字典；完整人工语言验收和更完整词汇级转换仍待完成。
- GPUI 新增独立 `keymap` 模块，将命令面板、分屏、关闭 Pane、分割比例、终端搜索和选区复制注册为 `Action`，启动时读取共用 `keyboardShortcuts` 偏好并兼容 Tauri 快捷键格式；快捷键设置页和更多动作仍待迁移。

## 本批验证（2026-10-31）

- `cargo test -p cli-manager-pty-client -p cli-manager-desktop-gpui -j 2`：GPUI 29 项、pty-client 单元 7 项、transport 9 项全部通过。
- 快照节流与关闭刷盘接入后：GPUI 30 项、pty-client 单元 7 项、transport 10 项全部通过；`cargo check -p cli-manager-desktop-gpui` 通过。
- 退出确认区接入后：`cargo check -p cli-manager-desktop-gpui` 和 GPUI 30 项测试通过；中英文资源 JSON 解析通过。
- 退出设置接入后：GPUI 30 项测试和编译检查继续通过，设置解析回归覆盖后台行为与已完成任务筛选。
- 分割线拖动接入后：GPUI 测试增至 31 项，新增嵌套外层分割命中/调整回归；`cargo check -p cli-manager-desktop-gpui` 通过。
- 五区拖放接入后：GPUI 测试增至 32 项，新增 DropZone 映射与会话移动回归；`cargo check -p cli-manager-desktop-gpui` 通过。
- 拖放反馈接入后：GPUI 32 项测试和编译检查继续通过；中英文资源与架构检查保持通过。
- daemon 生命周期状态接入后：GPUI 32 项、term-engine 14 项、pty-client 单元 7 项与 transport 10 项全部通过。
- Hook 报告接入后：GPUI 33 项、term-engine 14 项、pty-client 单元 7 项与 transport 10 项全部通过。
- 会话状态指示点接入后：GPUI 33 项测试与编译检查通过。
- 语言设置接入后：GPUI 34 项测试通过，双语 JSON 解析通过。
- 主题接入后：GPUI 35 项测试和编译检查通过。
- 命令面板接入后：GPUI 35 项测试通过。
- 命令面板键盘交互接入后：GPUI 35 项测试通过。
- 多项目会话保留接入后：GPUI 35 项测试通过。
- 基础设置视图接入后：GPUI 36 项测试通过。
- 低功耗刷新策略接入后：GPUI 36 项测试通过；同时修正快照 writer 测试的后台 worker 竞态断言。
- 繁体语言接入后：GPUI 37 项测试通过，覆盖繁体字典转换。
- Keymap/Action 模块化接入后：GPUI 38 项测试通过，新增快捷键匹配回归；`cargo check -p cli-manager-desktop-gpui` 通过。
- Keymap 共用偏好接入后：GPUI 40 项测试通过，覆盖 Tauri 快捷键格式解析、方向键归一化和非法绑定回退。
- Workspace-features 开始接入：`core-db` 项目快照带出 Worktree 只读记录，GPUI 增加四态路径判定和项目页列表展示；Worktree 创建/删除与选择已接入，拖拽树和冲突视图仍待完成。
- Worktree 展示补齐主仓入口：项目主路径始终进入状态列表，缺失主路径显示为已删除；项目页可同时看到主仓和数据库登记的子 Worktree。
- 文件域开始接入：新增异步只读根目录扫描与 GPUI 文件列表，过滤点文件/`.git` 并按目录优先排序；惰性展开、忽略规则、文件操作和编辑器仍待完成。
- 文件树根扫描接入后：GPUI 42 项测试通过，覆盖隐藏条目过滤、目录优先排序、缺失路径失败状态和异步项目切换加载；架构严格检查恢复为 1535 个源文件、0 个超限。
- 文件树新增惰性目录展开：维护已加载/展开状态，首次点击异步读取子目录并插入节点，重复点击不重复访问文件系统；GPUI 测试增至 44 项，架构严格检查为 1536 个源文件、0 个超限。
- 文件树过滤接入项目根 `.gitignore`：支持目录规则、通配符和否定规则，`.gitignore` 自身保持可见，子目录展开复用根规则；GPUI 测试增至 45 项。
- 文件操作基础能力已加入文件域：创建文件、创建目录、重命名和删除均限制在项目根目录内，拒绝绝对路径、父目录穿越和 `.git` 元数据路径；文件点击会将项目内绝对路径写入系统剪贴板。
- Workspace 文件预览已开始接入：点击文件异步读取 UTF-8 文本并在 GPUI 原生内容区域展示，读取限制为项目根目录内且不超过 2 MiB，二进制和超大文件返回可见失败状态。
- 文件域新增 UTF-8 文本保存接口和回归测试，保存限制在项目根目录内、拒绝目录目标和越界路径，并复用 2 MiB 大小上限；编辑器已接入保存按钮、脏状态和保存状态展示。
- 文件域新增 `FileTabs` 标签状态模型：重复路径复用、活动项切换、内容更新、保存标记和脏项关闭保护均有回归测试；当前加载/保存链路已记录标签状态，标签条 UI 和多编辑器实体仍待接入。
- GPUI 壳已锁定并接入 `gpui-component 0.8.1`：文件预览创建原生 `EditorState`，异步读取完成后通过窗口上下文回填内容；终端 `ElementInputHandler` 改在实际 Pane 的 paint 回调注册，避免组件 `Root` 下的启动断言。
- `cargo fmt --all -- --check` 未通过，原因是工作区已有大量未格式化文件；本批修改文件未引入格式化工具自动改写其他工作区内容。

## 本批验证（2026-10-31，文件操作基础）

- `cargo test -p cli-manager-desktop-gpui -j 2`：GPUI 47 项全部通过，覆盖文件创建、目录创建、重命名、删除以及路径越界和 `.git` 防护。
- `cargo check -p cli-manager-desktop-gpui -p cli-manager-core-db`：通过；保留现有未使用 API 警告，文件操作 UI 菜单已在后续批次接入。
- `npm run check:architecture -- --strict`：1536 个源文件，0 个超限，0 个新增违规。
- 中英文资源 JSON 解析通过。

## 本批验证（2026-10-31，文件标签状态）

- 文件标签模型新增回归测试，覆盖重复路径复用、活动项、脏内容和强制关闭。
- 本批继续使用 GPUI 编译与架构检查作为接入前置验证。
- 收口复跑 `cargo test -p cli-manager-desktop-gpui -j 2`：48 项全部通过。
- 文本保存接口接入后定向文件域测试增至 9 项，全部通过；`cargo check -p cli-manager-desktop-gpui -p cli-manager-core-db` 与架构严格检查继续通过。
- `cargo run -p cli-manager-desktop-gpui -- --smoke`：通过，组件初始化、Root 包装和编辑器实体启动路径完成冒烟验证。
- 接入编辑器后完整 `cargo test -p cli-manager-desktop-gpui -j 2`：49 项全部通过。
- 文件编辑保存接入后完整 `cargo test -p cli-manager-desktop-gpui -j 2`：50 项全部通过，新增异步保存路径回归。
- `cargo run -p cli-manager-desktop-gpui -- --smoke`：保存 UI 接入后真实窗口冒烟通过；架构严格检查继续为 1536 个源文件、0 个超限。
- `git diff --check`：仅保留工作区既有的 `CHANGELOG.md` 与 `src-tauri/Cargo.toml` 文件末尾空行警告及换行格式提示。

## 本批验证（2026-10-31，原生文件预览）

- `cargo test -p cli-manager-desktop-gpui -j 2`：文件域定向测试 8 项全部通过，覆盖 UTF-8 预览、二进制拒绝、路径安全和文件操作。
- `cargo check -p cli-manager-desktop-gpui -p cli-manager-core-db`：通过；仅保留已有未使用 API 警告。
- `npm run check:architecture -- --strict`：1536 个源文件，0 个超限，0 个新增违规。
- 中英文资源 JSON 解析通过。

## 本批验证（2026-10-31，文件标签条接入）

- GPUI 文件加载和保存链路已接入文件标签条；重复打开同一路径复用标签，点击标签切换编辑内容，鼠标中键关闭已保存标签。
- 脏标签关闭继续由 `FileTabs` 契约拦截，待补充保存/丢弃/取消确认弹层及当前文件编辑过程中的实时脏状态同步。
- `cargo check -p cli-manager-desktop-gpui -p cli-manager-core-db`：通过；仅保留已有未使用 API 警告。
- `cargo test -p cli-manager-desktop-gpui files::tests -j 2`：11 项全部通过。
- `npm run check:architecture -- --strict`：1536 个源文件，0 个超限，0 个新增违规。
- 中英文资源 JSON 解析通过。

## 本批验证（2026-10-31，文件标签关闭确认）

- 脏标签关闭已接入保存、丢弃、取消三路确认；保存路径直接使用目标标签内容，非活动标签不会误保存当前活动编辑器内容。
- 保存成功后标签强制关闭并切换到相邻标签，保存失败保留标签和确认区；项目切换时清理确认状态。
- `cargo test -p cli-manager-desktop-gpui -j 2`：51 项全部通过。
- `cargo check -p cli-manager-desktop-gpui -p cli-manager-core-db`：通过；仅保留已有未使用 API 警告。
- `npm run check:architecture -- --strict`：1536 个源文件，0 个超限，0 个新增违规。
- 中英文资源 JSON 解析通过。

## 本批验证（2026-10-31，文件标签批量关闭）

- 文件标签支持关闭其它、关闭左侧和关闭右侧；批量操作对干净标签一次完成，遇到脏标签沿用保存/丢弃/取消确认，并在确认后继续处理剩余目标。
- 修正 `FileTabs::update_content`：编辑内容只更新草稿，`saved_content` 仅由加载和成功保存更新，脏状态可持续保持。
- 新增文件标签组关闭和已保存内容隔离回归测试；文件域定向测试 12 项全部通过。
- `cargo test -p cli-manager-desktop-gpui -j 2`：52 项全部通过。
- `cargo run -p cli-manager-desktop-gpui -- --smoke`：通过。
- `npm run check:architecture -- --strict`：1536 个源文件，0 个超限，0 个新增违规。

## 本批验证（2026-10-31，Git 只读变更面板）

- GPUI 项目页新增 `git` 模块，异步执行 `git status --porcelain=v1 -z --branch`，解析分支、ahead/behind 和工作区文件状态。
- Git 变更行点击后复用现有文件编辑器入口；变更行提供单文件暂存、取消暂存、整文件回滚和提交操作，完成后异步刷新状态；引用操作仍待完成。
- 新增分支头和 porcelain 状态解析回归测试，覆盖普通分支与无提交分支。
- `cargo test -p cli-manager-desktop-gpui -j 2`：Git 面板接入后继续通过。
- `cargo check -p cli-manager-desktop-gpui -p cli-manager-core-db`：通过。
- `npm run check:architecture -- --strict`：1537 个源文件，0 个超限，0 个新增违规。

## 本批验证（2026-10-31，Git Diff 面板）

- 变更文件增加统一 Diff 入口，异步执行 `git diff HEAD -- <path>` 并在 GPUI 中按行显示；限制 768 KiB 和 20,000 行，避免大 Diff 阻塞界面。
- Diff 无法读取、超限或包含非 UTF-8 内容时显示失败状态；文件状态、暂存和取消暂存链路保持可用。
- `cargo test -p cli-manager-desktop-gpui -j 2`：Diff 接入后继续通过。
- `cargo check -p cli-manager-desktop-gpui -p cli-manager-core-db`：通过。
- `npm run check:architecture -- --strict`：1537 个源文件，0 个超限，0 个新增违规。

## 本批验证（2026-10-31，文件删除交互）

- 文件编辑器增加当前文件删除按钮和双语确认区；确认后异步删除、关闭当前标签并刷新项目根文件树，取消不会改变文件内容。
- 删除路径继续通过 `safe_path` 校验，拒绝项目根外路径和 `.git` 元数据路径。
- `cargo test -p cli-manager-desktop-gpui -j 2`：54 项全部通过。
- `cargo check -p cli-manager-desktop-gpui -p cli-manager-core-db`：通过。
- `cargo run -p cli-manager-desktop-gpui -- --smoke`：通过，退出码 0。
- `npm run check:architecture -- --strict`：1537 个源文件，0 个超限，0 个新增违规。

## 本批验证（2026-10-31，未跟踪文件 Diff）

- Git Diff 读取在普通 `HEAD` Diff 为空时检查未跟踪 UTF-8 文本文件，生成新文件 unified Diff；越界路径和二进制内容继续拒绝。
- 新增未跟踪文本 Diff 回归测试，覆盖新增行和父目录穿越防护。
- Git 定向测试：3 项全部通过；`cargo check -p cli-manager-desktop-gpui -p cli-manager-core-db` 与严格架构检查继续通过。

迁移整体保持进行中，不将基础模块或窗口骨架等同于完整产品交付。

## 本批实施（2026-10-31，GPUI 文件树 watcher）

- 文件树接入项目级共享 notify watcher，合并同批文件事件后触发异步根目录刷新。
- 项目切换时取消旧 watcher，并使用项目代次和当前项目校验，避免旧项目事件覆盖新项目。
- WSL 与 UNC 路径及 watcher 创建/运行失败会记录退化原因，并回退 15 秒轮询；项目切换仍通过代次校验和取消通道清理旧任务。
- 文件 watcher 轮询回退新增取消与触发回归测试。
- `cargo test -p cli-manager-desktop-gpui -j 2`：81 项全部通过，包含真实临时目录文件变化与取消 watcher 回归测试。
- `cargo check -p cli-manager-desktop-gpui`：通过；保留既有未使用 API 警告。
- `npm run check:architecture -- --strict`：1546 个源文件、0 个超限、0 个新增违规。
- 文件 watcher 回退实现拆分到独立 `files_watcher.rs`，完整 GPUI 回归测试增至 82 项，包含本地 notify、WSL/UNC 判定和 15 秒轮询取消测试。
- `cargo test -p cli-manager-desktop-gpui -j 2`：82 项全部通过；`npm run check:architecture -- --strict`：1547 个源文件、0 个超限、0 个新增违规。
- Worktree 列表 UI 已按路径分类显示主仓、关联、已删除和未识别四种状态；无效路径不再显示删除操作，Workspace PRD 对应四态验收已完成。
- Diff 查看继续保持按需触发，并新增工作区 blob id 计算与最近 64 项 Diff 缓存；语法高亮缓存和大仓库跨层性能验收仍待完成。
- Diff 缓存新增稳定 blob id 回归测试；完整 GPUI 回归测试增至 83 项，全部通过。
- Git watcher 已补齐远程/WSL 路径和运行异常的 15 秒轮询回退，并通过取消、路径判定和轮询触发测试；Workspace P1 watcher 验收已完成。
- Git watcher 回退接入后完整 GPUI 回归测试增至 84 项，全部通过；严格架构检查保持 1547 个源文件、0 个超限。
- 运行 `cargo deny check licenses` 发现仓库当前未提供 deny 配置，且工作区自身使用 `AGPL-3.0-or-later`、helpers crate 未声明许可证；许可证验收暂不勾选，待项目许可证策略明确后处理。
- 历史列表已有 10,000 条窗口滚动、查询过滤和原生详情测试证据，Workspace 历史性能验收已完成。
- Git 变更列表和 Diff 行列表已接入窗口化滚动（200 条变更、240 行 Diff）及边界测试；5000 文件跨层刷新耗时与语法高亮 blob 缓存仍需独立验收。
- 窗口化 Git/Diff 改造后完整 GPUI 回归测试增至 86 项，全部通过；`cargo check` 与严格架构检查均通过。
- 本批 P4 高亮缓存：Diff 文本缓存之外新增独立高亮行模型缓存，key 使用工作区 blob id，最多保留 64 项；可见窗口只消费缓存行并按 Diff 结构分类着色。新增结构分类回归测试，GPUI 定向测试和 `cargo check` 通过；P4 的 5,000 文件跨层 UI 刷新实测仍待完成。
- 本批收口验证：`cargo test -p cli-manager-desktop-gpui -j 2` 共 87 项通过，`cargo check -p cli-manager-desktop-gpui` 通过，`npm run check:architecture -- --strict` 恢复为 1547 个源文件、0 个超限、0 个新增违规。测试启动仍会输出已知 Windows `runtime error R6016`，最终退出码为 0；`git diff --check` 仍只报告既有 EOF 空行。
- 本批 P5 GPUI 接线：历史页打开后启动共享 `TranscriptWatcher`，变化批次只对变化文件调用 `parse_row`，通过 `HistoryState::apply_delta` 增量更新列表和选中详情；取消历史页、切换项目或设置会终止旧任务。新增 20 文件增量状态合并测试，处理耗时低于 300 ms；真实窗口事件到绘制完成的手动验收仍待完成。
- 本批回归验证：GPUI 完整测试增至 89 项并全部通过，`cargo check -p cli-manager-desktop-gpui` 与 `npm run check:architecture -- --strict` 通过（1547 个源文件、0 个超限）。
- 本批跨壳历史元数据：`core-db::ProjectRepo` 新增 `session_meta` 只读读取契约，GPUI 历史打开时加载共用库中的 alias/starred 并覆盖列表标题、搜索和排序；新增 core-db 元数据回归测试，GPUI 真实写入/编辑元数据仍待接入。
- 本批跨壳历史元数据写入：GPUI 历史列表新增星标按钮，按会话乐观切换并写回共用 SQLite `session_meta`；失败时恢复状态，缺失数据库不会自动创建。新增 core-db 写入回归测试；alias 编辑、收藏快照和真实窗口手动切换验证仍待完成。
- 本批历史标题编辑：GPUI 历史详情新增别名编辑器，选择会话时同步加载现有 alias，保存后复用共用 SQLite `session_meta` 写入契约，失败时恢复原值；收藏快照和真实窗口跨壳切换验证仍待完成。
- 本批历史收藏快照：GPUI 星标开启时按当前详情或原始转录生成 `session_favorite_snapshots`，取消星标删除对应快照，并与 `session_meta` 写入保持同一异步操作链；core-db 新增快照 upsert/delete 回归测试。GPUI 从收藏快照恢复离线会话和真实跨壳手动验证仍待完成。
- 本批收藏快照读取：core-db 新增按 `starred` 关联读取快照契约，GPUI 历史加载时合并当前项目的离线收藏条目，并在原始 JSONL 不存在时使用快照详情；新增缺失源文件回归测试。真实 Tauri ↔ GPUI 切换和收藏内容完整一致性仍待手动验证。
- 本批历史筛选对齐：GPUI 新增仅看收藏筛选，过滤逻辑与来源、查询和 200 条窗口滚动共用，新增组合过滤回归测试。
- 本批 P4 高亮继续收口：Diff 高亮模型改用 tree-sitter Rust/TypeScript/TSX grammar 的 AST 节点范围生成 token，并继续按工作区 blob id 缓存；完整 5,000 文件跨层刷新实测仍待完成。
- 本批 P4 性能基准扩展：5,000 文件测试现在覆盖单路径 `load_paths`、`GitStatus::merge_paths` 和 200 条可见窗口计算，记录端到端模型处理耗时并确认目标路径只保留一条状态；真实窗口绘制与主线程阻塞手测仍待完成。
- 本批 P5 可观测性收口：`HistoryState` 记录 watcher 增量批次耗时和刷新次数，20 文件测试同时断言解析与状态合并在 300ms 预算内；真实窗口事件到绘制完成仍待手动验收。
- 本批历史筛选对齐扩展：新增全部时间、最近 7 天和最近 30 天过滤，使用会话更新时间参与窗口化列表、来源、收藏和查询的组合筛选；新增时间边界回归测试。
- 许可证配置收口：新增根级 `.cargo/deny.toml`，允许工作区 AGPL-3.0-or-later 与依赖实际使用的 SPDX 许可证；`src-tauri/helpers` 改为继承 workspace 许可证。`cargo deny check licenses` 已通过；平台 WebView、资源来源和完整人工许可证审查仍待完成。
- Workspace Worktree 选择接入：主仓和有效子 Worktree 卡片可选中，选择后文件树、Git、历史与新建终端使用同一工作目录；切换生成按路径隔离的稳定 session namespace，并关闭旧 daemon 会话。`workspace::worktree` 定向测试 4 项通过，编译检查通过。
- 架构收口：将 GPUI 壳 `Render` 实现拆到 `render.rs`，将 Git 面板视图拆到 `git/view.rs`；`main.rs` 1977 行、`git.rs` 1766 行，严格架构检查恢复为 0 个超限。

## 本批验证（2026-10-31，Worktree 选择与架构收口）

- `cargo test -p cli-manager-desktop-gpui -j 2`：92 项全部通过；测试启动仍输出已知 Windows `runtime error R6016`，最终退出码为 0。
- `cargo deny check licenses`：通过。
- `cargo check -p cli-manager-desktop-gpui`：通过。
- `npm run check:architecture -- --strict`：1551 个源文件，0 个超限，0 个新增违规。
- `cargo run -p cli-manager-desktop-gpui -- --smoke`：真实窗口冒烟启动并退出；保留已知 Windows `runtime error R6016` 输出。
- tree-sitter 高亮定向测试覆盖 Rust 与 TypeScript，完整 GPUI 回归增至 94 项并全部通过。
- 继续复跑完整 GPUI 回归：`cargo test -p cli-manager-desktop-gpui -j 2` 共 94 项通过；确认 tree-sitter TSX 分支没有引入回归。当前仍有 Windows `runtime error R6016` 启动输出，但最终退出码为 0。

## 当前未闭环验收（2026-10-31）

- Workspace-features PRD 仍有 5 项：父级 Design §9 对照记录、5,000 文件真实窗口流畅性、GPUI/Tauri 项目与历史元数据切换一致性、单文件修改到真实面板刷新 ≤200ms、20 个转录文件追加到真实 GPUI UI ≤300ms。
- 父级迁移 PRD 当前仍有 9 项：完整功能对齐记录、全量性能目标、PreviewHost 六状态及进程回收、运行中会话退出/后台/自更新、Tauri↔GPUI 全量数据与 attach、P1–P8 总验收、许可证人工复核、中文 IME 手测、双轨发布期等；其中 PreviewHost 的 GPUI bounds/DPI/可见性接线已完成，真实 WebView 命令执行和平台手测仍属于该项未闭环内容。
- 按独立验收项统计，当前约 **14 项**记录未闭环：Workspace-features 5 项、父级迁移剩余 9 项。代码实现已完成的部分不再重复计数，剩余主要需要真实窗口、双壳和平台环境证据。
- Workspace 冲突域开始接入 GPUI 原生三栏解决器：冲突变更行可加载 stage 1/2/3 与工作文件，支持基线/当前/传入一侧选择、写回工作区并 git add；新增真实 Git 冲突临时仓库回归测试，冲突 UI 的完整手动矩阵仍待完成。
- 冲突域验证：`cargo test -p cli-manager-desktop-gpui -j 2` 共 98 项通过，包含真实 Git 三阶段冲突读取与解决暂存；`cargo check -p cli-manager-desktop-gpui`、`npm run check:architecture -- --strict`（1552 个源文件、0 个超限）和双语 JSON 解析通过；GPUI smoke 启动并退出成功。已知 Windows `runtime error R6016` 仍会出现在启动输出。
- 冲突解决器补齐原生合并编辑：加载冲突文件后复用 GPUI EditorState 显示合并结果，选择基线/当前/传入一侧会同步填充编辑器，点击解决时读取编辑器最新内容再写回并暂存；不再只能整侧替换。
- 跨壳项目外观继续收口：GPUI 项目树现从共用 ProjectSnapshot 读取项目/分组 icon 字段并显示，避免切换 Tauri/GPUI 后项目节点外观丢失；颜色和完整项目编辑面板仍待接入。
- 项目外观收口验证：GPUI 完整测试共 98 项通过，`cargo check -p cli-manager-desktop-gpui` 与 `npm run check:architecture -- --strict`（1552 个源文件、0 个超限）通过；共享中英文资源此前已解析通过。
- 项目外观颜色接入：GPUI 项目/分组树解析共用数据库的 6 位十六进制颜色，并以左侧强调色显示；非法或空颜色回退主题样式，新增颜色解析回归测试。
- 新增可复现脚本 `node scripts/gpuiPerformanceBench.mjs`，分别执行 Git 5,000 文件增量状态测试和 20 文件转录增量刷新测试；2026-10-31 本轮结果为 46.271ms 与 4.279ms，均低于 200ms/300ms 模型预算，结果保存于 `spikes/gpui-poc/bench/results/gpui-incremental-2026-10-31.json`。该证据仍只覆盖模型/工作线程耗时，真实窗口绘制耗时未宣称完成。
- 扩展域回归：`core-db::extensions::list_extension_overview` 改为 SQLite `UNION ALL` 后统一按更新时间和 ID 排序，直接读取 MCP 表中的名称，损坏 `definition_json` 不再使概览整页失败；新增 3 项真实临时 SQLite 测试，覆盖空库、MCP/Skill/部署三类记录、秘密 JSON 不出 DTO、外部修改优先级、归属状态和只读读取。
- GPUI 扩展概览补齐加载中、共享数据库不可用和读取失败状态，异步加载加入代次校验；类型与状态标签接入中英文资源。扩展仍是只读概览，编辑、导入、部署、卸载和策略操作未完成。
- 扩展 MCP 首条写入链路已接入：GPUI 对受管 MCP 提供确认删除，core-db 使用事务按 `resource_id` 精确删除并拒绝 Skill/部署 ID；新增真实 SQLite 回归，验证删除后其他扩展保留、重复删除和错误类型均返回明确错误。编辑、导入、部署、卸载和策略操作仍未完成。
- MCP CLI 开关接入：概览为 Claude/Codex/Grok 提供独立切换，core-db 在事务内只更新 `enabledByCli` 并递增 revision，真实 SQLite 回归确认其他 canonical 字段与秘密引用保持不变。MCP 编辑/导入及 Skill 导入/部署/卸载和策略操作仍未完成。
- 扩展开关边界补强：概览只读取 `enabledByCli` JSON 片段；损坏对象/未知 CLI 拒绝事务且 revision 不变。`DbPool::open_existing` 禁止写入链隐式创建缺失数据库，SQLite 回归覆盖删除/切换缺库均不建文件；异步刷新保留列表操作控件并校验代次。
- MCP 名称编辑接入：GPUI 通过原生编辑器保存单字段草稿；core-db 在事务内同步更新列表列与 canonical `name`、递增 revision，并保留秘密与 CLI 开关。定向 SQLite 回归覆盖对应字段完整性。
- 名称编辑边界覆盖空白/超长输入、损坏 canonical JSON 及原值/revision 保持；编辑态锁定同一 MCP 的其他写操作。名称编辑未扩展为完整 transport/secret 表单，复杂编辑契约继续待迁移。
