# 执行计划：侧边栏外观渲染与编辑入口

前置阅读顺序：父任务 `prd.md` → 父任务 `design.md` §3/§4/§6 → 本文件。
开工前确认 `08-24-appearance-data-layer` 已合入（字段 + `resolveNodeAppearance` 可用）。

## 步骤

1. **CSS 先行**：`src/styles/components.css`
   - `.ui-tree-leading-icon`（`:1481`）颜色改为 `var(--node-accent, var(--accent))`，保留 fallback 以免未接入的位置变色异常。
   - 新增选中态左色条伪元素（挂在 `.ui-tree-node` 上，`data-selected="true"` 时显示），宽 2px，颜色 `var(--node-accent)`。
   - 复核 `.ui-project-tree-root`（`:1497`）与 `.ui-split-project-picker`（`:2089`）两处覆写是否需要跟随调整。
2. **渲染接入**：`src/components/sidebar/TreeNodeItem.tsx`
   - 分组分支（`:437` 起）与项目分支（`:280` 起）各调用一次 `resolveNodeAppearance`，把 `--node-accent` 写到 `.ui-tree-node` 的 `style`。
   - leading icon 渲染改为 emoji → iconKey → 默认三级；emoji 用 `<span>` 文本渲染，尺寸与现有图标对齐（14/16px 视 density）。
   - worktree 分支（`:132` 起）读父项目 appearance，只继承颜色。
3. **新组件**：`src/components/sidebar/NodeAppearancePanel.tsx`
   - 10 色板按钮 + 「自动」按钮 + 点击输入框打开的分类 Emoji 选择器 + 紧凑的自定义标记输入（非法格式拒绝提交）。
   - 键盘可达：色板用方向键遍历，Esc 关闭（Radix Popover 默认行为够用，勿自造焦点陷阱）。
4. **内联新建行**：`TreeNodeItem.tsx:464-472` 的 `Folder` 换成 popover trigger 按钮；popover 内选择的值暂存在本地 state，回车时随 `actions.onCreateGroup(g.id, name)` 一起提交 —— 需要把 `onCreateGroup` 签名扩展为携带可选外观参数，同步改 `sidebar/index.tsx:1622` 的 `handleCreateGroup` 与根级 `onCreateRootGroup`（`:2078`）。
5. **右键菜单**：`sidebar/index.tsx` 分组菜单（`:2540-2601`）与项目菜单（`:2301-2338`）各加「外观」项，打开同一 popover（菜单已是 Radix，注意关闭顺序：先关菜单再开 popover，避免焦点回抢）。
6. **项目编辑弹框**：在项目表单里内嵌同一组控件，字段与 `updateProject` 一起提交。
7. `src/lib/i18n.ts` 补文案：`sidebar.menu.appearance`、`sidebar.appearance.auto`、`sidebar.appearance.emojiHint` 等，覆盖全部语言。
8. 更新 `CHANGELOG.md`（追加到既有 `## [V1.3.8]` 段）与 `docs/功能清单.md`。

> 并发约束（父任务 `design.md` §8.4）：步骤 4 的外观必须随 `createGroup` 的**同一条 INSERT** 落库，禁止"先建组再 UPDATE 外观"两步写；外观修改只发带 id 的单行 UPDATE，不做整行全字段重写。

## 验证

```bash
npx tsc --noEmit
```

人工验证矩阵（照 `.trellis/spec/guides/fix-triage-guide.md` §5 场景维度）：

| 维度 | 要点 |
|---|---|
| 主题 | 亮 / 暗各验一次 |
| density | `compact` / `comfortable` 两档 |
| 侧边栏形态 | 展开 / 折叠窄条 |
| 节点类型 | 分组、项目、worktree 子行、空分组 |
| 状态叠加 | 运行中（`data-status`）、路径失效（`data-invalid`）、选中/多选 |
| 交互 | 拖拽排序、跨分组拖拽、键盘导航、右键菜单后滚动位置保持 |
| 入口 | 新建内联行 / 右键 / 项目编辑弹框三处结果一致 |

## 实现结果（与计划的偏差）

