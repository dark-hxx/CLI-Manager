# Changelog

## [V1.0.0] - 2026-06-10

### 首个正式版本

- CLI-Manager 发布首个正式版本，功能范围与 V0.2.8 一致，版本线自此进入 1.x。
- 核心能力经 0.0.x ~ 0.2.x 多轮迭代验证趋于稳定：多 Shell 内嵌终端与 JetBrains 风格灵活分屏、项目树管理、Claude / Codex 历史会话浏览与 Diff 查看、分析看板与 ccusage 用量统计、WebDAV 多设备云同步、Hook 通知与终端运行状态、签名自动更新。
- 数据结构稳定：SQLite migrations v1-v7 与 settings 存储格式保持向后兼容，旧版本可直接升级。

## [V0.2.8] - 2026-06-10

### 侧边栏项目树优化

- 目录折叠状态持久化：展开/收起完全由用户控制并记住，应用重启后保持上次状态，不再每次全部自动展开；分组被删除（含级联）或云同步覆盖后，失效的折叠记录会自动清理。
- 项目/目录行内悬浮按钮精简为仅「启动」一个：原 Clone、编辑、删除、新增子目录、新增终端、重命名共 7 个行内按钮移除，统一走右键菜单，避免误触；同步清理 `TreeContext` 中不再使用的 action 字段。
- 右键菜单视觉收紧：菜单项新增左侧图标，按「启动/分屏 → 编辑 → 删除」用分隔线分组，删除项保持红色；整体密度收紧（更窄宽度与行内边距）；历史列表右键菜单共用样式同步变紧凑。

### 设置页修复

- 修复 Mantine 主色色阶：自定义主色从单色 tuple 改为生成完整 10 级色阶（基色置于索引 6，配合 `primaryShade: 6`），`light` / `subtle` 等变体的浅色背景与深色文字取色恢复正常，`filled` 变体仍为用户选择的主色。
- 快捷键页「终端换行快捷键」由 SegmentedControl 改为按钮组，规避控件在弹窗内挂载时指示器测量错位的问题。
- 修复主题页预览卡片 sticky 吸顶：终端背景设置区移入网格布局、预览卡片 row-span 扩展，宽屏下右侧预览随滚动正确吸附。
- 设置内容滚动区启用 `scrollbar-gutter: stable`，避免滚动条出现/消失引起的布局抖动。

### 清理与体验

- 删除无引用组件 `src/components/ui/icons.ts`、`src/components/ui/switch.tsx`，并清理 `App.css` 中 6 组无引用样式（`.mini-btn`、`.ui-surface-inset`、`.ui-primary-gradient`、`.ui-tree-root-drop`、`.ui-sidebar-footer-card`、`.ui-sidebar-sync-actions`）。
- 移除未使用依赖：`@radix-ui/react-dropdown-menu`、`@radix-ui/react-switch`、`@tauri-apps/plugin-shell`；Rust 侧同步移除 `tauri-plugin-shell` 注册与 `shell:default` capability。
- 设置弹窗打开动画改为下滑进入，关闭时即时关闭不再播放缩放动画。
- 设置顶部搜索框迁移到 Mantine TextInput，与设置页其余控件风格统一。

## [V0.2.7] - 2026-06-09

### ccusage 用量分析

- 新增 ccusage 本地用量看板：通过 Rust command 调用并解析 ccusage 数据，前端展示总 Token、估算费用、最高使用日、模型数量与日报天数等摘要。
- 看板支持全部 / 年 / 月 / 日 / 自定义时间窗口筛选，并按当前窗口重算 Token 构成、峰值日摘要、Token / 费用趋势与模型拆分。
- 统计口径展示来源、报告类型与数据结构说明，并明确费用和 Token 来自本机日志估算，不等同官方账单。

### 主题与设置页优化

- 应用主题新增多套浅色 / 深色配色方案，并接入 Mantine Theme Provider，使新增图表与设置控件跟随当前配色。
- 终端主题库扩展更多深色主题，并支持按应用浅 / 深主题与配色方案自动解析终端主题。
- 设置页通用、Hook、快捷键、同步、命令模板、终端背景与主题页完成视觉收口，表单控件、卡片层级和间距更加一致。

### 终端与统计稳定性

- 优化内嵌终端激活 / 隐藏状态下的输出队列、resize 与 IME 组合输入定位，降低后台缓冲、重绘抖动和滚动异常。
- 修复终端标签与设置 / 统计面板的 followup 交互问题，提升刷新、切换与重新加载后的稳定性。
- ECharts 图表封装补齐容器尺寸与生命周期处理，减少统计看板切换时间窗口或重新加载时的空白与抖动。

### 工程内务

- 新增功能清单文档，并补充自动更新相关任务说明，便于发布前核对功能与 updater 后续事项。

## [V0.2.6] - 2026-06-09

### 自动更新

- 接入 Tauri 官方签名 updater：应用通过 updater manifest 检查新版本，在应用内完成下载与安装；配置 updater 公钥、GitHub Actions 签名 Secrets 与 `latest.json` 更新产物。
- 设置页「关于」更新 UI 支持下载进度、安装/重启确认、活跃终端数量风险提示，并保留 GitHub Release 页面兜底入口。
- 更新 manifest 缺失或格式无效时，错误提示映射为中文说明，不再直接展示英文插件报错。
- 由于旧版本缺少 updater 支持和签名更新资产，首个启用自动更新的版本仍需用户手动安装一次。

## [V0.2.5] - 2026-06-08

### 分析看板性能与筛选

- 分析看板时间范围从固定天数改为手动开始/结束日期选择，默认本周一到今天。
- 分析看板打开后默认选择项目下拉框中的第一个项目；没有项目时回退到全部项目。
- 统计加载接入前端查询缓存与后端历史索引 generation 聚合缓存，重复打开同条件看板优先复用结果，刷新按钮仍会强制刷新。
- 打开分析看板不再额外触发历史会话列表加载，降低入口等待时间。

### 快捷键与命令面板体验

- 会话历史快捷键纳入设置页，默认 `Ctrl+K`，支持修改、清空并在未设置时显示“未设置快捷键”。
- 会话历史工具栏按钮支持再次点击关闭，提示文案随当前快捷键配置同步更新。
- 命令面板打开后直接展示默认条目，并补充键盘操作与 `Esc` 关闭提示。
- 快捷键冲突检测忽略空绑定，清空后的快捷键不会触发对应全局动作。

