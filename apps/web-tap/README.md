# Tap Web（可选工作台）

独立于经典 Web 的移动优先客户端，入口 `/tap/`。经典 `/` 与其配置、设备、原生终端保持可用；两套客户端不共享 UI 状态，仅共用浏览器协议与原生执行边界。

## 开发与构建

仓库根目录执行（Node.js 22.18+，原生 TypeScript 测试需要 Node.js 22.18+/24）：

```bash
npm ci
npm run tap:dev
```

打开 Vite 输出地址下的 `/tap/`。开发代理把 `/api`、`/ws` 转发到已有的 `127.0.0.1:8787` 服务；登录并选择已配对的在线设备。不会自动安装 CLI、创建项目或修改监听暴露范围。

```bash
npm run tap:typecheck
npm run tap:test
npm run web:build
```

`web:build` 先构建经典 Web，再构建新端到 `apps/web/dist/tap`。现有 `CLI_MANAGER_WEB_DIST` 仍指向整个 `apps/web/dist`。服务、Tauri resources 和 portable 脚本随相同目录携带两套产物。单独执行 `tap:build` 只重建新端；之后单独构建经典 workspace 会清空整个 dist，应在打包前使用根目录 `web:build`。

## 操作与数据

- 设备 → 已注册项目/Worktree → 原生 `project.start` → PTY attach。新端不会向主机发送 cwd、启动命令、环境变量或供应商密钥。
- 最近三个终端保留挂载；淘汰、关页面、切设备只解除浏览器订阅，不结束进程。“结束会话”单独确认后才发送 close。
- 手机 Enter 换行；电脑 Enter 发送；Ctrl/⌘+Enter 发送。输入法选字不触发发送。Ctrl/Alt 是下一键修饰，方向键长按连发，取消、切会话和断线都会停止。
- 对话输入 `@` 打开当前项目/Worktree 文件候选。上下键选择，Enter/Tab 或点击只补全草稿，Esc 关闭；无结果或加载中 Enter 不会误发，发送按钮或 Ctrl/⌘+Enter 可显式发送原文。文件支持目录浏览、返回上级与名称/相对路径搜索，选择插入 `@路径`（空格路径加引号），不读取文件正文。主机能力名为 `file.management`，`file.list`/`file.search` 是操作名；重复输入相同内容会开启新的候选交互。
- 对话输入 `/`（或粘贴无参数的 `/命令` 前缀）后，在当前对话页内展开同一 CLI 的原生面板，并把前缀输入一次，不附加回车。真实菜单与已加载 skills/插件跟随该会话，`/mcp` 等后续交互也在面板内完成；没有网页静态命令表或独立 MCP 设置界面，不迁移 ACP。原生命令通过键盘/下方按键操作，手机可点「键盘输入」。先在 CLI 中完成或取消并清空未发送输入，再点「返回对话」；返回按钮只收起视图，不注入取消、清空或提交按键。对话保持挂载，不修改持久视图偏好；断线/渲染失败保留草稿，不自动重发。桌面拥有网格时面板滚动显示提示行，不 resize PTY。
- 输入卡下的“+”提供上传图片与直接键入；“中断”对 Claude Code/Codex 发送 Esc（其他 CLI 发送 Ctrl+C）。键帽只在终端视图显示，手机默认开启、电脑默认关闭（设置可切换），正在输入消息时让出位置。
- 会话页顶栏显示标题、运行状态、连接点与 `项目 · CLI · 尺寸`，对话/终端切换按设备记住（手机默认对话，电脑默认终端）；“⋯”菜单含终端字号、设置与需二次确认的结束会话。输入卡下一行只显示主机能提供的事实：终端尺寸、项目、Git 分支与 +N −M，没有模型、用量或额度数据时不显示占位。
- 右侧栏（详情、改动、文件）在宽屏停靠、窄屏浮层，手机从右缘滑入；左侧会话导航在手机从左缘滑入，均跟手拖动关闭。弹层不使用 `inert`/`showModal()`，焦点陷阱、Esc 与焦点恢复由弹层栈处理，触屏不抢输入焦点。
- 组合消息采用 CLI 已启用的 bracketed paste，然后延迟发送 Enter；CLI 未启用时拒绝多行，避免逐行执行。不能确认送达时保留草稿并提示，不自动重发。
- 草稿及选中会话存于当前浏览器 localStorage，键按账号/设备/会话隔离。退出登录会清除挂载内容，但保留该账号的本地草稿供下次恢复；共享浏览器应清除站点数据。偏好仅存本机，不同步。
- 原生终端查询应答仍由主机拥有。浏览器只在 xterm 完成写入后推进 rendered cursor，保留 reset/replay/分片语义。渲染队列溢出会停止该终端输入，需手动重连回放，不静默丢帧。
- 桌面拥有尺寸时浏览器不 resize PTY；手机可用最后 800 行的「文本重排」，也可切回原生屏幕操作 TUI。文本重排只调整终端文字换行；按提问/回复阅读请使用顶部「对话」，其中正文限宽、Markdown 代码块提供语言标签、复制与折叠，并独立横向滚动。
- 手机软键盘只平移应用外框，不改变聊天/终端容器高度；底部弹层在独立 portal 跟随可视视口，可从顶部拖动关闭。

## 对话与能力边界

同一台电脑同时运行安装版和源码开发版时，它们是不同执行设备。会话栏底部的设备菜单显示「安装版 / 开发版」与「支持对话 / 仅终端」；验证新对话功能需使用有权访问开发版设备的账号或该实例签发的授权链接，再打开该实例中的会话。不同账号绑定的设备不会互相显示，手机授权只显示指定设备。重连会补入新授权设备，但不会自动切走正在查看的会话。

