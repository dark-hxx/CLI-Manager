# 技术设计（已获实施授权）

## 推荐方案

修复桌面共享 `TerminalMouseInteraction` 配置，保留 `mouseEventsRequireAlt: false`，增加 `macOptionClickForcesSelection: true`。由 xterm 自身根据本地浏览器平台选择 Shift 或 Option，既不依赖远端系统，也不按 Codex/Grok 进程名猜测。

同步设置 `altClickMovesCursor: false`，落实既有“不支持点击重定位光标”约定。真实库回归发现仅开启 Option 选择时，短 Option 点击会进入 xterm 默认 mouseup 路径，向 CLI 注入多次方向键；这是新选择入口必须一并阻止的副作用，不另造事件兜底。

该配置仅将 macOS Option 手势交还 xterm 选择服务；普通点击、拖动、移动和滚轮仍按现有模式进入 TUI。普通 shell 未启用鼠标上报时继续直接拖选。保留右键复制、配置复制快捷键、macOS Cmd+C 和无选区 Ctrl+C 中断，不修改剪贴板后端。

## 数据流和边界

`本地鼠标事件 -> xterm 平台/修饰键策略 -> 本地选区（本地选择）或 onData/onBinary（TUI 上报） -> 现有复制或 PTY 通道`。

生产改动所有者为 `src/features/terminal/browser/TerminalMouseInteraction.ts`；controller 仍只组合选项。策略自动覆盖桌面本地、WSL、SSH 及分屏/恢复的新实例，无需更改 daemon 快照、SSH Agent、数据库或 IPC。恢复时保留鼠标模式，而不是关闭模式伪装修复。

## 场景矩阵

| 维度 | 验收要求 |
| --- | --- |
| 平台 | Windows/Linux 上报模式 Shift 拖选；macOS 上报模式 Option 拖选；以本地前端平台为准 |
| 环境 | local/WSL/SSH 相同前端策略；Agent/Hook 安装与否不影响本地选区 |
| 模式 | 无上报直接拖选；X10/VT200/DRAG/ANY 上报下强制选择不向 PTY 发送选择手势字节；其他手势保持 TUI 交互 |
| 编码/缓冲区 | DEFAULT/SGR/SGR_PIXELS；normal/alternate 均验证文本、可见选区和上报 |
| 生命周期 | 新建、快照恢复、目标已有旧模式、重连/切 Tab 后；旧快照仍遵循现有安全恢复规则 |
| 焦点/显示 | 当前/非当前分屏、切换 Workspan/窗口、背景开关；后台/最小化无鼠标选择入口，恢复前台后验证 |
| 搜索 | 区分“无选区”与“透明选区”；已有搜索透明主题为独立风险，不借本任务重构搜索 |
| Web/Tap | 本任务以桌面用户反馈为范围；独立构造点的同类 Mac 风险已记录，不默认扩大交付 |

## 验证方案

先扩展真实 xterm 浏览器夹具，使其使用生产鼠标策略；加载前控制 navigator.platform 以验证分支，断言 selected text、选择手势上报为零以及普通 TUI 上报未变。DOM/渲染验收补充可见选区断言，不仅用程序调用 select() 代替真实拖选。复用已有快照鼠标测试，增加平台、缓冲区及模式覆盖。

MacIntel + Windows Edge 只证明 xterm 平台策略，不能替代 macOS WebKit、Cmd+C 系统剪贴板或真实远程 Codex。保留人工验收项，不启动真实用户应用/会话进行验证。

## 兼容、风险与回滚

- 既有 TUI 普通鼠标行为不变。macOS Option 拖动由应用鼠标上报改为本地文本选择，这是明确修复的兼容变化。
- 不添加依赖，不升级 xterm，不修改 node_modules，不改 wire/persistence schema。
- 静态测试不能单独证明行为；必须使用安装版真实库。
- 共享桌面配置影响所有 CLI，不能凭“只有 1 个调用点”宣称风险低。
- 回滚为撤销共享选项、相关测试和文档；不涉及用户数据迁移或删除。

## 范围确认

用户已要求修复 macOS 缺陷，按上述最小充分方案实施。`/tui fullscreen` 纳入 normal/alternate 缓冲区回归；不新增无修饰键选择策略，也不改搜索高亮行为或 Web/Tap 终端。