## [V0.2.4] - 2026-06-05

### JetBrains 风格灵活终端分屏

- 终端工作区升级为运行时 pane tree，支持 Split Right、Split Down、Unsplit、嵌套分屏与拖拽分隔线调整相邻 pane 比例，满足左右、上下及混合嵌套布局。
- 每个 pane 拥有独立终端 Tab 栏，保留原有运行中脉冲、待处理、失败、完成等状态视觉；支持 pane 内拖拽排序、拖到其它 pane、Move to Other Split，以及 pane 内 Tab 溢出滚动与列表控制。
- Tab 拖拽新增 DragOverlay 跟随鼠标，并支持落到 pane 中心移动或落到 left/right/top/bottom 边缘以现有 session 创建分屏；边缘落点显示灰色半透明预览，不新建 PTY、不复制 terminal。
- pane 本地 Tab 操作补齐关闭其它、关闭左侧、关闭右侧等动作，避免多 pane 场景下误影响其它分屏。
- 分屏入口覆盖终端 Tab 右键菜单、命令面板与侧栏项目树：Tab 分屏可选择空终端或指定项目，侧栏项目树分屏会在新 pane 中直接启动所选项目终端。
- 终端设置的「终端行为」新增 Unsplit 行为选项，可选择取消分屏时合并到相邻 pane，或关闭当前 pane 内会话。
- 本版本分屏布局仅在运行时生效，不做 pane 布局持久化与重启恢复，避免引入不必要的恢复复杂度。

### 终端输出搜索

- 内嵌 xterm 接入 `@xterm/addon-search`，支持在终端输出中实时搜索并高亮匹配内容。
- 新增 `Ctrl+F` 搜索浮层，展示匹配计数，并支持上一个 / 下一个结果导航。
- 搜索浮层会跟随终端主题；关闭后清理高亮并把焦点恢复到当前终端。

### 终端紧凑版

- 收紧终端顶部工具栏与终端区域外层留白，降低内嵌终端的卡片感。
- 终端内容区去掉单侧 padding，避免普通模式和背景图模式出现不一致的左侧空隙。
- 同步更新 npm、Tauri 与 Rust 版本元信息到 `0.2.4`。

## [V0.2.2] - 2026-06-04

### Hook 自定义目录联动历史统计

- Claude / Codex Hook 设置中的自定义配置目录会同步用于历史会话读取：Claude 读取 `<配置目录>/projects`，Codex 读取 `<配置目录>/sessions`。
- 历史列表、搜索、会话详情、删除、Prompt 列表与分析看板统计统一使用同一套历史根目录解析，避免不同入口读取结果不一致。
- 历史索引、文件扫描与前端统计缓存按 Claude / Codex 目录隔离，切换目录后不会继续命中旧目录数据。

## [V0.2.1] - 2026-06-03

### 会话历史增强

- 会话历史从当前终端 Tab 打开时默认按当前项目过滤，并根据项目配置的 CLI 工具自动选择 Claude / Codex 来源；左上角新增项目筛选，可在全部项目与具体项目之间切换。
- 会话历史列表新增删除入口，删除前二次确认，并通过 Rust 后端校验历史文件边界后删除本地 JSONL 文件，同时清理前端状态、会话元数据与历史缓存。
- 历史列表与全局搜索支持按项目路径过滤，兼容 Claude 项目 key 与 Claude / Codex JSONL 中的工作目录信息。

### 会话历史 Tab 交互修复

- 会话历史作为独立 Tab 保持打开时，切回历史 Tab 不再重新查询或重置来源、项目筛选与当前内容。
- 修复项目筛选“全部项目”空值触发 Radix Select 运行时错误导致历史页黑屏的问题。
- 修复在会话历史页新建内部终端后不会自动跳转的问题；新建终端会自动激活并显示在会话历史 Tab 右侧。

### 精简模式与命令面板体验

- `npm run dev` 改为通过 `scripts/dev-server.mjs` 启动 Vite：端口 1420 已有 CLI-Manager 开发服务时自动复用，若被其他进程占用则明确报错，减少 Tauri 开发启动冲突。
- 命令面板接入共享弹层、输入框与卡片样式，并优化分组标题与选中态，使 Ctrl+P 入口与精简模式视觉保持一致。
- 项目树 CLI 工具徽标改为轻量点状色标，降低 Claude / Codex / Gemini 标识在侧栏中的视觉噪音。

### 性能与启动优化

- 会话历史列表与搜索结果接入虚拟滚动，降低大量历史记录下的 DOM 渲染开销，并保留时间分组、搜索命中与加载更多状态。
- 应用启动后的自动同步与版本检查延后到首屏完成后执行，减少启动阶段阻塞与首屏抖动。
- 终端输出写入与渲染路径继续收紧：保留隐藏标签页有界缓冲，并增强 WebGL 渲染失败或上下文丢失后的降级稳定性。

### 项目树与历史列表修复

- 修复折叠分组参与拖拽排序时的交互问题，项目树节点在折叠/展开和拖拽状态下保持一致。
- 合并远端历史会话改动时保留虚拟列表与删除入口，避免历史列表在合并后丢失性能优化或删除操作。
- 历史会话查看流程补充路径、来源与项目边界校验，降低跨项目读取历史文件的风险。

## [V0.2.0] - 2026-06-01

### 历史用量统计入口

- 侧栏底部恢复历史用量统计看板入口，点击后全局打开既有分析看板。
- 移除侧栏底部云同步上传/下载快捷按钮，云同步状态入口保留并跳转同步设置。
- 修复分析看板全局挂载后的黑屏问题，并兼容 Radix Select 不允许空字符串选项值的约束。

### 终端标签运行状态

- 终端标签状态点升级为统一运行态：支持“运行中 / 待审批 / 已完成 / 异常退出”，并按 `待审批 > 异常退出 > 运行中 > 已完成` 优先级合并 Hook 与 shell 状态。
- Claude Code 与 Codex CLI 的 `UserPromptSubmit` hook 会将对应标签切换为“运行中”，避免 CLI 刚启动就误显示运行中。
- 新增 PowerShell / pwsh 通用 shell 运行监控，通过会话级私有 OSC marker 更新命令开始、完成与异常退出状态；设置页可关闭该监控。

### 终端 Shell 设置

