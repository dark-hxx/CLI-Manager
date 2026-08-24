# Design · 文件浏览器忽略项改为淡化显示

## 1. 核心思路

一句话:把**「抽离 + 分组」换成「原位 + 标记」**。

```
旧:  entries ──splitAutoCollapsedEntries()──┬─→ normalEntries  → FileNode
                                            └─→ collapsedEntries → AutoCollapsedGroupRow → FileNode(showRelativePath)

新:  entries ──(过滤硬隐藏名单)──→ 全部原位 FileNode,每行携带 isIgnored 布尔 → data-ignored="true" → CSS opacity
```

判定集合刻意保持**与旧折叠谓词等价**,只是表现方式从"移走"变成"变淡",外加把原先被 `continue` 丢掉的 ignore 文件放回来。这样最大化行为可预测性,也把改动锁在渲染层。

## 2. 边界与契约

| 边界 | 是否改动 | 说明 |
|---|---|---|
| IPC (`invoke`) | ❌ | 不新增/修改命令 |
| SQLite migration | ❌ | 无表结构变化 |
| `tauri-plugin-store` 设置 | ❌ | `fileExplorerIgnoredPaths` 结构与语义键不变,仅**解释**从"折叠"变"淡化" |
| Tauri capability | ❌ | 无新增文件/资源访问 |
| `src/lib/fileExplorerIgnore.ts` | ❌ | 匹配语义、大小写策略、watcher 重载判定全部沿用 |
| `src/stores/fileExplorerStore.ts` | ❌ | `isDefaultCollapsedDirectoryName` / `expandCompactDirChain` 不动 |
| `src/components/files/FileExplorerSidebar.tsx` | ✅ 主战场 | 渲染与判定 |
| `src/styles/components.css` | ✅ | 新增淡化规则 |
| `src/lib/i18n.ts` | ✅ | 删 3 个 key(zh + en) |

**关键取舍:不碰 `isDefaultCollapsedDirectoryName()`。** GitNexus `impact` 对它报 **HIGH**(10 触点),但拆开看:4 个直接调用者(`collectCompactDirectoryChain`、`splitAutoCollapsedEntries`、`FileExplorerSidebar`、`expandCompactDirChain`),其余是 React 渲染树包含关系(`App → Sidebar → TerminalTabs → FileExplorerSidebar`)造成的名义传播,不是逻辑耦合。本方案只**停止把它当可见性开关**、改为当淡化开关,函数体与签名零改动 → HIGH 风险不实际发生。`splitAutoCollapsedEntries` 自身是 **LOW**(3 触点全在同文件内)。

## 3. 数据流

```
project?.path ──┐
                ├─→ .gitignore 读取(invoke file_read_project_text)──→ projectGitIgnoreMatcher
                │                                        ↑ watcher: project-files-changed
                └─→ gitIgnoreCaseInsensitive

ignoreMatcher = loaded ? projectGitIgnoreMatcher : createDefaultIgnoreMatcher()   ← 不变
ignoredPaths  = fileExplorerIgnoredPaths[project.id]                              ← 不变

                 ┌───────────────── 新增 ─────────────────┐
FileTreeRows ──→ │ visibleTreeEntries(entries)           │ 过滤硬隐藏名单
                 │ isEntryIgnored(entry, state)          │ 单条判定
                 └───────────────────────────────────────┘
                          ↓ inheritedIgnored 逐层向下传
FileNode ──→ isIgnored = inheritedIgnored || isEntryIgnored(entry) || isEntryIgnored(chainLeaf)
                          ↓
                 data-ignored="true" ──→ CSS .ui-file-tree-row[data-ignored="true"]
```

淡化用 `data-*` 属性 + CSS,而不是内联 style:与同文件既有的 `data-selected` 模式一致,且 hover / 选中提亮只能靠 CSS 选择器组合表达。

## 4. 具体改动

### 4.1 新增:硬隐藏名单(R3)

```ts
/** VCS 元数据目录始终不进文件树(JetBrains / VSCode 同样是隐藏而非淡化)。
 *  不限 kind:git worktree 中 .git 是文件而非目录。 */
const ALWAYS_HIDDEN_ENTRY_NAMES = new Set([".git", ".hg", ".svn"]);

function isAlwaysHiddenEntry(entry: ProjectFileEntry): boolean {
  return ALWAYS_HIDDEN_ENTRY_NAMES.has(entry.name.toLowerCase());
}
```

放在 `FileExplorerSidebar.tsx` 模块级常量区(紧邻 `GIT_STATUS_LABELS` 一带)。不放进 `fileExplorerIgnore.ts`——那是 gitignore 语义层,硬隐藏是 UI 策略,混进去会污染契约。

### 4.2 替换:`splitAutoCollapsedEntries` → `isEntryIgnored` + `visibleTreeEntries`

删除 `splitAutoCollapsedEntries()`(整个函数),换成两个纯函数:

