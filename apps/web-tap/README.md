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
- 输入卡下的“+”提供上传图片与直接键入；“中断”对 Claude Code/Codex 发送 Esc（其他 CLI 发送 Ctrl+C）。键帽只在终端视图显示，手机默认开启、电脑默认关闭（设置可切换），正在输入消息时让出位置。
- 会话页顶栏显示标题、运行状态、连接点与 `项目 · CLI · 尺寸`，对话/终端切换按设备记住（手机默认对话，电脑默认终端）；“⋯”菜单含终端字号、设置与需二次确认的结束会话。输入卡下一行只显示主机能提供的事实：终端尺寸、项目、Git 分支与 +N −M，没有模型、用量或额度数据时不显示占位。
- 右侧栏（详情、改动、文件）在宽屏停靠、窄屏浮层，手机从右缘滑入；左侧会话导航在手机从左缘滑入，均跟手拖动关闭。弹层不使用 `inert`/`showModal()`，焦点陷阱、Esc 与焦点恢复由弹层栈处理，触屏不抢输入焦点。
- 组合消息采用 CLI 已启用的 bracketed paste，然后延迟发送 Enter；CLI 未启用时拒绝多行，避免逐行执行。不能确认送达时保留草稿并提示，不自动重发。
- 草稿及选中会话存于当前浏览器 localStorage，键按账号/设备/会话隔离。退出登录会清除挂载内容，但保留该账号的本地草稿供下次恢复；共享浏览器应清除站点数据。偏好仅存本机，不同步。
- 原生终端查询应答仍由主机拥有。浏览器只在 xterm 完成写入后推进 rendered cursor，保留 reset/replay/分片语义。渲染队列溢出会停止该终端输入，需手动重连回放，不静默丢帧。
- 桌面拥有尺寸时浏览器不 resize PTY；手机可用最后 800 行的纯文本重排阅读版，也可切回原生屏幕操作 TUI。阅读版不保留 ANSI 颜色/屏幕定位，不冒充新的 PTY。
- 手机软键盘只平移应用外框，不改变聊天/终端容器高度；底部弹层在独立 portal 跟随可视视口，可从顶部拖动关闭。

## 对话与能力边界

对话页只读主机已精确绑定的 Claude/Codex 会话记录。`terminal.transcript_events` operation 使用注册 `projectId`、可选 `worktreeId` 与 PTY `sessionId`，以字节游标增量读取；主机验证 source、CLI ID、cwd，只读取历史索引中、位于历史根目录且文件名包含该会话 ID 的记录，异步读取后再次验证绑定。解析由 `src-tauri/transcript-core` 完成，返回用户/助手正文、已记录的思考、工具步骤（输入、输出与 diff 均有上限）、计划与任务、斜杠命令及输出、错误与提示，不附带主机凭据字段或原始日志。工具输出可能包含敏感信息，应仅授权可信浏览器；服务端在转录操作结束两分钟后删除其结果。旧桌面端只有 `terminal.transcript` 时，对话页提示更新桌面端。

输入始终进入同一原生 PTY，不调用 `conversation.start/prompt`。审批仍在原生 CLI 菜单中通过键帽操作；没有伪造的消息、审批卡或终端菜单自动化。设备没有 capability、未绑定或记录缺失时明确提示，终端仍可使用；不会按目录/时间猜配另一段会话。只在对话视图可见时读取：运行中约每 1.2 秒取增量，已结束的会话读取一次；主机因单次结果上限只读到一部分时立即续读。旧页显式加载并保持阅读锚点。每轮结束后过程折叠为“工作了 Xm Ys”，工具步骤可展开 diff 与输出，命令输出保留颜色；收尾列提供复制、完成时刻、用时与本轮 +N −M。右侧跳转点（手机为面板）与对话搜索可定位任一轮，离开底部时出现“回到最新”。

本次提供文件列表/文本预览、Git 分支/变更/只读 Diff。未提供 SSH、历史恢复、消息队列、插入当前回合、用量与花费、图片缩略图、`/rewind`、Web Push、模型/审批自动切换、文件编辑或 Service Worker。PWA manifest 仅支持添加入口，不提供离线执行。

## 来源与许可

体验参考 [Tap-Code](https://github.com/tapaixx/Tap-Code)，包括会话分组、输入卡、键帽、三会话挂载和键盘平移策略。对话视图的记录解析（`src-tauri/transcript-core`）以及时间轴、跳转点、对话搜索、ANSI 与 diff 呈现移植自 Tap-Code，由 Tap-Code 原作者以本仓库许可（AGPL-3.0-or-later 及维护者的商业授权）贡献；其余客户端与视口处理在本仓库实现，PWA PNG 从本目录 `public/icon.svg` 生成。

浏览器 HTTP/socket、DTO、terminal stream、图片准备来自本仓库已有实现，抽到 `src/shared`，经典入口保留明确兼容导出及缓存副作用。新增代码沿用仓库 AGPL-3.0-or-later 许可。

Inconsolata 字体来自 `@fontsource-variable/inconsolata` 的 Latin WOFF2，按 SIL Open Font License 1.1 分发；完整许可在 `public/fonts/OFL-Inconsolata.txt`。其他依赖沿用各自许可。

## 验证

可复现命令、浏览器 fixture、截图和实机待验收项记录在 [Trellis 验证记录](../../.trellis/tasks/10-16-optional-tap-web/verification.md)。Chromium fixture 不等于 Windows/WSL 真 CLI、移动 Safari/Android 软键盘或安装包验收。

English: this optional client keeps Classic Web and the existing Cookie/device/native-PTY authority. Chat is read-only, requires an exact host-owned session binding, and shows structured events parsed on the host from the CLI's own records. No input retry, new agent host, SSH fallback, queue, Push or automatic permission bypass is introduced.