- 新增项目弹窗与终端设置的默认 Shell 下拉框新增独立 `Git Bash` 选项，保存值为 `gitbash`，不改变现有 `Bash` 行为。
- `gitbash` 会从 Git for Windows 常见安装路径、Git PATH 目录与可用的 Windows 注册表信息解析 Git Bash。
- 找不到 Git Bash 时，应用会报告明确错误，不再回退到缺失的 `bash.exe`。

### Hook 设置增强

- 修复 Claude / Codex Hook 自定义配置目录未持久化的问题，切换设置页后继续保留用户选择的安装位置。
- Claude / Codex Hook 设置页新增运行中 Hook 安装状态，展示 `UserPromptSubmit` 是否已写入。
- Codex Hook 安装状态新增 `config.toml` 路径与 `[features].hooks` 检查项，并将其纳入“已安装”判定。
- Hook 弹框新增全局开关与自动关闭时间配置；关闭弹框后仍保留终端标签状态点更新。

### Codex Hook 通知

- 新增 Codex CLI hook 桥接，复用本地回环通知服务接收 `PermissionRequest` / `Stop` 事件，并按来源区分 `claude` / `codex` 通知来源。
- 终端标签通知逻辑扩展为兼容 Claude 与 Codex，切换到目标标签后自动清理对应通知。
- 新增 Codex hook 安装/卸载逻辑，写入 `~/.codex/hooks.json` 与 `~/.codex/config.toml`，并生成 `notify-cli-manager-codex-attention.ps1` / `notify-cli-manager-codex-finished.ps1`。

### Hook 设置调整

- Hook 设置页拆分为 Claude / Codex 两套配置状态与操作，分别展示路径、安装状态和安装/删除入口。
- Claude Hook 安装逻辑继续只处理 `settings.json` 内的 `Notification` / `Stop` / `StopFailure`，避免覆盖用户自定义 hook。
- Hook bridge 日志文案统一为 CLI hook，便于区分来源。
- Hook 设置页 Claude 配置入口按钮改为“选择 Claude 目录”，并将刷新状态按钮移到安装操作之后。

### 终端修复

- 修复 Codex CLI 高频重绘时反复发送光标显示/隐藏 ANSI 序列导致内嵌终端光标快速闪动的问题；前端延迟合并 `CSI ?25h`，并保留 `CSI ?25l` 立即生效。
- 修复内部终端标签与左侧项目树选中态不同步的问题：切换项目终端标签会同步选中对应项目；选中已有终端的项目时会激活第一个匹配标签。
- 修复项目行启动按钮双击时事件冒泡到项目行双击处理，导致一次操作额外创建终端的问题；显式启动仍允许同项目多开终端。

### 启动体验修复

- 主窗口启动时默认居中显示，不再出现在屏幕左上角。
- 启动首帧使用默认深色背景，并在设置加载完成前延迟渲染侧栏与终端布局，避免白屏闪烁和左右区域抖动。

## [V0.1.8] - 2026-05-29

### Claude Hook 标签通知

- 新增 Claude Code Hook 桥接：应用启动本地回环通知服务，为每个 PTY 会话注入 `CLI_MANAGER_TAB_ID`、`CLI_MANAGER_NOTIFY_PORT` 与 `CLI_MANAGER_NOTIFY_TOKEN`，接收 `Notification` / `Stop` / `StopFailure` 事件并映射到对应终端标签。
- 终端标签状态点从进程状态切换为 Claude 通知状态，支持“需要处理 / 已完成 / 执行异常”三种提示；切换到目标标签后自动清除该标签通知。
- 右上角新增 Claude Hook 悬浮通知卡片，支持查看目标标签、忽略、关闭单条通知；多条通知按从上到下固定间距排列，不再依赖鼠标悬浮展开。

### Hook 设置

- 设置页新增「Hook 设置」入口，可选择 Claude 配置目录，一键安装或删除 `notify-cli-manager-approval.ps1` 与 `notify-cli-manager-finished.ps1`。
- 安装逻辑会合并写入 Claude `settings.json` 的 `Notification`、`Stop`、`StopFailure` hook，不删除用户自定义 hook；删除时只清理 CLI-Manager 自己的脚本与命令。
- Hook 设置页展示 Claude 配置目录、hooks 目录、settings.json 路径与安装状态，并统一 Notification 脚本和 Stop / StopFailure 脚本检测框尺寸。

## [V0.1.6] - 2026-05-27

### WebDAV 同步增强

- WebDAV 云同步支持按设备名称保存独立快照，默认设备名来自系统计算机名，避免多设备项目路径互相覆盖。
- 设置页新增应用打开/关闭时自动同步动作，可分别配置为关闭、上传或下载；自动同步失败或冲突只提示，不阻塞启动/退出。
- 手动上传/下载前新增本地与云端摘要对比弹框；从云端恢复支持按项目、分组、命令模板选择覆盖范围。
- 从云端恢复时若当前设备云端快照为空，会提示“无法从云端同步”并阻止覆盖本地；首次上传仍可创建云端设备快照。
- 更新 WebDAV 同步契约 spec，明确设备名清洗、远端路径、冲突策略、旧快照兼容与部分覆盖规则。

### 终端修复

- 禁用应用启动时自动恢复历史终端会话，避免旧会话在启动阶段自动重建 PTY；启动流程仍会加载设置、同步配置与项目列表。
- 修复终端容器异常变窄时向后端同步过小 cols/rows 的问题：前端忽略不可见或低于最小尺寸的 resize，后端对 PTY resize 尺寸增加下限保护。

## [V0.1.5] - 2026-05-26

### 设置与侧栏 UI 优化

- 主界面侧栏底部入口精简：移除主题选择、统计看板、外部终端与精简模式快捷开关，仅保留云同步入口，并在其后提供设置按钮。
- 设置页信息架构调整：「终端主题」更名为「终端设置」，集中默认 Shell、外部 PowerShell、终端字体、实时预览、终端主题与背景配置；内部 tab id 继续沿用 `terminal-theme`。
- 「侧栏与行为」移回通用设置，包含精简模式、侧栏密度、关闭按钮行为与调试模式；精简模式置顶展示但移除「推荐」标签。
- 「主题详情」与「终端实时预览」合并为「终端预览」：窄屏时位于「终端行为」与「终端主题模式」之间，宽屏时保持右侧预览布局。
- 设置选择卡片去除选中态外圈光晕，保留边框、背景与文字颜色作为基础选中反馈。

