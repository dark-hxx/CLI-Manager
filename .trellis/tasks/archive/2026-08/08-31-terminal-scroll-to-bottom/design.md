# 终端滚动到底部按钮技术设计

## Scope

实现一个仅属于单个 `XTermTerminal` 实例的底部快捷跳转按钮。按钮由 xterm 的公开 Buffer 状态驱动，复用终端现有的主题样式和右下角字号控件布局。

不改动 PTY、IPC、终端输出队列、滚动条 CSS、Zustand store、Tab/Pane props 或数据库协议；不新增依赖。

## State and predicate

在 `XTermTerminal` 内增加本地 UI 状态 `isScrolledAwayFromBottom`。每次需要重算时读取：

```ts
const buffer = terminal.buffer.active;
const next = buffer.type === "normal" && buffer.viewportY < buffer.baseY;
```

只有 normal buffer 且视口顶部仍低于 scrollback 底部时才显示按钮。normal buffer 已在底部时不显示，alternate buffer（例如全屏 TUI）也不显示。该判定同时意味着终端确实存在可查看的 scrollback，不依赖浏览器滚动条 DOM 或像素几何。

状态保留在组件实例中，保证分屏、Tab 切换和隐藏但保持挂载的会话互不影响。

## Event flow

在现有 xterm 实例生命周期内注册轻量的同步回调：

1. 终端打开并完成初始绑定后立即执行一次状态检查。
2. `terminal.onScroll` 覆盖滚轮、原生滚动条和键盘引起的视口移动，同时保留已有 TUI 颜色同步逻辑。
3. `terminal.onWriteParsed` 覆盖流式输出、快照恢复和清屏等解析后的 Buffer 变化。
4. `terminal.onResize` 与现有 `terminal.onRender` 覆盖 resize/reflow 后 `baseY` 或 `viewportY` 的变化。
5. 组件销毁或会话切换时通过现有 disposable 生命周期解除监听，并清理按钮状态。

状态 setter 使用“值未变化则不触发更新”的函数式写法，避免高频输出或 render 事件造成无意义重渲染。所有输出仍由 `useTerminalDisplay` / `TerminalProcessManager` 处理，本功能只观察 xterm 状态，不介入写入、ACK 或自动跟随策略。

## Click flow

按钮点击调用当前实例的 `terminalRef.current?.scrollToBottom()`，并立即将状态设为隐藏；不向 PTY 发送任何输入，不改变 store 中的会话快照。按钮的 `onMouseDown` 阻止默认行为，避免点击控制按钮使终端失去输入焦点，行为与现有字号控件一致。

## Layout and visual style

- 在终端内容左侧层的右下角增加一个 `flex-col` 控制组，位置仍为 `bottom-3 right-3`。
- 跳转按钮放在字号控件上方，尺寸为 `h-7 w-7`（28×28），圆形、边框、半透明背景和阴影复用 `terminalFontSizeControlStyle`。
- 使用已有 `ArrowDown` 图标，图标按钮仅在需要时出现；字号控件仍按原有 hover/focus 计时显示。
- 控制组位于现有终端内容层内，因此 Markdown 预览分屏时跟随终端 pane 宽度，不覆盖预览面板或 Tab 标题。
- 使用现有 `ui-focus-ring`、hover 和 backdrop-blur 类，不修改全局滚动条样式。

## Internationalization and accessibility

在 `src/lib/i18n.ts` 的 `zh` 与 `en` 字典中新增 `terminal.scrollToBottom`：

- zh-CN：`跳转到底部`
- en-US：`Jump to bottom`

该键同时用于 `aria-label` 和 `title`，不在组件中硬编码用户可见文案。zh-TW 沿用项目现有由 zh-CN 转换的机制。

## Compatibility and risk

- normal buffer 的自动跟随语义不变；只有用户离开底部时新增视觉提示。
- 多会话、分屏和隐藏会话不引入全局共享状态；每个 xterm 自己接收自己的事件。
- 初始输出、恢复快照、重连、退出/错误状态沿用现有流程。
- alternate buffer 不显示按钮，避免全屏 TUI 内部 viewport 被宿主控件干扰。
- 最新 GitNexus 精确文件级上游影响为 LOW：直接依赖 1 个、总计影响 4 个文件、无受影响执行流程；主要是 `TerminalTabs.tsx` 及其导入链。实际设计仅新增组件本地状态、公开 xterm 事件观察、一个按钮和两个翻译值，不修改跨层契约。若后续改动触及新的共享符号，仍需按规则重新评估影响。

## Verification

- 静态：`npx tsc --noEmit`、`npm run build`、`git diff --check`。
- 相关既有终端逻辑测试：运行终端 replay、reflow、resize、visibility/background 等脚本测试，确认无输出调度回归。
- 人工桌面检查：无 scrollback、位于底部、位于历史位置、点击跳转、持续输出、resize/reflow、快照恢复、Tab/分屏、多会话、字号控件共存、主题/透明背景、Markdown 预览分屏，以及 zh-CN/en-US/zh-TW 切换。
- 按项目约束不由 AI 启动 Tauri/CLI Manager 桌面服务；桌面交互验收由用户手动完成。