- **颜色标记主要靠"行左侧细色条"，不是靠图标颜色**。原设计假设给 leading icon 上色即可，但 `CliToolIcon` 用的是 lobehub 的 *Color* 变体（`ClaudeColor` / `GeminiCliColor` …），自带品牌色、**不吃 `currentColor`**。只给图标上色的话，绝大多数项目行（都配了 CLI 工具）根本不会有任何颜色标记。所以：
  - 色条常显（不只选中态）：`.ui-tree-node[data-accent="true"]::before`，默认 0.5 透明度，hover 0.8，选中 1.0 且加高。
  - 图标着色仍保留，但只对单色图标生效（分组文件夹、终端回退图标）。
  - 仍然不铺整行背景，`data-status` 的运行态语义未被动。
- **Worktree 行不继承项目颜色**（偏离 R-U2）：`.ui-worktree-tree-icon` 有明确的 success 绿身份（图标色 + 底色 + 徽章），覆盖它会破坏既有的"worktree = 绿"语言。Worktree 保持原样。
- **右键菜单「外观标记」是菜单内内联展开**，不是再叠一层定位浮层。原因：现有右键菜单是自绘定位（`menuPos` 实测尺寸 + 翻转钳制），再开一层就要重写一套 viewport 钳制；内联展开零新增定位代码，焦点也不用接管。
- **分组行也显示左侧色条**：颜色标记由 `data-accent` 统一驱动项目与分组节点，分组文件夹图标继续跟随节点颜色。
- **外观面板提供内置 Emoji 选择器**：点击窄输入框后打开 Emoji Mart 的 Emoji 15 全量搜索/分类/常用选择器；启用动态列数、顶部分类导航和固定高度的内部滚动，并加入离线可用的飞书、小红书、哔哩哔哩品牌标记。选中标准 Emoji 后直接写入单字符标记，选中品牌标记后写入内置品牌 key，手动输入仍可用且不显示“1 个 emoji 或字符”占位提示。
- **右键菜单位置跟随内容尺寸**：用 `ResizeObserver` 监听外观面板等内容展开后的高度；展开后尽量保留菜单原位置，只有确实放不下才向视口内收敛并内部滚动，避免点击外观编辑后菜单跳到窗口顶部。
- **Emoji 弹层边界与滚动**：选择器优先向右弹出，Radix 按视口边缘自动翻转/位移；Emoji Mart Shadow DOM 内的滚动轨道与滑块显式设置，确保在 Tauri WebView 中可见且可下拉。
- **`NodeAppearanceIcon` 在本任务就提取好了**（原计划放到子任务 ④）。这样 ④ 变成纯替换，不用再回改本任务的代码。
- **新增 `isCliToolIconKey`**（`CliToolIcon.tsx`）：直接查 `CLI_TOOL_ICONS`（`Record<CliToolIconKey, …>`，编译期保证覆盖完整），而不是另维护一份 key 清单。
- **`NewGroupRow` 同时替换了两处新建行**：`TreeNodeItem` 的子级分组行与 `ProjectTree` 的根级分组行（原来是两份各自写的 input + blur 提交）。外观快选触发按钮加了 `onMouseDown preventDefault` + `pickerOpen` 双重保护 —— 否则 mousedown 会先让名称输入框 blur，直接把分组提前建出来。
- **`ConfigModal` 三条路径都接了**（新建 / 编辑 / 克隆），面板放在名称字段下方。
- **`.ui-split-project-picker` 有意不接**：它没有 `data-accent` 所以不出色条，且它对 `.ui-tree-leading-icon` 的 `color` 覆写优先级更高，仍是菜单单色风格 —— 这是刻意保持的，不是漏改。

## 已执行验证

- `npx tsc --noEmit`：无错误。
- `npm run build`（tsc + vite build）：成功，3m11s。
- 未执行：应用内人工验证。需要你在界面上确认的点见下方矩阵，尤其是"新建分组点图标选色后回车仍只建一次组"、亮/暗主题下项目与分组色条的观感，以及靠近窗口底部打开右键菜单后展开 Emoji 库是否可滚动。

## 回滚点

- 步骤 1-2（渲染）与 步骤 3-6（编辑入口）可分别回滚：仅回滚编辑入口时，自动配色仍生效。
- `onCreateGroup` 签名扩展是唯一跨文件契约改动，回滚时注意 `sidebar/index.tsx` 与 `TreeNodeItem.tsx` 需成对还原。