### 终端背景图自定义

- 内置终端支持自定义背景图片（JPEG / PNG / GIF），可调整图片不透明度、适配模式（cover / contain / center / tile）、9 宫格位置、高斯模糊与暗化覆盖。
- 全局生效；终端 Tab 右键菜单新增「隐藏/显示背景图」，临时隐藏不影响全局设置，会话关闭后状态清理。
- 后端新增 `src-tauri/src/commands/background.rs`：`save_background_image` / `cleanup_unused_backgrounds` / `background_image_exists` 三个 Tauri command。
- 图片以 SHA-256 内容寻址命名，复制到 `$APPLOCALDATA/backgrounds/<hash>.<ext>`；包含 `validate_relative_path` + canonicalize 双层路径防护，`assetProtocol.scope` 严格锁定到 `$APPLOCALDATA/backgrounds/**`。
- 设置入口并入「主题」页：新增 `src/components/settings/pages/TerminalBackgroundSection.tsx`，提供开关、图片选择、滑杆、9 宫格定位、缩略图预览与缺失提示。
- 启动时若背景图文件缺失（设备迁移 / 用户清理）会优雅回退至无背景图状态，并在设置页提示重选。
- 关联引入 `tauri-plugin-fs`（受 capability 限制于 `fs:default`）与 `tempfile`（仅作为 dev dep）。

### 终端渲染修复

- 修复开启背景图时部分 DOM 文字（输入区 textarea / 链接层 / 装饰层 / 滚动条等）变模糊的问题：`.ui-terminal-bg-layer` 改用 `position: relative + z-index: 0` 建立 stacking context，替代 `isolation: isolate`，避免 GPU 合成层提升导致 DOM 子像素抗锯齿降级为灰阶。
- 修复带 SGR 高亮的小字号文字在高频背景图（如插画 / 复杂图案）上发糊、颜色异常的问题：`applyTransparency(theme, darkenPct)` 根据用户「暗化」值在 cell 背景注入深色 alpha 地板（系数 0.6），字符边缘 subpixel 像素叠加到稳定深色底而非花花绿绿的图像像素，文字边缘清晰可读，图片仍透出。
- xterm `allowTransparency` 改为构造期无条件 `true`，配合 hot-update effect 仅切换 `terminal.options.theme`，避免在背景图开关时整体重建 Terminal 导致 scrollback / PTY 连接丢失。

## [V0.1.4] - 2026-05-22

### 终端渲染修复

- 修复内部终端在显示带 ANSI 颜色的 diff 日志（如 `gh run view --log` 输出的 GitHub Actions 日志）时，左侧出现红色竖条 / 背景串色的间歇性渲染异常。
- 根因为 PTY reader 在 chunk 边界切断了 UTF-8 多字节字符或 ANSI CSI/OSC 转义序列，残字节被 xterm 解读为 SGR 参数从而污染背景色状态。
- 后端新增 `pty::boundary::safe_emit_boundary` 字节流边界保护：emit 前回退到最近的 UTF-8 字符边界与 ANSI 序列终结点，未完成的残尾延迟到下一轮拼接；覆盖 CSI / OSC / DCS / SOS / PM / APC / 2-byte ESC / ESC + intermediate 各类序列；含 256KB 兜底防止异常源端导致内存增长。
- 前端 `XTermTerminal` 将模块级共享 `TextDecoder` 改为 per-session 实例 + `{ stream: true }` 流式解码模式，避免跨会话状态污染；`WebglAddon` 注册 `onContextLoss` 回调，GPU 上下文丢失时自动 dispose 并回落 Canvas 渲染。
- 新增 22 个 Rust 单元测试（含穷举所有切点的 `stress_all_split_points_reconstruct` 与 500 次随机切点的 `stress_random_split_reconstructs_original`）保证字节流契约。

### 性能优化

- `src-tauri/src/commands/history.rs`：历史扫描移出 async runtime，避免阻塞主调度。
- `src/components/XTermTerminal.tsx`：削减非激活终端的 buffering，降低后台标签内存与渲染开销。
- `src/components/HistoryWorkspace.tsx` / `src/components/history/historyViewUtils.tsx`：避免历史视图中重复的 lower-case 与搜索工作。
- `src/components/history/DiffModal.tsx` / `src/lib/diffParser.worker.ts`：减小大 diff payload 体积。
- `src/stores/settingsStore.ts` / `src/components/settings/pages/GeneralSettingsPage.tsx`：高频 settings 写入做节流，降低 store 持久化压力。
- `src-tauri/src/sync/mod.rs` / `src-tauri/src/webdav/mod.rs`：收紧 sync / WebDAV 导入路径，减少 CPU 与内存占用。

### 终端主题扩展

- `src/lib/terminalThemes.ts` 新增 5 套终端配色：
  - Catppuccin Mocha / Macchiato / Latte
  - Gruvbox Dark / Light

### 工程内务

- 引入 Trellis 工作流脚本与 spec 目录（`.trellis/`），用于本地任务管理与代码规范沉淀。
- `.gitignore` 收纳 `.agents/` / `.codex/` / `.xcodemap/` 本地工具目录。

## [V0.1.3] - 2026-05-22

### 精简模式与终端输入修复

- 修复精简模式在最大化或全屏状态下切换设置时强制还原窗口的问题。
- 修复终端中文输入法组合输入期间可能触发滚动跳动的问题。

### 设置入口跳转修复

- 修复侧栏左下角「云同步」入口点击后只能进入设置首页（通用）的问题，现在会直接打开「设置 - 同步」页签。
- `SettingsModal` 支持 `initialTab` 参数；`Sidebar` / `SidebarFooter` / `SyncStatusIndicator` 的 `onOpenSettings` 升级为 `(tab?: SettingsTab) => void`，云同步入口传入 `"sync"`。

## [V0.1.0] - 2026-05-12
### 内部终端性能优化

- 优化 PTY 输出渲染：将高频输出合并后限频写入 xterm，降低 Claude Code / Codex 等 Node CLI 的持续 CPU 占用。
- 非激活终端降频刷新并关闭光标闪烁，减少后台标签页的空闲渲染开销。
- 移除默认 WebGL 渲染插件，降低长时间交互会话的显存和内存压力。
- 后端 PTY 读取缓冲从 4KB 提升到 16KB，减少大输出场景下的事件分发次数。

