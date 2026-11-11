## 背景

提供一套会话导向、移动优先的可选 Web 工作台，借鉴 Tap-Code 的输入与会话接力体验。**经典 Web 不删除、不改默认入口**；新端位于 `/tap/`，请一并审阅“双 Web”的职责与维护边界。

Trellis 任务：`.trellis/tasks/10-16-optional-tap-web`，含 PRD、设计、实施计划、协议 fixture、[验证记录](https://github.com/nnnmdzz/CLI-Manager/blob/feat/optional-tap-web/.trellis/tasks/10-16-optional-tap-web/verification.md)和[提交前双轴复审](https://github.com/nnnmdzz/CLI-Manager/blob/feat/optional-tap-web/.trellis/tasks/10-16-optional-tap-web/review.md)。按上游 Codex inline 配置实施与检查，不声称独立多代理审计。

## 改动

- 独立 `apps/web-tap`：项目/Worktree 原生启动、分组会话、最近三终端保持挂载、账号/设备/会话草稿、手机抽屉、中英文及浅/深/系统外观。
- 界面与交互按 Tap-Code 手机/桌面画面逐项复核后重新实现（不搬其源文件）：
  - 会话顶栏：状态点、标题、连接点与 `项目 · CLI · 尺寸`；对话/终端分段切换按设备记住（触屏默认对话、桌面默认终端）；⋯ 菜单收纳终端字号、设置和绑定该会话的二次确认结束，结束/设置不再是顶栏单击图标。
  - 输入区：键帽移到输入卡上方，仅终端视图显示且输入时让位（触屏默认开启，可在设置切换）；“+”菜单提供图片与直接键入；中断对 Claude Code/Codex 发 Esc（其他 CLI 仍为 Ctrl+C）；下方一行只显示终端尺寸、项目、Git 分支与 +N −M，主机不提供的模型/用量/额度不显示占位。
  - 会话栏支持搜索、CLI 图标（复用 `src/shared/ui/CliToolIcon`）、运行数与 Worktree 标记，设备切换改用菜单；右侧栏提供详情/改动（只读 Diff）/文件，宽屏停靠、窄屏浮层；手机左右抽屉支持边缘滑入与跟手关闭。
  - 对话按轮折叠过程回复，页脚为复制与 24 小时时间，长提问可展开，离开底部显示“回到最新”。设置使用主题卡、分段控件、步进器与开关，不用原生下拉框；弹层不使用 `inert`/`showModal()`，由弹层栈处理 Esc、Tab 与焦点恢复。
- 输入吸取 Tap 的经验：IME 不误发、手机 Enter 换行、桌面 Enter 发送、Shift+Tab、单次 Ctrl/Alt、可取消长按方向键；bracketed paste + 延迟 Enter，送达不确定时保留草稿，不重试输入。
- 保持原生 PTY：桌面网格权威、写屏后推进 replay cursor、分片/reset 边界、预组装与渲染队列内存上限、同网格合批和跨终端公平写屏。窄屏提供纯文本阅读版（框线截断而非折行）/原生画面切换；键盘平移外框而不重排消息。
- 新增只读 `terminal.transcript` capability/operation。主机按精确 PTY/CLI/source/cwd 验证并在 I/O 后重验，只上传分页 user/assistant 正文。**聊天输入仍进入同一 PTY，审批在 CLI 原生菜单完成**。
- 文件文本/Git 只读入口；Git 状态按项目上下文共享缓存，在激活、回到前台和发送后读取，不轮询。共用既有 Cookie/设备/operation 协议。抽取浏览器基础模块到 `src/shared`，经典兼容导出、目录缓存和完成事件副作用保留。
- `/tap/` 独立 SPA/资源路由，根 `web:build` 构建两端，Tauri/portable 资源包含新端；更新 TEMP changelog、功能清单及服务契约。

## 验证

- [x] 新旧 Web 类型检查与生产构建、桌面前端类型检查/构建。
- [x] 输入、操作完成竞态、视口、分片组装、只读转录及上下文变化回归；新增模型名、24 小时时间、阅读版框线与对话轮次分组单测（`tap:test` 共 14 项）。
- [x] 经典 Web transport/目录/图片回归；真实生产组件浏览器 smoke（11 轮回放、图片选择器、5001 块输出合批）。
- [x] Rust server 62 项 + protocol 7 项，含 Cookie/设备 scope、WS 重连、双 SPA/资源隔离。
- [x] Chromium 受控 host：桌面与 360/390/430px、草稿/选中恢复、重连不重发、IME/键帽、阅读版、文件预览、语言/外观、设备切换、手机授权确认、logout/4401 清理。
- [x] 界面对齐后按新交互更新受控 host 选择器并重跑通过：键帽仅在终端视图、结束确认在切换会话时收起而不改目标、设备菜单、右侧栏文件预览、设置分段控件。另以 CDP 触摸验证手机左右抽屉边缘滑入/拖动关闭，并检查深色与英文布局。
- [x] 详细复审复现并修复 11 项边界缺陷：确认目标冻结、跨设备旧回调/迟到 401、授权取消回放、单渲染器重连保留其他挂载、输入法 Esc/直接输入退出/字体拒绝、Unicode 截断与写屏合批/全局调度。新增生产浏览器回归含 5001 帧合为 4 次写屏、两终端分帧和粘贴后断线不补发 Enter。
- [x] 严格 2000 行架构检查、`git diff --check`。界面 detector 无发现为上一轮结果，本轮界面改动未重跑。
- [ ] **需要维护者在 Windows 上验收**（作者环境为 Linux，缺 GTK/WebKitGTK，无法构建桌面端）：① Windows/WSL 真 CLI 的会话绑定与权限交互；② 安装包与 portable 启动（`tauri.conf.json` 新增 `apps/web/dist/tap` 资源，原生 Rust 仅新增两处 `terminal.transcript` 能力名）；③ 经该桌面端连接时真实 iOS/Android 的软键盘、触控与 PWA。

截图来自协议 fixture（已按本轮界面更新），不冒充真实 CLI。[桌面对话](https://github.com/nnnmdzz/CLI-Manager/blob/feat/optional-tap-web/.trellis/tasks/10-16-optional-tap-web/screenshots/desktop-chat.png) · [手机终端](https://github.com/nnnmdzz/CLI-Manager/blob/feat/optional-tap-web/.trellis/tasks/10-16-optional-tap-web/screenshots/mobile.png) · [手机抽屉](https://github.com/nnnmdzz/CLI-Manager/blob/feat/optional-tap-web/.trellis/tasks/10-16-optional-tap-web/screenshots/mobile-drawer.png) · [手机对话](https://github.com/nnnmdzz/CLI-Manager/blob/feat/optional-tap-web/.trellis/tasks/10-16-optional-tap-web/screenshots/mobile-chat.png)。

## 边界与未覆盖

- 不另建主机、登录库、项目数据或 Hook，不接受浏览器 cwd/启动命令，不用 structured conversation 代发终端输入，不绕过原生审批。
- 无 SSH、完整工具轨迹、历史恢复、队列、用量、Web Push、菜单自动化、文件编辑、桌面会话分页标签或离线执行。旧设备/未绑定转录明确提示，终端继续可用；不猜配其他会话。
- 退出登录清理挂载内容，但保留按账号隔离的本地草稿；共享浏览器需清站点数据。阅读版仅重排最后 800 行纯文本，不是另一套 PTY。
- Linux 缺少 GTK/WebKitGTK，未完成 native Tauri 编译/实机验收。全量 rustfmt 有上游既存格式漂移，本次新增部分已整理，未扩大重排。
- 本机 build 使用补齐的依赖环境，Vite/React 与锁定版本有差异，不等同于 clean locked-install CI。锁文件只新增 workspace/link 元数据；详见验证记录的环境限定。
- Tap-Code 尚无项目级 LICENSE，本 PR 只借鉴交互规则，不搬其源文件或图标，不推定商业再许可；新实现沿用本仓库 AGPL，字体随附 OFL。

请优先审阅：是否接受独立可选客户端、共享模块边界、`terminal.transcript` 只读契约。上方未勾选的三项请在 Windows 上验收后再合并；本 PR 不包含合并或部署动作。
