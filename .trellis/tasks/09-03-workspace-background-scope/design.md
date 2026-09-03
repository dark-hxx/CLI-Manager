# 技术设计：工作区背景作用域

## 1. 状态契约

在现有 `TerminalBackgroundSettings` 中增加：

```ts
fillWorkspace: boolean;
```

默认值为 `false`。`migrateTerminalBackground(unknown)` 对缺失、非 boolean 值统一回退 false；不新增数据库列、Rust command 或 IPC。

`terminalBackground` 仍按现有策略排除 WebDAV 同步，因为其中包含本地图片路径。该字段只改变图片的显示作用域，不改变背景资源存储位置。

## 2. 组件与数据流

```text
settingsStore.terminalBackground
  -> App
       -> WorkspaceLayoutShell                 (主工作区内容边界)
            -> WorkspaceBackground             (根层唯一伪元素)
            -> TerminalTabs / XTermTerminal    (透明 xterm，不重复显示图片)
            -> Sidebar / TerminalSidePanel     (半透明 surface)
```

建议新增 `WorkspaceLayoutShell` 与 `WorkspaceBackground`；只有在终端子树确实需要跨层读取状态时再增加轻量 context/hook：

- context/hook（如需要）只提供 `workspaceBackgroundActive` 与已解析的 `assetUrl`，不得成为第二个根布局壳。
- `WorkspaceLayoutShell` 位于 `WindowTitleBar` 之后，负责主工作区内容边界；`WorkspaceBackground` 位于该内容区内、所有侧栏和主终端内容之前。
- `WindowTitleBar` 不在 provider/背景层覆盖范围内。
- settings 异步加载、图片路径变更或 URL 失败时，背景层安全退出；不得显示旧图片。

## 3. 两种渲染路径

### terminal-only（默认）

- `fillWorkspace=false` 时保留 `XTermTerminal` 当前 `.ui-terminal-bg-layer` 图片伪元素。
- Sidebar、终端辅助面板、Tab chrome 使用当前主题/终端皮肤背景。
- 现有会话级 `hiddenBackgroundSessionIds` 行为不变。

### workspace

- `fillWorkspace=true` 且 `enabled/imagePath/assetUrl` 有效时启用根背景层。
- `XTermTerminal` 继续使用透明 xterm theme 和已有透明归一化规则，但关闭本地图片伪元素。
- Terminal wrapper 不再设置不透明 `backgroundColor`，否则会遮住根背景。
- 被会话级隐藏的 Pane 重新使用不透明终端背景，仅遮住该 Pane；根背景、其他 Pane 和侧栏不受影响。

两种模式共用 opacity、fit、position、blur、overlayDarken 的值和语义。工作区图片必须使用一套覆盖整个内容区的 `background-size/position/repeat`，不能在每个 Pane 中重复裁剪。

## 4. 层叠与可读性

- 根图片/遮罩层 `pointer-events:none`，内容层拥有更高 z-index。
- 不使用父级 `opacity`；Sidebar、Tab chrome 和辅助面板通过 `color-mix` 生成半透明颜色。
- 输入框、项目节点、统计卡片、右键菜单、设置/确认弹层保持足够不透明。
- 保持既有 `.ui-terminal-bg-layer` 的 `z-index` 策略，不引入会提升 xterm 子树的 `isolation`/GPU 合成层。
- `ui-workspace-shell` 的应用渐变在 workspace 模式下不能覆盖或改变背景图位置；未启用时保持现有渐变。

## 5. 兼容约束

- `WorkspaceBackground` 的容器需要覆盖 standard/compact 内容区，但不改变 compact 模式的 Sidebar 业务逻辑。
- Terminal fullscreen 的边距和圆角规则继续由现有 CSS 控制；背景层随内容区一起铺满，不覆盖标题栏。
- History workspace 是 TerminalTabs 内的独立内容视图：工作区背景可以作为其外层背景，但 History 内部搜索框、列表和详情 surface 仍保持可读性。
- 资源缺失时回退到无图/现有主题，不清空用户的 `imagePath`；沿用现有 `terminalBackgroundMissing` 提示。

## 6. 文件职责边界

- `WorkspaceBackground`：根背景图层、遮罩、资源有效性和 `pointer-events`；不持有终端或面板状态。
- 工作区 context/hook：只提供 `workspaceBackgroundActive` 等窄状态；不复制 Settings 全量对象。
- `TerminalBackgroundSection`：只负责背景设置控件、禁用语义和 i18n；迁移校验不放在组件中。
- `XTermTerminal`：只消费 workspace 模式并关闭重复的局部图片层；不负责根背景 DOM 或资源加载。
- 工作区背景样式：只定义背景层与 workspace surface 变体；菜单、弹层和终端业务样式保持原有职责。
- 背景契约测试独立验证根层唯一、局部图片互斥、层叠和回退；不把面板停靠或 Tab DnD 断言混入本阶段。

拆分按职责边界执行，不以固定行数为目标；只有在一个文件同时承担上述两个以上独立职责时才继续抽取。