### 更新检测

- 应用启动后自动静默检查 GitHub 最新 Release；发现新版本时弹出提示，可直接前往更新页面。

## [V0.0.9] - 2026-04-21
### 精简模式启动器

- 新增精简模式：隐藏内嵌终端，并将项目启动行为切换为外部终端启动
- 将精简模式入口移动到主页面侧栏底部，并统一“外部终端”和“精简模式”的卡片样式
- 调整精简模式的窗口宽度切换逻辑：开启时收窄到 350，关闭时恢复到进入前宽度
- 同步更新本地项目说明和忽略规则等当前工作区内的相关改动

## [V0.1.2] - 2026-05-22

### 性能优化与增加主题

- 增加了新的主题。
- 优化了性能。

## [V0.1.1] - 2026-05-21

### 精简模式启动器

- 优化精简模式启动器与应用生命周期流程。
- 修复精简模式启动器项目树与主内容区域重叠问题。
- 统一共享表单控件在面板中的视觉与交互。

## [V0.0.8] - 2026-04-02

### 版本号显示与更新检测

- 新增 `src-tauri/src/commands/version.rs`：`get_app_version` command，返回应用版本号与名称。
- 新增 `src/stores/updateStore.ts`：更新状态管理，支持检查更新、状态流转、错误处理。
- 新增 `src/components/settings/AboutSection.tsx`：设置页面「关于」区块，显示当前版本号与检查更新按钮。
- 修改 `src/components/settings/pages/GeneralSettingsPage.tsx`：底部集成 AboutSection 组件。
- 更新检测通过 GitHub API（`dark-hxx/CLI-Manager` 仓库）获取最新 Release，支持版本比较与 Release Notes 展示。
- 有新版本时显示版本卡片，点击「下载更新」通过 `tauri-plugin-opener` 打开浏览器。

## [V0.0.7] - 2026-03-31

### WebDAV 云同步

- 新增 `src-tauri/src/webdav/` 目录：WebDAV 客户端实现，支持 CONNECT/GET/PUT/DELETE 请求。
- 新增 `src-tauri/src/sync/` 目录：同步数据打包、解包、冲突检测逻辑。
- 新增 `src-tauri/src/commands/sync.rs`：`sync_test_connection` / `sync_upload` / `sync_download` Tauri commands。
- 新增 `src/stores/syncStore.ts`：同步状态管理，支持 WebDAV 配置、上传/下载、冲突解决。
- 新增 `src/components/settings/pages/SyncSettingsPage.tsx`：WebDAV 配置页面，支持 URL、用户名、密码输入与连接测试。
- 新增 `src/components/sidebar/SyncStatusIndicator.tsx`：侧栏底部同步状态指示器，显示同步状态、上次同步时间、上传/下载按钮。
- SQLite migration v7：新增 `sync_meta` 表，存储设备 ID 与最后同步时间。
- 同步范围：项目、分组、命令模板；支持冲突检测与本地/远程优先解决策略。

### 终端会话恢复

- 新增 `src/stores/sessionStore.ts`：使用 `tauri-plugin-store` 持久化终端会话元数据到 `sessions.json`。
- 修改 `src/lib/types.ts`：`TerminalSession` 扩展 `cwd`/`shell`/`envVars`/`startupCmd` 字段；新增 `PersistedSplit` 类型。
- 修改 `src/stores/terminalStore.ts`：新增 `restoreSessions` 方法，刷新后重建 PTY 并恢复分屏布局；应用关闭时清除持久化数据。
- 修改 `src/App.tsx`：初始化流程加载 `sessionStore` 与 `syncStore`，调用 `restoreSessions` 恢复终端。

## [V0.0.6] - 2026-03-26

### UI Refactor
- 设置系统完成容器拆分：新增 `src/components/settings/` 下布局、导航、顶部栏与四个页面（通用/终端主题/快捷键/命令模板），`SettingsModal` 改为页面级容器。
- 设置弹层改为全屏覆盖并保留系统标题栏区域，修复打开设置后右侧大面积留白与布局错位问题；`SettingsModal` 通过 `Portal` 挂载，避免受侧栏容器裁剪影响。
- 主界面按 `prototype/风格/DESIGN.md` 重构视觉体系：落地 Surface Layering、No-Line Rule、Primary 渐变 CTA、Glass 浮层与统一状态层级。
- 侧栏与终端工作区重构：`Sidebar`、`ProjectTree`、`TreeNodeItem`、`TerminalTabs`、`WindowTitleBar`、`EmptyState` 样式统一，去除硬分割线，改为背景层级区分。
- Command Template / Command History 面板样式统一为玻璃浮层；上下文菜单、按钮、输入框、分段控件统一交互反馈与 focus ring。

### 主题与可读性修复
- 修复“浅色应用 + 黑色终端”场景下终端空态文案对比度不足问题：新增 inverse 文本 token，并为终端空态启用高对比模式。
- 增强“配色方案卡片”选中态可见性：增加明显高亮环、选中徽标与色块强化，提升当前方案识别效率。
- 修复配色联动问题：浅色配色方案不再固定红色强调色，左侧树与选中态颜色随 `warm-paper / cream-green / ink-red` 方案切换。

### 其他
- 终端主题预设补充元数据（`family` / `tone`）用于主题页分类展示与筛选。
- 命令模板作用域支持强化（全局/项目/会话）并补充相关设置页交互收口。

## [V0.0.5] - 2026-03-25

### 分析看板图表升级（S1~S4）

#### S1：趋势 + Token 构成
- 新增 `src/components/stats/StatsTrendChart.tsx`：会话/消息趋势组合图，支持 hover、键盘聚焦与日期下钻。
- 新增 `src/components/stats/StatsTokenDonut.tsx`：输入/输出 Token 环形构成图。
- `src/components/stats/StatsPanel.tsx`：接入 C1/C2/C3 到主分析区。

#### S2：项目与模型构成
- 新增 `src/components/stats/StatsProjectBar.tsx`：项目活跃 TopN 横向柱图，支持点击柱条按项目过滤。
- 新增 `src/components/stats/StatsModelComposition.tsx`：模型构成图（前 5 模型 + 其他合并）。
- `src/components/stats/StatsPanel.tsx`：接入 C4/C5 图表组件。

