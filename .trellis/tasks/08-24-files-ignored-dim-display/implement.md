# Implement · 文件浏览器忽略项改为淡化显示

前置:`prd.md` 已定验收标准,`design.md` 已定技术方案。本文件只管**执行顺序、校验命令、回滚点**。

主战场:`src/components/files/FileExplorerSidebar.tsx`(1838 行)。
辅助:`src/styles/components.css`、`src/lib/i18n.ts`、`CHANGELOG.md`、`docs/功能清单.md`。

> 行号取自任务创建时的快照,编辑过程中会漂移 —— **每步先按符号名/内容定位再改**,不要盲信行号。

---

## Step 1 · 重命名类型与 prop(先做,避免后续改动被重命名工具二次扫过)

- [ ] 1.1 `rename_symbol`:`AutoCollapseGroupState` → `FileIgnoreState`(文件内 interface,未导出)
- [ ] 1.2 `rename_symbol`:prop 名 `autoCollapseGroups` → `ignoreState`(出现在 `FileNode`、`FileTreeRows` 的类型/解构/透传,以及 `FileExplorerSidebar` 的 `useMemo` 与 `renderRows` 依赖数组)
- [ ] 1.3 校验:`npx tsc --noEmit` 通过(此步应为纯重命名,零语义变化)

**注意**:CLAUDE.md 硬性要求 —— 重命名必须用 `rename_symbol`/`rename`,禁止 find-and-replace。

**回滚点 A**:此步独立可 revert。

---

## Step 2 · 新增判定纯函数

- [ ] 2.1 模块级常量区(`GIT_STATUS_LABELS` 一带)加 `ALWAYS_HIDDEN_ENTRY_NAMES` + `isAlwaysHiddenEntry()`(design 4.1)
  - 按 `name.toLowerCase()` 匹配,**不判断 kind**(worktree 的 `.git` 是文件)
- [ ] 2.2 新增 `isEntryIgnored(entry, state)`(design 4.2)
- [ ] 2.3 新增 `visibleTreeEntries(entries)`(design 4.2),保留 `some` 短路以返回原数组引用
- [ ] 2.4 **暂不删** `splitAutoCollapsedEntries` —— 留到 Step 4 一起删,避免中间态编译不过

---

## Step 3 · `FileNode` 加淡化

- [ ] 3.1 类型加 `inheritedIgnored?: boolean`,解构处给默认值 `= false`
- [ ] 3.2 计算 `isIgnored`(design 4.4 三项判定,含紧凑链链尾)
- [ ] 3.3 `isRenaming` 分支的 row 容器加 `data-ignored`(**易漏**)
- [ ] 3.4 正常渲染分支的 row 容器加 `data-ignored`
- [ ] 3.5 `childRows` 的 `<FileTreeRows>` 透传 `inheritedIgnored={isIgnored}`
- [ ] 3.6 删 `showRelativePath` prop 与 L587 的三元分支,统一 `entry.name`(design 4.7)

---

## Step 4 · `FileTreeRows` 去分组 + 删死代码

- [ ] 4.1 删 `renderAutoCollapsedGroup` prop(类型 + 解构 + 两个调用点传参)
- [ ] 4.2 删 `splitAutoCollapsedEntries()` 调用与 `groupOpen`,改为 `visibleTreeEntries(entries).map(...)`
- [ ] 4.3 删整个 `collapsedEntries.length > 0 && (...)` JSX 块
- [ ] 4.4 加 `inheritedIgnored?: boolean` 并透传给每个 `FileNode`
- [ ] 4.5 确认 `parentPath` prop 是否还有消费者;若无 → 删 prop 及两个调用点传参
- [ ] 4.6 删 `AutoCollapsedGroupRow` 组件(design 4.6);确认 `ChevronRight`/`Folder` 导入仍被其它处使用,**不要连带删导入**
- [ ] 4.7 删 `splitAutoCollapsedEntries` 函数本体
- [ ] 4.8 校验:`npx tsc --noEmit`(应报出 Step 5 待清理的未使用变量,属预期)

---

## Step 5 · 清理组件状态与 effect(design 4.8 表格逐行核对)

- [ ] 5.1 删 `expandedAutoCollapseGroups` state
- [ ] 5.2 `project?.id` 重置 effect 中删 `setExpandedAutoCollapseGroups(new Set())` 一行,**effect 其余三行保留**
- [ ] 5.3 删 `toggleAutoCollapseGroup` useCallback
- [ ] 5.4 **整块删**选中路径自动展开分组 effect(原 L989-1007)
  - 顺带确认 `isDefaultCollapsedDirectoryName` 在本文件是否还有引用(应仅剩 `collectCompactDirectoryChain` + 新增的 `isEntryIgnored`)→ 若无引用则清理 import,否则保留
