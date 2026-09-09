# 设计方案：项目栏“已置顶”快捷入口

## 1. 设计目标

在项目侧边栏提供一个稳定、低认知负担的快捷层。置顶入口只保存项目 ID，展示和启动始终复用当前项目树的数据及行为，因此项目改名、移动分组和切换运行配置不会产生第二份项目配置。

本方案不修改 SQLite 表、不增加 Rust 命令，也不复制项目启动链路。置顶关系作为用户偏好保存，并跟随现有设置同步能力。

## 2. 用户界面

### 展开状态

项目筛选控件可见时，标题下方提供三个选项：

全部  |  已开启  |  已置顶

项目筛选控件关闭时，保持现有布局；独立的“已置顶”分组仍按是否存在置顶项目显示。

置顶区域位于普通项目树上方：

项目栏
[全部] [已开启] [已置顶]
┌─ 📁📌 已置顶 2                            ˅ ┐
│  Web Console                 ▶        📌     │
│  API Server                  ▶        📌     │
└─────────────────────────────────────────────┘
📁 前端项目
  └─ Web Console                         ▶
📁 后端项目

- 标题使用类似普通文件夹的分组行，包含文件夹/Pin 图标、区域名称、数量和 chevron。
- 默认展开；用户收起后只保留标题行。
- 只有存在至少一个置顶项目时渲染该分组；置顶项目作为子项显示在分组内。
- 项目行沿用普通项目行的图标、名称、终端状态和提示信息，保留启动按钮和上下文菜单。

已置顶筛选启用时只显示该分组的项目列表，普通树和空的普通区域隐藏；没有置顶项目时显示筛选空态。

搜索输入处于激活状态时，全部和已开启视图隐藏独立置顶区域，搜索结果只出现一次；切换到已置顶时显示置顶列表并按现有项目筛选逻辑处理。

### 收起状态

在普通根项目快捷图标上方增加置顶图标区域，并用分隔线区分。图标 tooltip 显示项目名、分组路径和置顶状态。图标仍支持现有的单击选择/启动入口和上下文菜单，不改变收起侧边栏的宽度。

筛选控件收起时继续使用现有的筛选按钮，按 全部 → 已开启 → 已置顶 → 全部 循环。按钮 tooltip 和 aria-label 表示当前状态及下一状态，避免只依赖颜色或图标。

## 3. 数据与持久化

在现有 Settings 中新增：

pinnedProjectIds: string[]
sidebarPinnedSectionCollapsed: boolean

- pinnedProjectIds 的数组顺序就是置顶顺序；置顶操作追加到末尾。
- 加载设置时只接受字符串 ID，去重并保留首次出现顺序；非法值降级为空数组。
- sidebarPinnedSectionCollapsed 缺省为 false，兼容旧设置文件。
- 两项都纳入 SETTING_BACKUP_POLICY 的 preferences 类别，复用现有设置同步流程。
- 当前项目集合变化后由派生列表过滤未知 ID；删除项目时写回清理后的数组，避免悬挂记录。
- 完整工作区恢复先刷新项目缓存，再应用包含置顶 ID 的偏好，避免恢复过程把快照中的新项目误判为悬挂记录。
- 不将 pin 字段放入 Project、projects 表或 sort_order，因此不影响项目同步、数据库迁移和树排序。

项目稳定 ID 的数据流：

Settings.pinnedProjectIds
        │
        ├─ 过滤当前 Project 列表
        ├─ 按保存顺序生成 pinnedProjects
        └─ 将 projectId 交给现有 TreeActions / openProjects

## 4. 前端模块划分

### 状态入口

新增 src/features/projects/hooks/usePinnedProjects.ts，集中处理：

- 从设置读取置顶 ID；
- 根据当前项目列表派生可显示项目；
- isPinned、togglePinned；
- 删除/恢复/同步后的 ID 清理；
- 区域收起状态读写。

这样可以避免继续扩大接近 2000 行的 useSidebarController.tsx 和 settingsStore.ts，并让 SidebarView 只负责组合。

### 展示组件

新增 src/features/projects/components/PinnedProjectSection.tsx，包含类似文件夹的分组标题、展开列表和置顶项目行。置顶项目行抽成同文件内的局部组件或独立小文件，复用普通项目行需要的视觉与操作模型，但不调用 useSortable；项目列表为空时整个分组不渲染。

置顶区域放在 SidebarView 的普通 ProjectTree 之前，置顶筛选时由同一组合入口只渲染置顶区域。收起侧边栏时由项目树组合层渲染 variant="collapsed" 的置顶图标区域，避免重复创建第二份业务状态。