对话页只读主机已精确绑定的 Claude/Codex 会话记录。`terminal.transcript` operation 使用注册 `projectId`、可选 `worktreeId` 与 PTY `sessionId`，由主机验证 source、CLI ID、cwd，并在异步读取后再次验证绑定。Tap 显式请求 `includeDetails: true`，读取规范正文、工具输入/输出与日志中的明文思考/摘要；系统、metadata、未知块和思考加密/签名字段不导出，未请求详情时仍只返回正文。工具内容可能包含用户的项目数据，应仅授权可信浏览器。

「执行过程」与工具/思考详情默认折叠，收到新输出也不自动展开，手动选择在同轮刷新后保留。仅按 call ID 关联工具输入/输出；没有 ID 或跨页尚未加载的调用不猜配，不根据有结果推断成功。每页最多 40 条源消息、512 KiB JSON；正文最多 4000 UTF-16 单元，过程最多 23 块/8000 单元，每块最多 4000 单元，并明确提示截断。页被字节预算缩短时游标同步前移，不跳过记录。需使用包含新版 Rust 解析器的桌面程序，单独刷新网页无法补回旧解析器丢弃的 Codex 过程。

执行过程里的每个工具调用显示为一行摘要：图标、按界面语言的工具标签与关键参数（Claude 的 Read/Edit/MultiEdit/Write 路径、Bash 命令首行、Grep/Glob 样式、WebFetch 网址、WebSearch 关键词、Task 描述、TodoWrite、NotebookEdit；Codex 的 shell/exec_command 命令、apply_patch 涉及的文件、update_plan、view_image；MCP 显示服务器与工具名）。展开后 Edit/MultiEdit 显示由 old_string/new_string 算出的行级差异（不知道文件位置时不编行号），Write 与新增文件整份视为新增，apply_patch 按文件分组；Bash/exec 显示命令与带终端颜色的输出；TodoWrite/update_plan 显示带状态的任务清单；其他工具维持原始输入与输出。参数被截断或无法解析时不推导，退回原本的过程卡。只有 CLI 明确写出的结束码、`<tool_use_error>` 或拒绝执行才标为失败。每轮收尾列提供复制最终回答、24 小时制完成时刻、提问到最终回答的用时与本轮 +N −M；截断、replace_all、被省略的过程或本轮开头尚未加载时不计入并标「约」。右侧跳转点（触控设备为面板）与对话搜索（Ctrl/⌘+F）只针对已读取的记录，搜索命中折叠内容时临时展开，关闭搜索即恢复原折叠；读取更早的对话时以画面最上方那一项保持阅读位置。

输入始终进入同一原生 PTY，不调用 `conversation.start/prompt`。审批仍在原生 CLI 菜单中通过键帽操作；没有伪造的消息、审批卡或终端菜单自动化。顶部「对话 / 终端」始终可切换；旧主机没有 capability 时提示更新执行设备上的桌面程序（含 Web 辅助程序），重新开启桌面 Web 连接，再在网页重连；单独更新网页不能让旧主机提供记录。浏览器重连重新读取设备能力，同时保留授权设备范围和较新的设备事件。未绑定或记录缺失时明确提示，终端仍可使用；不会按目录/时间猜配另一段会话。首次打开及可见时随终端输出合并刷新，空闲/隐藏时不持续轮询；旧页显式加载并保持阅读锚点。同一轮里最终回复之前的过程回复折叠为一行（有时间戳时显示“工作了 Xm Ys”），离开底部时出现“回到最新”。

本次提供文件列表/文本预览、Git 分支/变更/只读 Diff。未提供 SSH、超过主机截断上限的完整工具参数与输出、历史恢复、消息队列、用量统计、Web Push、模型/审批自动切换、文件编辑或 Service Worker。PWA manifest 仅支持添加入口，不提供离线执行。

## 来源与许可

体验参考 [Tap-Code](https://github.com/tapaixx/Tap-Code/tree/1a3d946)，包括会话分组、输入卡、键帽、三会话挂载和键盘平移策略。对话页的工具步骤摘要规则、差异与 ANSI 呈现、跳转点与对话搜索移植自 Tap-Code（相关文件开头注明来源）；其余客户端与视口处理在本仓库实现，PWA PNG 从本目录 `public/icon.svg` 生成。

浏览器 HTTP/socket、DTO、terminal stream、图片准备来自本仓库已有实现，抽到 `src/shared`，经典入口保留明确兼容导出及缓存副作用。新增代码沿用仓库 AGPL-3.0-or-later 许可。

Inconsolata 字体来自 `@fontsource-variable/inconsolata` 的 Latin WOFF2，按 SIL Open Font License 1.1 分发；完整许可在 `public/fonts/OFL-Inconsolata.txt`。其他依赖沿用各自许可。

## 验证

可复现命令、浏览器 fixture、截图和实机待验收项记录在 [Trellis 验证记录](../../.trellis/tasks/10-16-optional-tap-web/verification.md)。Chromium fixture 不等于 Windows/WSL 真 CLI、移动 Safari/Android 软键盘或安装包验收。

English: this optional client keeps Classic Web and the existing Cookie/device/native-PTY authority. Chat is read-only and requires an exact host-owned session binding. No input retry, new agent host, SSH fallback, queue, Push or automatic permission bypass is introduced.