```ts
function isEntryIgnored(entry: ProjectFileEntry, state: FileIgnoreState): boolean {
  if (entry.kind === "directory" && isDefaultCollapsedDirectoryName(entry.name)) return true;
  if (state.ignoredPaths.has(entry.path)) return true;
  return state.ignoreMatcher.ignores(entry.path, entry.kind === "directory");
}

function visibleTreeEntries(entries: ProjectFileEntry[]): ProjectFileEntry[] {
  return entries.some(isAlwaysHiddenEntry) ? entries.filter((e) => !isAlwaysHiddenEntry(e)) : entries;
}
```

`visibleTreeEntries` 的 `some` 短路是为了在绝大多数层级(不含 `.git`)返回**原数组引用**,避免每次渲染产生新数组打断 React 的引用比较。

### 4.3 `FileIgnoreState`(原 `AutoCollapseGroupState`)

```ts
interface FileIgnoreState {
  ignoredPaths: Set<string>;
  /** Project .gitignore matcher, or the built-in fallback matcher. */
  ignoreMatcher: FileExplorerIgnoreMatcher;
  ignorePath: (path: string) => void;
  unignorePath: (path: string) => void;
}
```

删掉 `expandedGroupPaths` 与 `toggleGroup`。类型未导出,重命名影响面局限本文件;prop 名 `autoCollapseGroups` → `ignoreState`。**用 `rename_symbol` 而非文本替换**(CLAUDE.md 硬性要求)。

### 4.4 `FileNode`:新增 `inheritedIgnored` prop

```ts
inheritedIgnored?: boolean;   // 默认 false
```

```ts
const isIgnored = inheritedIgnored
  || isEntryIgnored(entry, ignoreState)
  || (isDir && displayEntry !== entry && isEntryIgnored(displayEntry, ignoreState));
```

第三项处理**紧凑目录链**:链头 `entry` 与链尾 `displayEntry` 可能一个正常一个被忽略(如 `src/` 只含一个被 gitignore 的 `generated/`,合并显示为 `src/generated`)。两端任一命中即淡化。链中间节点不单独判定——合并行本身就代表整条链,且 `collectCompactDirectoryChain` 已在 `isDefaultCollapsedDirectoryName` 处截断,不会把噪声目录并进链里。

在**两处** row 容器上加 `data-ignored={isIgnored ? "true" : "false"}`:正常渲染分支(约 L544)与 `isRenaming` 分支(约 L517)。漏掉重命名分支会导致淡化目录改名时突然变亮。

`childRows` 透传 `inheritedIgnored={isIgnored}` 到 `FileTreeRows`。

### 4.5 `FileTreeRows`:去掉分组渲染

- 删 `renderAutoCollapsedGroup` prop、`splitAutoCollapsedEntries` 调用、`groupOpen`、整个 `collapsedEntries.length > 0 && (...)` JSX 块。
- 新增 `inheritedIgnored?: boolean` 并透传给每个 `FileNode`。
- `entries` 改为 `visibleTreeEntries(entries)` 后再 map。
- `parentPath` prop:原先只用于 `toggleGroup(parentPath)`。移除分组后若无其它用途则一并删除(实现时确认)。

### 4.6 删除 `AutoCollapsedGroupRow` 组件

同时确认 `ChevronRight` / `Folder` 导入仍被其它处使用(`FileNode` 箭头、`copyAiTree` 菜单图标)→ 不删导入。

### 4.7 删除 `showRelativePath`

该 prop 只被分组渲染使用(旧 L794),分组消失后成为死代码。删 prop 与 L587 的 `showRelativePath ? entry.path : entry.name` 分支(统一用 `entry.name`)。

### 4.8 清理组件状态与 effect

| 位置 | 处理 |
|---|---|
| `expandedAutoCollapseGroups` state (L839) | 删 |
| `project?.id` 重置 effect 中的 `setExpandedAutoCollapseGroups(new Set())` (L865) | 删该行,effect 其余保留 |
| `toggleAutoCollapseGroup` useCallback (L943-953) | 删 |
| 选中路径自动展开分组 effect (L989-1007) | **整块删** — 已无任何东西被折叠隐藏,该 effect 目的消失 |
| `scrollIntoView` effect 依赖数组 (L1015) | 移除 `expandedAutoCollapseGroups` 依赖 |
| `autoCollapseGroups` useMemo (L1017-1024) | 改为 `ignoreState`,去掉两个分组字段 |
| `renderRows` 依赖数组 (L1601) | `autoCollapseGroups` → `ignoreState` |

### 4.9 搜索结果淡化(R4)

`renderSearchRow` / `renderContentSearchRow` 不走 `FileTreeRows`,需各自加一行判定:

- `renderSearchRow(entry)`:`data-ignored={isEntryIgnored(entry, ignoreState) ? "true" : "false"}`,同样要覆盖其内部的 `renamingAction` 分支。
- `renderContentSearchRow(match)`:`match` 只有 `path`(必为文件)→ `isEntryIgnored({ kind: "file", name: ..., path: match.path }, ...)`。为避免构造假 entry,给 `isEntryIgnored` 补一个按 (path, kind) 的轻量重载或直接内联 `ignoreState.ignoreMatcher.ignores(match.path, false) || ignoreState.ignoredPaths.has(match.path)`。实现时选后者,更直白。
- 两个 `useCallback` 依赖数组补 `ignoreState`。

