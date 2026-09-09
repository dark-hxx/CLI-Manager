# 实施计划：项目栏“已置顶”快捷入口

## 前置门槛

- [x] 读取相关 frontend/guides 契约；按仓库实际存在的文件调整。
- [x] 对将修改的函数/组件先执行 GitNexus upstream impact；索引不可用时记录降级原因并用契约和符号搜索补齐影响分析。
- [x] 保留工作区已有的 .trellis/tasks/09-09-worktree-force-merge/ 未跟踪目录，不把它纳入本任务改动。

## 实施步骤

### 1. 设置与同步

- [x] 在 Settings、默认值和加载校验中加入 pinnedProjectIds 与 sidebarPinnedSectionCollapsed。
- [x] 将两项加入 SETTING_BACKUP_POLICY，保持现有设置同步/恢复兼容。
- [x] 在项目列表变化、删除、恢复和同步路径验证未知 ID 清理，不改变 SQLite schema。

### 2. 置顶状态 hook

- [x] 新增 src/features/projects/hooks/usePinnedProjects.ts。
- [x] 提供派生置顶项目、isPinned、toggle 和区域收起状态操作。
- [x] 保持数组顺序作为置顶顺序，置顶追加、取消移除。
- [x] 让状态入口使用现有项目 ID和 settings update API，避免增加全局聚合入口。

### 3. 筛选与侧边栏组合

- [x] 将 ProjectListFilter 扩展为 all | open | pinned。
- [x] 在 SidebarHeader 增加“已置顶”选项、数量及收起状态下的可访问循环切换。
- [x] 在 useSidebarController / SidebarView 连接置顶数据与筛选结果。
- [x] 按显示矩阵处理搜索激活、全部/已开启/已置顶、侧边栏展开/收起和空状态。

### 4. 置顶区域与项目行

- [x] 新增 PinnedProjectSection（必要时拆出小型 pinned item），实现类似文件夹的标题、数量、折叠和置顶项目列表；无置顶项目时不渲染分组。
- [x] 置顶项目行复用现有项目展示数据、选择、启动和上下文操作。
- [x] 将普通项目行的 Pin 操作及状态加入 TreeNodeItem，保证操作不会误触发选择或拖拽。
- [x] 置顶项目行不使用 useSortable，不进入普通树的 SortableContext。
- [x] 增加同项目双位置的 selected/focus 状态同步和键盘 Enter/Space 行为。

### 5. 文案与样式

- [x] 同步更新 projects.zh-CN.ts 与 projects.en-US.ts，覆盖按钮、菜单、tooltip、aria-label、空状态和通知。
- [x] 在 project-tree.css 增加置顶区域和收起图标样式，覆盖 selected/focus/hover/density/dark mode。
- [x] 确认不引入硬编码中文/英文，不改变英文时间格式。

### 6. 交付文档

- [x] 按仓库现有格式在 CHANGELOG.md 的 V1.4.0 下记录项目置顶功能。
- [x] 在 docs/功能清单.md 的项目管理/侧边栏功能板块记录“已置顶”区域和筛选项。

## 验证清单

### 定向验证

- [x] npx tsc --noEmit
- [x] npm run check:architecture
- [x] npm run check:architecture -- --strict
- [x] package.json 无独立 lint/test 脚本；npm run build 已覆盖 tsc + Vite 构建。
- [x] 本次没有修改 Rust/IPC，不需要 Rust 编译；新增同步恢复顺序仍通过前端类型检查和构建。

### 手动验收

- [ ] 中文：置顶、取消置顶、收起/展开、全部/已开启/已置顶、空状态、上下文菜单。
- [ ] 英文：同一流程，检查 tooltip/aria-label 和布局。
- [ ] 项目重命名、移动分组、删除后刷新。
- [ ] 关闭并重新打开应用，验证 pin 列表和区域折叠状态。
- [ ] 展开/收起侧边栏、紧凑密度、搜索激活、Focus mode。
- [ ] 本地 PowerShell/CMD/Pwsh、WSL/Bash、Worktree、分屏和多会话路径按既有行为启动。
- [x] GitNexus detect_changes 检查改动符号与执行流范围。

## 回滚点

- [ ] 若 UI 组合问题，先回滚 PinnedProjectSection 和筛选连接，保留设置字段不影响旧版本读取。
- [ ] 若同步兼容问题，移除同步策略条目；未知设置字段应继续被旧版本忽略。
- [ ] 若行为回归，关闭置顶筛选入口并保留普通项目树，恢复默认 pinnedProjectIds: []。

## 验证备注

- 用户验收反馈确认：项目筛选入口由设置控制，默认不展示；不因存在置顶项目自动打开三态筛选。已将置顶区域改为类似普通文件夹的分组，仅在存在有效置顶项目时渲染，子项为用户选择的置顶项目；并保留 Pin 在启动按钮左侧。
- 本次反馈属于行为与展示收敛，根因在置顶分组与筛选入口的显示职责混合；已检查无置顶/有置顶、展开/收起、紧凑密度、搜索、已开启筛选、侧边栏折叠和键盘场景，均保留既有矩阵语义。
- GitNexus 索引相对当前提交滞后，`impact` 对本批新增符号返回 not found；已通过相关契约、`rg` 符号搜索和前端数据流检查补齐影响分析，未返回 HIGH/CRITICAL 风险。
- `detect_changes` 最终返回 low risk、0 个受影响执行流；结果主要识别了并行 Worktree 任务的既有 Rust 改动，未识别出本批新增前端符号。