#### S3：热力图统一交互
- `src/components/stats/TimelineHeatmap.tsx`：统一图表交互样式（hover/selected 高亮、键盘方向键导航、Enter/Space 下钻、增强 a11y 标签）。

#### S4：后端扩展并落地
- `src-tauri/src/commands/history.rs`：扩展 `history_get_stats` 返回字段：
  - `daily_series`
  - `source_distribution`
  - `project_efficiency`
  - `hourly_activity`
- `src/lib/types.ts` + `src/stores/historyStore.ts`：补充新字段类型定义与归一化。
- 新增图表组件：
  - `src/components/stats/StatsTokenTrendChart.tsx`（C7 Token 日趋势）
  - `src/components/stats/StatsSourceComparisonChart.tsx`（C8 来源对比）
  - `src/components/stats/StatsProjectEfficiencyScatter.tsx`（C9 项目效率散点）
  - `src/components/stats/StatsHourlyActivityChart.tsx`（C10 活跃时段分布）
- `src/components/stats/StatsPanel.tsx`：接入 C7~C10。

### 分析看板

#### 历史统计后端
- `src-tauri/src/commands/history.rs`：新增 `history_get_stats`，支持按来源/项目/时间范围聚合历史会话统计。
- 统计维度包含：会话数、消息数、输入/输出 Token、项目活跃排行、模型占比、日级热力图数据。
- `src-tauri/src/lib.rs`：注册 `history_get_stats` command。

#### 前端数据与类型
- `src/lib/types.ts`：新增 Stats 相关类型（项目排行、模型占比、热力图、整体 payload）。
- `src/stores/historyStore.ts`：新增 `loadingStats`、`stats`、`loadStats`，并补充后端返回结构归一化。

#### 分析看板 UI
- 新增 `src/components/stats/StatsPanel.tsx`：统计卡片、项目排行、模型占比、日期会话清单。
- 新增 `src/components/stats/TimelineHeatmap.tsx`：活跃热力图，支持点击日期。

#### 入口与挂载调整
- `src/components/sidebar/index.tsx`：新增看板入口按钮，位置在“设置”按钮左侧。
- `src/App.tsx`：全局挂载 `StatsPanel`，避免只覆盖侧边栏区域。
- `src/components/HistoryWorkspace.tsx`：移除历史详情区内的看板入口，防止入口重复。

### 核心增强

#### 历史会话列表与交互
- `src/components/HistoryWorkspace.tsx`：新增会话时间分组（Today/Yesterday/This Week/This Month/Earlier）
- `src/stores/settingsStore.ts`：新增 `historySidebarWidth`，历史侧栏宽度可持久化
- `src/components/HistoryWorkspace.tsx`：优化左右拖拽性能（拖动过程帧节流，松手后持久化）
- `src/components/HistoryWorkspace.tsx`：修复拖拽宽度计算问题（相对容器左边界计算），恢复可拖动性
- `src/components/HistoryWorkspace.tsx`：移除分支筛选（历史日志分支值稳定性不足）

#### Diff 视图增强
- 新增 `src/components/history/DiffModal.tsx`：支持 Unified Diff 与 Codex `*** Begin Patch` 风格展示
- `src/components/HistoryWorkspace.tsx`：接入 Diff 入口与“跳回触发消息”联动
- `src/components/history/DiffModal.tsx`：新增行级高亮（新增/删除/hunk/header）
- `src/components/history/DiffModal.tsx` + `src/App.css`：修复横向滚动体验，代码块内独立滚动并保留可见滚动条样式

#### 历史解析兼容增强
- `src-tauri/src/commands/history.rs`：增强 `parse_message`，支持从 `custom_tool_call` / `tool_call` / `file-history-snapshot` 中提取 patch 内容
- `src-tauri/src/commands/history.rs`：新增 `looks_like_patch` 规则，提升 diff 命中率并降低无关内容噪声

#### 模板作用域增强
- `src/stores/templateStore.ts`：新增会话级模板（内存态）与生命周期清理逻辑
- `src/components/CommandTemplatePanel.tsx`：模板创建支持全局/项目/会话作用域
- `src/components/CommandPalette.tsx`：模板检索按当前项目 + 当前会话上下文合并

### 验收

#### 历史会话后端能力
- 新增 `src-tauri/src/commands/history.rs`，提供 `history_list_sessions`、`history_get_session`、`history_search` 三个 Tauri commands
- 支持扫描 Claude 与 Codex 的本地会话 JSONL 文件，提取消息、标题、时间、分支等摘要信息
- `src-tauri/src/commands/mod.rs` / `src-tauri/src/lib.rs` 注册历史命令
- SQLite migration v6：新增 `session_meta` 表与索引（别名、收藏、标签等会话元数据）

#### 历史会话前端工作区
- 新增 `src/stores/historyStore.ts`，统一管理历史工作区状态、会话列表、全局搜索、会话详情与元数据更新
- 新增 `src/components/HistoryWorkspace.tsx`，支持：
  - 来源筛选（Claude/Codex）
  - 全局搜索命中跳转
  - 会话内搜索高亮与上下跳转
  - 别名/标签编辑与收藏
- `src/components/TerminalTabs.tsx` 集成 History 入口按钮并支持切换历史工作区
- `src/components/CommandPalette.tsx` 新增“打开历史会话”动作
- `src/hooks/useKeyboardShortcuts.ts` 新增：
  - `Ctrl+K` 打开历史会话并聚焦全局搜索
  - `Ctrl+F` 在历史工作区内聚焦会话内搜索
- `src/lib/types.ts` 新增 History 相关类型定义

#### 其他
- `src-tauri/.gitignore` 增加 `/target-check*/`，避免临时校验目录入库

## [V0.0.4] - 2026-03-18

### UI 优化（按 `ui-optimization.md` 实施）

#### 设计系统与视觉统一
- `App.css` 重构为 Tailwind CSS 4 `@theme` Token 模式，统一主题色与动画时长变量
- 新增 `lucide-react` 图标体系，替换主要内联 SVG，统一图标尺寸与线宽风格
- `App.tsx` 挂载 `sonner` 的 `<Toaster />`，建立全局通知能力（含主题适配）

