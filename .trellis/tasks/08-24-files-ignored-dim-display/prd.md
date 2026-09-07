# 文件浏览器忽略项改为淡化显示

来源:GitHub issue [#227](https://github.com/dark-hxx/CLI-Manager/issues/227) 「[Bug]: 文件面板优化」(V1.3.7 / Windows 11)

## Goal

去掉右侧文件浏览器的「已折叠文件: N」聚合行,让**所有条目回到正常文件树位置**;对被忽略的路径与文件改用**整行降透明度**表达,不再靠"抽离 + 分组"表达。

用户原话:

> 文件面板不建议将忽略路径分离出来显示,偏离文件管理的使用逻辑,增加了操作逻辑的复杂度,可以直接正常显示,对于 ignore 的路径和文件,将其饱和度降低即可
> 预期表现:都按照正常文件树显示所有文件

## 现状(问题所在)

`src/components/files/FileExplorerSidebar.tsx` 的 `splitAutoCollapsedEntries()` 做了两件违背文件树直觉的事:

1. **ignore 命中的文件被完全隐藏**(`continue`)——用户在文件树里找不到 `debug.log` 之类的文件。
2. **ignore 命中的目录 / 默认折叠名目录 / 手动忽略目录被抽离**到树底部的单一 `AutoCollapsedGroupRow`(「已折叠文件: N」),并改用相对路径显示以区分同名项。

结果:同一层级的内容被拆到两个位置,层级结构失真,用户需要额外一次展开才能到达常见目录(如 `node_modules`、`.claude`)。

## Requirements

### R1 移除聚合行机制

- 删除「已折叠文件: N」聚合行及其展开/收起交互。
- 所有条目(含原先被抽离的目录、原先被隐藏的文件)按 store 返回的原始排序在**自身层级的原位**渲染。

### R2 忽略项淡化(整行降透明度)

- 视觉方案:**整行 opacity**(JetBrains 风)——文件名、图标、Git 状态徽标一起变淡。
- 被淡化的判定集合 = 原「已折叠」判定集合 **∪** 原「被隐藏的 ignore 文件」:
  - 项目根 `.gitignore` 命中(缺失/未加载时回退内置默认规则);
  - `DEFAULT_COLLAPSED_DIRECTORY_NAMES` 命中的目录(缓存、构建产物、AI 工具目录等);
  - 用户通过右键菜单「忽略」手动标记的目录(`fileExplorerIgnoredPaths`,按项目隔离)。
- **淡化沿子树继承**:被淡化目录展开后,其后代一律淡化,与 JetBrains / VSCode 一致。
- 被淡化行在 **hover 与选中态需提亮**,否则选中反馈会被透明度吃掉。

### R3 VCS 元数据目录保持隐藏

- `.git`、`.hg`、`.svn` 继续**不在文件树显示**(JetBrains 与 VSCode 同样是隐藏而非淡化)。
- 需按**名称**匹配且**不限 kind**:git worktree 中 `.git` 是文件而非目录。
- 该硬隐藏名单独立于 ignore 规则——`.gitignore` 通常不会列出 `.git/`,不能依赖 ignore 匹配来隐藏它。

### R4 搜索结果保持一致

- 文件搜索结果行与代码内容搜索结果行使用同一套淡化判定,避免"树里淡、搜索里亮"的割裂。

### R5 保留既有能力

- 右键菜单「忽略 / 取消忽略」保留,语义从"移入折叠组"变为"标记为淡化";按项目隔离的持久化不变。
- `.gitignore` 运行时变更后的 watcher 重载不变。
- 紧凑目录链(单子目录合并显示)、拖拽、重命名、Git 状态徽标等既有行为不受影响。

## Non-Goals

- 不改动 `.gitignore` 解析规则本身(`src/lib/fileExplorerIgnore.ts` 的匹配语义与大小写策略保持原样)。
- 不改动后端文件搜索的目录跳过策略(`src-tauri` 侧不动)。
- 不新增"显示/隐藏忽略项"开关设置——issue 未要求,避免扩大范围。
- 不改动 `isDefaultCollapsedDirectoryName()` 的实现(它还要服务紧凑链逻辑,详见 design.md 的风险说明)。

## Acceptance Criteria

- [ ] AC1 文件树中不再出现「已折叠文件: N」行;`files.autoCollapse.*` i18n key 已从 zh / en 词典移除且无残留引用。
- [ ] AC2 `node_modules`、`dist`、`.claude` 等目录出现在**自身父级的原位**(不再聚合到树底部),且整行为淡化态。
- [ ] AC3 原先被隐藏的 ignore 命中**文件**(如 `*.log`、`.DS_Store`)现在可见,且为淡化态。
- [ ] AC4 展开一个淡化目录后,其**全部后代**同样为淡化态。
- [ ] AC5 `.git` / `.hg` / `.svn` 不出现在文件树中;在 git worktree 目录下(`.git` 为文件)同样不出现。
- [ ] AC6 淡化行被选中或 hover 时明显提亮,选中高亮(左侧 inset 条 + 背景)仍清晰可辨。
- [ ] AC7 文件搜索与代码搜索结果中命中忽略规则的行同样为淡化态。
- [ ] AC8 右键「忽略」一个正常目录后该行立即变淡;「取消忽略」后恢复正常;切换项目后忽略列表互不干扰。
- [ ] AC9 项目根新增/修改 `.gitignore` 后,淡化范围随之更新(watcher 重载生效)。
- [ ] AC10 `npx tsc --noEmit` 通过,无未使用变量/导入残留。
- [ ] AC11 `CHANGELOG.md`(V1.3.8)与 `docs/功能清单.md` 已更新;功能清单第 292、538 行描述「已折叠文件」的旧表述已改写。

## Constraints

- 前端唯一静态校验是 `npx tsc --noEmit`(项目无 ESLint / 前端测试框架),必须跑通。
- 仅前端改动,不涉及 IPC 契约、SQLite migration、Tauri capability。
- zh-TW 词典由 OpenCC 从 zh 自动转换(`buildTraditionalChineseDictionary`),只需改 zh + en。
