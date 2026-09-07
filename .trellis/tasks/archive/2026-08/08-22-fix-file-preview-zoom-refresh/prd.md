# V1.3.8 文件预览、自动刷新与 Git Diff Markdown 修复

## Goal

修复文件编辑器 Markdown 预览的 `Ctrl + 滚轮` 字号缩放无效问题、已打开文件不能在外部变更后自动更新的问题，以及 Git Diff 窗口显示 Markdown 表格时把一个源代码行拆成多行的问题；为文件编辑器已打开的文件标签增加右键关闭菜单。

用户应能在不重开文件的情况下看到本地、WSL 与 SSH 文件的最新干净版本；Git Diff 始终按源文件逻辑行显示 Markdown 表格，而不是把表头、分隔符和单元格拆散；并能从文件标签右键关闭当前、其它、左侧或右侧文件，而不出现终端专属操作。

## Confirmed Facts

- `src/components/files/FileEditorContent.tsx:105-108` 会在预览容器上更新字号，但 `MarkdownContent` 根元素的 `text-xs` 建立固定字号；终端预览由 `src/styles/components.css:3638-3640` 的专用规则覆盖，文件预览没有对应覆盖规则。
- `src/stores/fileExplorerStore.ts:884-969` 已能按修改时间/大小重读干净的已打开文件，并保留 `content !== savedContent` 的本地草稿。
- 本地 watcher、事件订阅和 WSL 15 秒退化轮询由 `src/components/files/FileExplorerSidebar.tsx:132,905-985` 的挂载生命周期拥有；侧栏或文件面板卸载后，打开的编辑器失去刷新触发器。
- SSH 文件浏览复用受根目录约束的只读 `fileList` / `fileRead` RPC（`src/lib/sshRemoteFiles.ts:128-166`），返回 `modifiedMs`；没有远程事件推送协议。自动轮询必须沿用该只读桥接，且不得回退到本地文件 API。
- `.md` 文件在 Git Diff 中由 `src/components/git/diffHighlight.ts:52` 选择 Refractor Markdown 语法，`GitDiffHunkBlock.tsx:49` 把 token 交给 `react-diff-view`。Refractor 的 Markdown 表格 token 包含运行时 CSS 类 `table`，而 Tailwind 生成 `.table { display: table; }`，令代码单元格内的 `span.token.table` 发生布局类碰撞。

## Requirements

1. Markdown 文件预览在 `Ctrl + 滚轮` 缩放、缩小、恢复时，正文与相对字号元素都随当前临时字号变化；源码模式的现有行为不回归。
2. 打开文件编辑器后，文件自动刷新不依赖文件侧栏或终端文件面板仍处于挂载状态。
3. 当已打开的本地、WSL 或 SSH 文件在外部被修改时：
   - 内容、尺寸、修改时间和图片预览更新到最新磁盘版本；
   - 仅刷新受影响的文件及必要目录；
   - 有未保存编辑的文件不得被外部内容静默覆盖。
4. 保持现有本地 watcher 优先、WSL UNC watcher 不可用时 15 秒轮询、窗口重新获得焦点时刷新，以及目录/搜索/Git 状态刷新行为。SSH 使用现有只读远程文件 RPC 的低频轮询和窗口重新获得焦点时刷新，不新增远程 watcher 或 Agent 协议。
5. 不新增设置、数据库迁移、依赖或用户可见文案；现有中英文界面保持不变。
6. 本次交付记录写入 `V1.3.8` 的 `CHANGELOG.md` 和 `docs/功能清单.md`。
7. Git Diff 在审阅弹框和文件编辑器宿主中，将 Markdown 表格的表头行、分隔行和每条表体行各显示为一个源代码 diff 行；统一/分栏视图、自动换行开关和普通 Markdown 高亮均不回归。
8. Git Diff 继续展示 Markdown 源码和语法高亮，不新增“将 diff 渲染成 HTML Markdown 表格”的预览模式。
9. 文件编辑器的普通已打开文件标签支持右键菜单，提供“关闭文件、关闭其它文件、关闭左侧文件、关闭右侧文件”。菜单只作用于当前文件编辑器工作区的普通文件标签，并使用与终端 Tab 一致的终端主题菜单皮肤；不加入新建终端、复制终端、分屏、Workspan、终端背景等终端专属操作，也不改变固定 Git Diff 标签。
10. 批量关闭必须沿用现有未保存内容保护：仅当目标集合含脏文件时显示一次确认；取消不关闭任何目标，保存只保存目标中的脏文件，丢弃只关闭目标集合。菜单及辅助标签须同步支持 `zh-CN`、`zh-TW` 与 `en-US`。