#### 侧边栏架构重构
- `Sidebar.tsx` 拆分为 `src/components/sidebar/` 模块化结构（`index.tsx` + `TreeNodeItem.tsx` + `TreeContext.tsx`）
- 新增树操作上下文 `TreeContext`，减少层层透传回调，提升可维护性
- 新增侧边栏拖拽调宽（180-500px）并持久化到 `settingsStore.sidebarWidth`

#### 交互体验增强
- 新增 `src/components/ui/EmptyState.tsx` 与 `src/components/ui/Skeleton.tsx`，用于终端空态与项目区加载态
- `TerminalTabs.tsx` 终端空态升级，提供显式引导动作
- `ConfigModal.tsx` / `ConfirmDialog.tsx` / `SettingsModal.tsx` / `CommandPalette.tsx` 等组件统一进入动画
- `src-tauri/tauri.conf.json` 增加窗口最小尺寸（`minWidth: 800`, `minHeight: 500`）

### Bug 修复
- **[High]** 终端 Tab 切换后内容混乱
  - `XTermTerminal.tsx`：ResizeObserver 回调增加可见尺寸守卫，隐藏 Tab 不再向 PTY 发送 `0 cols/rows`
  - `XTermTerminal.tsx`：新增激活态重算逻辑，Tab 切回时主动 `fit()` 恢复终端网格
  - `SplitTerminalView.tsx` / `TerminalTabs.tsx`：透传 `isActive` 至终端组件
- **[High]** 内置终端在底部输入中文时，候选框触发界面抽搐变形
  - `XTermTerminal.tsx`：`fit()` 改为 `requestAnimationFrame` 合并调度，避免高频重复重排
  - `XTermTerminal.tsx`：ResizeObserver 增加尺寸去重（微小抖动不触发 fit）
  - `XTermTerminal.tsx`：输入法组合输入（`compositionstart/end`）期间暂停自动 fit，结束后一次性重算
- **[Medium]** 外部终端启动失败缺少可见反馈
  - `externalTerminal.ts`：启动异常从控制台日志升级为 `toast.error` 用户提示

## [V0.0.3] - 2026-03-16

### 功能扩展

#### 3.2 终端分屏
- 新增 `src/components/SplitTerminalView.tsx` — 分屏渲染组件，支持水平/垂直分割，可拖拽分隔条调整比例（20%-80%）
- 修改 `src/stores/terminalStore.ts` — 新增 `SplitState` 类型、`splits` 状态、`splitTerminal`/`unsplitTerminal`/`setSplitRatio` 方法
- 修改 `src/components/TerminalTabs.tsx` — 用 SplitTerminalView 替换直接渲染，右键菜单增加分屏/取消分屏选项

#### 3.3 命令面板（Ctrl+P）
- 新增 `src/components/CommandPalette.tsx` — 全局命令面板，模糊搜索项目/命令模板/操作，键盘导航（↑↓ 选择、Enter 执行、Escape 关闭）
- 修改 `src/hooks/useKeyboardShortcuts.ts` — `Ctrl+P` 触发命令面板，不受输入框焦点影响
- 修改 `src/stores/settingsStore.ts` — 新增 `commandPalette` 快捷键，加载时合并新旧快捷键配置防止字段缺失
- 修改 `src/components/SettingsModal.tsx` — 快捷键设置面板增加"命令面板"项
- 修改 `src/App.tsx` — 挂载 CommandPalette 组件

#### 终端 Tab 拖拽排序
- 修改 `src/stores/terminalStore.ts` — 新增 `reorderSessions` 方法
- 重写 `src/components/TerminalTabs.tsx` — 提取 `SortableTab` 组件，集成 dnd-kit 水平拖拽排序，5px 激活距离，拖拽半透明反馈

### 外部终端增强
- 新增 `src-tauri/src/commands/shell.rs` — `open_windows_terminal` Tauri command，支持多 Tab 批量打开、按项目 Shell 配置启动
- 修改 `src/lib/externalTerminal.ts` — 前端 `openWindowsTerminal` 接口对接后端 command

### 日志系统
- 新增 `src-tauri/src/commands/logging.rs` — `set_debug_logging` command，支持运行时切换日志级别
- 新增 `src/lib/logger.ts` — 前端日志桥接，`attachConsole` 接收 Rust 日志，`logInfo`/`logWarn`/`logError` 显式记录

### Bug 修复
- **[High]** `lib.rs` — 日志时区从 UTC 改为本地时区（`TimezoneStrategy::UseLocal`）
- **[High]** `shell.rs` — 外部终端标题被 Shell 覆盖，添加 `--suppressApplicationTitle` 参数
- **[High]** `XTermTerminal.tsx` — 终端内 Ctrl+V 粘贴无效，添加剪贴板读取并写入 PTY
- **[High]** `logger.ts` — `wrapConsole` + `attachConsole` + Webview 日志目标形成递归死循环，移除 `wrapConsole` 修复

## [V0.0.2] - 2026-03-13

### 功能扩展

#### 2.1 命令历史记录与搜索
- 新增 `src/stores/commandHistoryStore.ts` — 命令历史 Zustand store，SQLite 持久化，最大 1000 条 FIFO 清理
- 新增 `src/components/CommandHistoryPanel.tsx` — 终端 Tab 栏命令历史下拉面板，支持搜索和一键重放
- 修改 `src/components/XTermTerminal.tsx` — 添加 `inputBuffer` 追踪键入，Enter 时自动记录命令
- 修改 `src/components/TerminalTabs.tsx` — 集成 CommandHistoryPanel 按钮
- 修改 `src/lib/types.ts` — 新增 `CommandHistoryEntry` 接口
- SQLite migration v4：`command_history` 表 + 索引（project_id、executed_at）
- 自动去重：同项目连续相同命令不重复记录

#### 2.2 拖拽排序
- 新增依赖 `@dnd-kit/core`、`@dnd-kit/sortable`、`@dnd-kit/utilities`
- 修改 `src/components/Sidebar.tsx` — 集成 dnd-kit，`TreeNodeItem` 使用 `useSortable` hook
- 支持根级和分组内拖拽排序，排序结果持久化到 SQLite
- 修改 `src/stores/projectStore.ts` — 新增 `reorderItems()` 方法

#### 2.3 空状态引导
- 修改 `src/components/Sidebar.tsx` — 无项目时显示欢迎信息、快速添加按钮和使用提示