- [ ] 5.5 `scrollIntoView` effect 依赖数组移除 `expandedAutoCollapseGroups`
- [ ] 5.6 `ignoreState` useMemo 去掉 `expandedGroupPaths` / `toggleGroup` 两个字段及对应依赖
- [ ] 5.7 `renderRows` 里 `<FileTreeRows>` 去掉 `renderAutoCollapsedGroup`
- [ ] 5.8 校验:`npx tsc --noEmit` 通过、无 unused 残留

**回滚点 B**:Step 2-5 构成"树内淡化"完整功能,可独立于 Step 6 交付。

---

## Step 6 · 搜索结果淡化(design 4.9)

- [ ] 6.1 `renderSearchRow`:正常分支 + `renamingAction` 分支各加 `data-ignored`(用 `isEntryIgnored(entry, ignoreState)`)
- [ ] 6.2 `renderContentSearchRow`:内联 `ignoreState.ignoredPaths.has(match.path) || ignoreState.ignoreMatcher.ignores(match.path, false)`
- [ ] 6.3 两个 `useCallback` 依赖数组补 `ignoreState`
- [ ] 6.4 校验:`npx tsc --noEmit`

---

## Step 7 · CSS

- [ ] 7.1 `src/styles/components.css` 在 `.ui-file-tree-row[data-selected="true"]` 规则之后插入两条 `[data-ignored="true"]` 规则(design 4.10),带 Issue #227 注释

---

## Step 8 · i18n

- [ ] 8.1 删 zh 词典 `files.autoCollapse.collapse` / `.expand` / `.count`
- [ ] 8.2 删 en 词典同 3 个 key
- [ ] 8.3 确认 zhTwOverrides 不含这些 key(已确认:只有 `desktopPet.mood.working`)→ 无需改
- [ ] 8.4 `grep -rn "autoCollapse" src/` 应零命中
- [ ] 8.5 校验:`npx tsc --noEmit`(en 词典类型是 `Record<keyof typeof zh, string>`,zh/en 不同步会直接报错——这是天然的对齐校验)

---

## Step 9 · 文档(Trellis finish gate 强制)

- [ ] 9.1 `CHANGELOG.md`:在既有 `## [V1.3.8] - 2026-08-21` 段落下新增小节「文件浏览器忽略项淡化显示」,写明:移除「已折叠文件」聚合行、忽略项原位淡化并沿子树继承、原先被隐藏的忽略文件恢复可见、`.git`/`.hg`/`.svn` 仍隐藏(含 worktree 下 `.git` 为文件的情形)、搜索结果同步淡化、hover/选中提亮
- [ ] 9.2 `docs/功能清单.md` L292:改写「忽略目录归入"已折叠文件",忽略文件不在主文件树显示」→ 原位淡化表述
- [ ] 9.3 `docs/功能清单.md` L293:「手动忽略路径与默认折叠目录继续叠加生效」→ 确认表述仍准确(叠加逻辑未变,但结果是淡化)
- [ ] 9.4 `docs/功能清单.md` L538:整条改写(原文描述「统一归入文件树底部的单一"已折叠文件"聚合行,并用相对路径区分」——该行为已完全移除)

---

## Step 10 · 验收与提交前检查

- [ ] 10.1 `npx tsc --noEmit` —— 必须零错误(前端唯一静态校验)
- [ ] 10.2 `grep -rn "autoCollapse\|AutoCollapsed\|splitAutoCollapsed\|showRelativePath" src/` 零命中
- [ ] 10.3 逐条对照 `prd.md` 的 AC1-AC11 自检
- [ ] 10.4 `detect_changes()` —— 确认改动范围只落在预期符号与 Files 模块(CLAUDE.md 硬性要求)
- [ ] 10.5 人工验证(需用户运行 `npm run tauri dev`):
  - 打开本仓库项目 → `node_modules`/`dist`/`.claude` 在原位且淡化
  - `.git` 不出现
  - 展开 `src-tauri/target`(若存在)→ 后代全淡
  - 点选一个淡化文件 → 提亮且选中条清晰
  - 搜索 `log` → 命中的忽略文件行淡化
  - 右键正常目录「忽略」→ 立即变淡;「取消忽略」→ 恢复

---

## 验证命令汇总

```bash
npx tsc --noEmit                       # 前端唯一静态校验,每步后跑
grep -rn "autoCollapse" src/           # 残留检查
npm run tauri dev                      # 人工验证(需用户执行)
```

Rust 侧零改动 → 不需要 `cargo check` / `cargo test`。

## 回滚

改动集中在 3 个源文件 + 2 个文档,单 commit `git revert` 即可完全恢复。中间回滚点:A(Step 1 纯重命名)、B(Step 2-5 树内淡化,可不带搜索淡化交付)。