### 现有入口的最小改动

- SidebarHeader 将 ProjectListFilter 扩展为 all | open | pinned，增加数量和筛选文案。
- useSidebarController 仅提供置顶项目、筛选值和 toggle/collapse 回调；项目启动继续调用现有 openProjects。
- TreeContext / TreeActions 增加 pin 状态查询和切换动作，普通项目行与置顶项目行共享上下文菜单和选择行为。
- TreeNodeItem 增加 Pin 按钮或状态标识，按钮仅触发 toggle，不触发项目行选择或拖拽。
- ProjectTree 保留普通树的 DndContext 与 SortableContext；置顶区域不加入 SortableContext，不产生重复的 sortable ID，也不参与拖动排序。

## 5. 行为与交互契约

### 置顶操作

1. 用户在普通项目行 hover/focus 看到 Pin 操作，或从上下文菜单选择置顶。
2. 写入 pinnedProjectIds，项目立即出现在区域末尾。
3. 已置顶行显示 Filled Pin；再次操作取消置顶并从区域移除。
4. 在置顶区域取消置顶后，焦点回到相邻项目或区域标题；列表为空时整个分组消失。

### 选择与启动

- 置顶行使用同一项目 ID参与选中状态，普通树中对应项目同步高亮。
- 单击、Enter/Space 和启动按钮遵循现有选择/启动语义；启动最终走 handleOpen → openProjects。
- Ctrl/Cmd 多选继续使用项目 ID集合；置顶区域与普通树之间不新增独立选择模型。
- 置顶列表不提供拖拽排序。项目树原有拖拽只作用于普通树节点。

### 上下文菜单

置顶项目使用已有项目上下文菜单和 TreeActions。菜单中新增“取消置顶”，并保留项目当前已有的终端、目录、文件、历史、复制/编辑/删除等能力。菜单不出现移动或排序置顶项的动作。

## 6. 搜索、筛选与显示矩阵

| 当前模式 | 已置顶区域 | 普通项目树 |
| --- | --- | --- |
| 全部、无搜索、存在置顶 | 显示置顶文件夹及其子项 | 显示 |
| 已开启、无搜索、存在置顶 | 显示置顶文件夹，内容按已开启结果过滤 | 显示已开启项目 |
| 全部/已开启、无搜索、无置顶 | 隐藏 | 显示 |
| 已置顶 | 显示全部已置顶项目 | 隐藏 |
| 全部/已开启、有搜索 | 隐藏重复区域 | 显示搜索结果 |
| 收起侧边栏 | 显示置顶图标区 | 显示普通根图标区 |

## 7. 国际化与样式

在 src/shared/i18n/messages/projects.zh-CN.ts 和 projects.en-US.ts 增加同一组键，至少覆盖：

- 区域标题、项目数量、展开/收起；
- 筛选项 all/open/pinned 及切换 tooltip；
- 置顶/取消置顶菜单、按钮 tooltip、状态 aria-label；
- 空状态和操作成功提示。

在 src/styles/components/project-tree.css 增加文件夹式置顶分组、列表、分隔线、图标快捷项和 focus/selected 状态样式，并遵守现有样式导入顺序。颜色和交互状态使用现有设计 token，保持暗色/亮色和紧凑密度一致。

## 8. 风险与处理

| 风险 | 处理 |
| --- | --- |
| 设置中存在旧数据或重复 ID | 加载时做类型校验、去重；派生列表过滤未知项目 |
| 项目树与置顶列表出现两个 sortable 节点 | 置顶行不调用 useSortable，不加入 SortableContext |
| 删除/同步后留下无法启动的快捷项 | 项目集合变化时清理 ID，渲染前再次过滤 |
| 置顶行与普通行上下文操作不一致 | 共享 TreeActions 和项目菜单构造入口 |
| 搜索结果重复出现 | 搜索激活时在全部/已开启视图隐藏独立区域 |
| Settings 和 controller 接近文件长度上限 | 业务逻辑放入新 hook/组件，只在既有入口增加类型和连接代码 |
| 语言切换遗漏文案 | 中英文消息文件同时新增键，并执行手动语言切换验收 |

## 9. 不涉及的边界

本期不修改 Rust、IPC、SQLite migration、项目模型字段或外部依赖；也不实现 issue #254 的搜索功能、置顶拖拽排序、分组/Worktree/终端级独立置顶。