#### 2.4 项目健康检查
- 新增 `src-tauri/src/commands/fs.rs` — `check_paths_exist` Tauri command，批量验证路径有效性
- 修改 `src-tauri/src/commands/mod.rs` — 注册 `fs` 模块
- 修改 `src-tauri/src/lib.rs` — 注册 `check_paths_exist` handler
- 修改 `src/stores/projectStore.ts` — `fetchAll()` 调用路径验证，维护 `projectHealth` 状态
- 修改 `src/components/Sidebar.tsx` — 路径无效时项目节点显示警告三角图标

#### 2.5 多 Shell 支持
- SQLite migration v5：`projects` 表新增 `shell` 列（默认 `powershell`）
- 修改 `src-tauri/src/pty/manager.rs` — 新增 `resolve_shell()` 支持 powershell/cmd/pwsh/wsl/bash
- 修改 `src-tauri/src/commands/terminal.rs` — `pty_create` 新增 `shell` 参数
- 修改 `src/stores/terminalStore.ts` — `createSession` 传递 shell 参数
- 修改 `src/components/ConfigModal.tsx` — 新增 Shell 下拉选择器
- 修改 `src/lib/types.ts` — Project 接口新增 `shell` 字段，新增 `SHELL_OPTIONS` 常量
- 修改 `src/lib/externalTerminal.ts` — 支持按项目配置启动不同 Shell 的外部终端

### Bug 修复
- **[High]** `externalTerminal.ts` — 外部终端硬编码 powershell，改为根据项目 shell 配置动态选择
- **[Medium]** `Sidebar.tsx` — "外部 PowerShell" 标签改为 "外部终端"，匹配多 Shell 支持

### 其他变更
- 替换应用图标为 folder+shell 风格图标（512x512 PNG → `npx tauri icon` 生成全尺寸）

### 设置系统

#### 2.1 集中设置入口
- 新增 `src/components/SettingsModal.tsx` — 四 Tab 设置弹窗（通用 / 终端主题 / 快捷键 / 命令模板）
- 修改 `src/components/Sidebar.tsx` — Footer 添加齿轮按钮打开设置弹窗

#### 2.2 终端主题预设注册表
- 重写 `src/lib/terminalThemes.ts` — 扩展为 10 套预设配色（Tokyo Night Dark/Light、Dracula、Monokai、Nord、Solarized Dark/Light、One Dark、GitHub Dark/Light）
- 修改 `src/stores/settingsStore.ts` — 新增 `terminalThemeName` 字段，支持 `"auto"`（跟随应用主题）或按 ID 指定
- 修改 `src/components/XTermTerminal.tsx` — 新增 `terminalThemeName` prop，按名称获取主题
- 修改 `src/components/TerminalTabs.tsx` — 从 store 读取 `terminalThemeName` 传递

#### 2.3 快捷键可配置
- 修改 `src/stores/settingsStore.ts` — 新增 `keyboardShortcuts` 字段（`ShortcutAction` → 组合键映射）
- 重写 `src/hooks/useKeyboardShortcuts.ts` — 从 store 读取快捷键替代硬编码，导出 `eventToCombo` 工具函数
- 设置弹窗快捷键 Tab 支持录制模式修改快捷键、恢复默认

#### 2.4 命令模板管理增强
- 设置弹窗命令模板 Tab 支持完整的增删改操作、行内编辑

### Bug 修复
- **[High]** `TerminalTabs.tsx` — 将 New/Templates 按钮移出 `overflow-x-auto` 滚动容器，修复下拉面板被裁剪导致 Templates 按钮"无法点击"的问题，同时保证按钮在标签过多时不会被挤走

### 功能扩展

#### 1.1 命令模板系统
- 新增 `src/stores/templateStore.ts` — 命令模板 Zustand store，支持 SQLite CRUD
- 新增 `src/components/CommandTemplatePanel.tsx` — 终端 Tab 栏内的命令模板下拉面板
- 修改 `src/lib/types.ts` — 新增 `CommandTemplate`、`CreateTemplateInput`、`UpdateTemplateInput` 类型定义
- 支持变量替换：`${projectPath}`、`${projectName}`
- 模板区分全局与项目级，按当前活跃项目自动筛选

#### 1.2 终端主题跟随应用主题
- 新增 `src/lib/terminalThemes.ts` — 提供 dark/light 两套终端配色（Tokyo Night 风格）
- 修改 `src/components/XTermTerminal.tsx` — 新增 `resolvedTheme` prop，主题切换时仅更新颜色不重建终端实例
- 修改 `src/components/TerminalTabs.tsx` — 透传 `resolvedTheme` 至 XTermTerminal

#### 1.3 基础键盘快捷键
- 新增 `src/hooks/useKeyboardShortcuts.ts` — 全局键盘快捷键
  - `Ctrl+Shift+T` 新建终端
  - `Ctrl+W` 关闭当前终端
  - `Ctrl+Tab` / `Ctrl+Shift+Tab` 切换终端标签
- 修改 `src/App.tsx` — 注册 `useKeyboardShortcuts()` hook

#### 1.4 项目/终端状态指示器
- 修改 `src-tauri/src/pty/manager.rs` — 新增 `PtyProcessStatus` 结构体，reader 线程退出时上报进程状态（running/exited/error）
- 修改 `src-tauri/src/commands/terminal.rs` — 新增 `pty_status` command
- 修改 `src-tauri/src/lib.rs` — 注册 `pty_status` handler
- 修改 `src/stores/terminalStore.ts` — 新增 `SessionStatus` 类型，监听 `pty-status-{sessionId}` 事件
- 修改 `src/components/TerminalTabs.tsx` — Tab 标签前显示状态圆点（绿/橙/红）
- 修改 `src/components/Sidebar.tsx` — 项目节点显示聚合状态指示器，使用 `useCallback` 优化

### 审计修复
- **[Critical]** `XTermTerminal.tsx` — 从初始化 `useEffect` 依赖数组移除 `resolvedTheme`，防止主题切换时销毁终端缓冲区
- **[High]** `manager.rs` — `try_wait()` 的 `Err(_)` 分支映射为 `"error"` 而非 `"exited"`
- **[Medium]** `TerminalTabs.tsx` / `Sidebar.tsx` — 状态指示点添加 `role="status"` 和 `aria-label` 无障碍属性
- **[Medium]** `Sidebar.tsx` — `getProjectStatus` 改用 `useCallback` 稳定引用，状态回退使用 `?? "running"`