## Acceptance Criteria

- [ ] 对 Markdown 预览按住 `Ctrl` 上下滚动时，字号每次按 1px 改变，范围仍为 8px～32px，且“缩小、放大、恢复”控件显示的字号与渲染结果一致。
- [ ] 打开 Markdown 预览后切换源码/预览，临时字号仍保持；图片、unsupported 文件和 Git Diff 不参与字号缩放。
- [ ] 打开文本、Markdown 或图片文件后隐藏/关闭文件侧栏或终端文件面板；从外部修改该文件，编辑器无需重新打开即可更新。
- [ ] 已有未保存编辑时发生外部改动，本地草稿仍保留，不被自动覆盖。
- [ ] 本地 watcher 事件仍只刷新相关目录和文件；WSL UNC 项目仍走现有低频轮询退化路径。
- [ ] SSH 项目的干净已打开文件在远端内容、大小或修改时间变化后自动更新；SSH 上没有可用远程上下文或连接失败时，不回退到本地文件 API，也不覆盖本地草稿。
- [ ] SSH 自动检查最长约 15 秒一次，并在窗口重新获得焦点时立即检查；自动检查不反复显示远程文件后台任务。
- [ ] Git Diff 中 `| Resource | Use for |`、`|---|---|` 与各数据行各自保持一个逻辑 diff 行，不再被拆成竖排片段；普通 Markdown 标题、链接、行内代码及非 Markdown 文件高亮保持可读。
- [ ] 右键单个已打开文件标签时，显示关闭当前、关闭其它、关闭左侧、关闭右侧四项；菜单背景、前景、边框、悬停态和等宽字体跟随终端 Tab 菜单，当目标集合为空时对应项不可用，且不会显示终端新建/复制/分屏等不适用项。
- [ ] “关闭其它/左侧/右侧”严格按照当前文件标签展示顺序关闭目标文件，保留被右键的文件及未选中的方向；固定 Git Diff 标签不受影响。
- [ ] 批量目标含未保存内容时，取消保持全部目标不变；保存仅保存目标内脏文件后关闭，丢弃仅关闭目标文件；本地、WSL、SSH、Worktree 与分屏承载的文件编辑器均不改变既有文件位置/权限边界。
- [ ] 新菜单在 `zh-CN`、`zh-TW` 与 `en-US` 下均显示正确文案，并且标签关闭按钮的原有行为不回归。
- [ ] `npx tsc --noEmit`、相关 Node 回归测试、`cargo test`（文件 watcher 相关）与 `cargo check` 通过。
- [ ] `CHANGELOG.md` 和 `docs/功能清单.md` 均记录 `V1.3.8`。

## Out of Scope

- 新增 SSH Agent 的远程文件监听/事件推送协议，或改变现有远程文件根目录、配额与只读权限边界。
- 为本地未保存内容与外部改动提供三方合并、冲突对话框或自动覆盖策略。
- 改变文件大小限制、编码处理、Git Diff 数据源或文件浏览器权限边界。
- 将 Git Diff 的 Markdown 源码替换为富文本 Markdown 预览。
- 向固定 Git Diff 标签、终端标签或 Workspan 标签新增此菜单，或将文件关闭操作扩展为终端创建、复制、分屏等会话操作。

## Decisions

- SSH 自动刷新使用 15 秒轮询，并在窗口重新获得焦点时立即检查；这是用户确认的频率。
- Markdown 表格问题以 Diff 代码单元格内 Refractor token 的内联布局隔离修复，不改 Markdown 解析、diff hunk 边界或全局 Tailwind `.table` 工具类。