### 4.10 CSS(`src/styles/components.css`,紧跟 `[data-selected="true"]` 规则之后)

```css
/* Issue #227:忽略项原位显示 + 整行淡化(JetBrains 风),
   hover / 选中时提亮,避免透明度吃掉选中反馈。 */
.ui-file-tree-row[data-ignored="true"] {
  opacity: 0.45;
}

.ui-file-tree-row[data-ignored="true"]:hover,
.ui-file-tree-row[data-ignored="true"][data-selected="true"] {
  opacity: 0.75;
}
```

放在 `[data-selected="true"]` **之后**:两条规则改的是不同属性(`opacity` vs `background-color`/`box-shadow`),不存在覆盖冲突,顺序只影响可读性。

`.ui-file-drag-preview .ui-file-tree-row` 会继承 `data-ignored`(拖拽预览克隆行 HTML)——预期行为,拖动淡化文件时预览也淡,无需特殊处理。

### 4.11 i18n(`src/lib/i18n.ts`)

删除 zh (L3003-3005) 与 en (L6958-6960) 各 3 个 key:`files.autoCollapse.collapse` / `.expand` / `.count`。
zh-TW 由 `buildTraditionalChineseDictionary(zh, zhTwOverrides)` 自动转换,`zhTwOverrides` 不含这些 key → 无需改动。
`files.menu.ignore` / `files.menu.unignore` **保留**(R5,语义变为"标记淡化",文案「忽略/取消忽略」仍准确)。

## 5. 场景枚举(fix-triage-guide §5)

| 维度 | 覆盖结论 |
|---|---|
| UI 呈现模式 | `mode="sidebar"` / `mode="panel"` / 折叠侧栏 —— 淡化是行级 CSS,三种模式共用 `ui-file-tree-row`,自动覆盖 |
| 搜索模式 | 无搜索(文件树)✅ / files 搜索 ✅(4.9) / content 搜索 ✅(4.9) |
| 运行环境 | 本地 Windows(ignore 大小写不敏感)/ WSL(大小写敏感)/ SSH(`readOnly`,跳过 `.gitignore` 读取 → 回退内置规则)—— 三者共用同一 `ignoreMatcher` 装配链,不变 |
| **Worktree** | 主仓 `.git` 是**目录**、worktree 中 `.git` 是**文件** → 硬隐藏按名称匹配、不限 kind(4.1)。这是本次最容易漏的一条 |
| `.gitignore` 状态 | 存在并加载 ✅ / 不存在 → 内置回退 ✅ / `idle` 加载中 → 内置回退 ✅ / 运行时增删改 → watcher 重载 ✅(不改) |
| 手动忽略 | 忽略 → 立即变淡 ✅ / 取消忽略 → 恢复 ✅ / 切项目 per-project 隔离 ✅(`fileExplorerIgnoredPaths[project.id]`) |
| 选中 / hover | 淡化行选中或 hover 提亮到 0.75(4.10)——否则选中反馈丢失 |
| 紧凑目录链 | 链头忽略 ✅ / 链尾忽略 ✅(4.4 第三项判定)/ 链被 `isDefaultCollapsedDirectoryName` 截断 ✅ |
| 重命名中的行 | `isRenaming` 分支单独加 `data-ignored`(4.4),否则改名瞬间变亮 |
| Git 状态徽标 | 淡化行的徽标一起变淡 —— 整行 opacity 的预期结果,符合 JetBrains |
| 拖拽 | 预览克隆行携带 `data-ignored` → 预览同步变淡 ✅ |
| 窗口焦点 / 分屏 / 托盘 / CLI Hook | **确认无关**:纯渲染层改动,不涉及窗口状态、PTY、hook 上报 |

## 6. 兼容性与回滚

- **无持久化格式变更** → 降级到旧版本无数据问题;`fileExplorerIgnoredPaths` 在旧版本仍被解释为"折叠",新版本解释为"淡化",同一份数据两边都能用。
- **可见行数上升**:原先被隐藏的 ignore 文件现在会渲染。同层级文件数量级不变(目录默认不展开,`node_modules` 内部只在用户主动展开时加载),无虚拟滚动压力变化。
- **回滚点**:改动集中在 1 个 tsx + 1 个 css + 1 个 i18n 文件,`git revert` 单个 commit 即可完全恢复。

## 7. 已知取舍

1. **`DEFAULT_COLLAPSED_DIRECTORY_NAMES` 继续参与淡化判定**,而非只依赖 `.gitignore`。理由:该名单正是旧「已折叠」集合的主要来源,把它一并映射为"淡化"才是对 issue 的忠实翻译(同一批条目、换一种表达)。副作用:项目主动提交 `.claude/` 时它仍显示为淡化。判定为可接受——它仍然可见可操作,且与旧行为相比是严格改善。
2. **右键「忽略」时的 `collapseDir` 保留**(旧 L624)。淡化本身已提供即时反馈,但顺带收起可减少大目录展开时的大片淡化行,保留即行为不变、无新风险。
3. **不加"显示/隐藏忽略项"开关**。issue 未要求,加设置会重新引入被抱怨的"操作逻辑复杂度"。
