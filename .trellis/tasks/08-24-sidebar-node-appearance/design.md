# 技术设计：项目栏节点外观（跨子任务共享契约）

子任务实现前先读本文件；本文件是唯一契约来源，子任务 `implement.md` 只写执行步骤，不重复设计。

## 1. 数据层

migration version 33（当前最大 32，只增不改）：

```sql
ALTER TABLE groups   ADD COLUMN icon  TEXT NOT NULL DEFAULT '';
ALTER TABLE groups   ADD COLUMN color TEXT NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN icon  TEXT NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN color TEXT NOT NULL DEFAULT '';
```

语义：

- `color`：空串 = **默认色**（跟随统一的系统 `--accent`，不做任何自动配色）；非空 = 调色板 token（如 `p3`），不存任意 hex，保证主题适配。
- `icon`：空串 = 类型默认图标；单个 emoji / 非 ASCII 单字 = 直接渲染该字符；其他 = 内置图标 key。

> **2026-08-25 修订**：原设计是"空串走名称 hash 自动配色"，用户明确要求改为统一系统色、只有手动设置才变更。
> `hashName` / `autoAccentToken` 已删除，`resolveNodeAppearance` 不再接收 `name`。
> 同时约定：项目行仅在有显式颜色时显示左侧细色条，分组行不显示色条（显式颜色直接作用于单色文件夹图标）。

`src/lib/types.ts` 的 `Project` / `Group` 各加 `icon: string; color: string;`。

## 2. 外观解析 helper（唯一实现）

新文件 `src/lib/nodeAppearance.ts`，纯函数、无副作用，可在 render 中直接调用：

```ts
export type NodeAppearanceKind = "group" | "project" | "worktree";
export interface NodeAppearance {
  colorVar: string;   // CSS 颜色值，直接喂给 --node-accent
  token: string;      // 调色板 token，用于 UI 回显选中态
  emoji: string;      // 非空则优先渲染
  iconKey: string;    // 内置图标 key，emoji 为空时使用
  isAuto: boolean;    // 是否走的自动配色
}
export function resolveNodeAppearance(input: {
  kind: NodeAppearanceKind; name: string; icon: string; color: string;
}): NodeAppearance;
```

- 调色板固定 10 色，以 CSS 变量形式定义在 `components.css`（`--node-accent-p1..p10`），亮/暗主题各自给值，用 `src/lib/contrast.ts` 校验对比度。
- 自动配色 = `name` 的稳定 hash（如 FNV-1a）取模调色板长度。**不得**使用 `Math.random()`、`Date` 或数组下标（排序变化会导致颜色跳变）。
- 重命名会换自动色，属已接受行为；用户显式设色后即锁定。

## 3. 渲染契约

- 行容器写 `style={{ "--node-accent": appearance.colorVar }}`，下游样式一律读该变量，禁止在组件里硬编码颜色。
- 着色范围仅两处：leading icon 颜色 + 选中态左侧 2px 色条（伪元素）。**不铺整行背景** —— `data-status` 已用背景表达运行态，整行上色会与之冲突且暗色主题下发糊。
- 图标优先级：`emoji` → `iconKey` → 类型默认（分组 `Folder`、项目 `resolveCliToolIconKey(cli_tool)` 回退 `Terminal`）。
- worktree 行不引入独立外观，继承所属项目的 `--node-accent`。

## 4. 编辑入口（统一一个组件）

新组件 `NodeAppearancePopover`，基于既有 `src/components/ui/popover.tsx`（Radix）：内容为 10 色板 + 「自动」重置 + 单字符 emoji 输入框。三处触发：

1. 内联新建行的图标按钮（`TreeNodeItem.tsx:464-472` 的 `Folder` 换成按钮）——不点则落自动色，回车照旧一步建组。
2. 右键菜单新增「外观」项（分组菜单 `sidebar/index.tsx:2540-2601`，项目菜单 `:2301-2338`）。
3. 项目编辑弹框（`setShowAdd` / ConfigModal 项目表单）内嵌同一组控件。

写入统一走 `projectStore`（`updateProject` / 分组对应更新函数），不新增 store。

## 5. 同步契约

导出侧：`src/stores/syncStore.ts:132` `PROJECT_SELECT`、`:133` `GROUP_SELECT` 加 `icon, color`。

恢复侧：`buildWorkspaceRestoreStatements`（`:393` 的 groups 列表与对应 projects 列表）加同名列，取值 `item.icon ?? ""` / `item.color ?? ""`。

兼容与已接受副作用：

- 旧客户端快照无这两个字段 → 兜底空串，恢复后退回自动配色，视觉不退化。
- 恢复流程是 `DELETE FROM` + 重插（`:377-392`），因此**用旧快照恢复会清空本地手动标记**（退回自动配色，不会变成无色）。默认按"可接受 + 恢复预览给出提示文案"处理；若需要字段级保留（恢复时不覆盖本地非空外观），需用户明确要求，届时回到本设计修订。

## 6. 样式复用点清单（必须一并验证）

| 位置 | 说明 |
|---|---|
| `components.css:1481` | `.ui-tree-leading-icon` 基础色，改为读 `--node-accent` |
| `components.css:1497` | `.ui-project-tree-root` 对 leading-icon 的尺寸/背景重置 |
| `components.css:2089` | `.ui-split-project-picker` 覆写（分屏项目选择器） |
| `components.css:1549-1559` | `data-cli-tool` 徽章配色，P0 子任务复用 |
| 折叠侧边栏窄条 | 只剩图标时颜色仍需可区分 |

## 7. 风险与对策

- 暗色主题饱和度不足 → 调色板按主题分别给值，必要时 `color-mix` 提亮，`contrast.ts` 校验。
- 三处树漂移 → 唯一 helper，禁止各处自行 hash。
- 迁移回滚 → 新列均有 `DEFAULT ''`，旧版本客户端读库不受影响（不读该列即可）。

## 8. 数据库并发与执行顺序（强约束）

用户明确要求关注此项。已核实的既有机制与必须遵守的顺序：

**8.1 迁移**：新增 migration 33 只能追加在 `migrations()` 列表末尾，不得修改历史项。新列均 `NOT NULL DEFAULT ''`，旧版本客户端不读该列即可正常运行（前向兼容）。

**8.2 恢复是单事务 + 全局互斥**（`src-tauri/src/commands/sync.rs`）：
- `backup_restore_database`（`:470`）先取全局 `backup_database_restore_lock`（`:473`），再以 `foreign_keys(true)` + `busy_timeout(15s)` 打开连接。
- `execute_backup_database_restore`（`:104`）用 `BEGIN IMMEDIATE` 包住全部语句，任一失败整体回滚。
- 因为开了外键约束，语句顺序是硬要求：DELETE 必须子表先于父表（templates → worktrees → projects → ssh_hosts → ssh_host_groups → groups），INSERT 必须父表先于子表（groups → ssh_host_groups → ssh_hosts → projects → worktrees → templates）。前端 `buildWorkspaceRestoreStatements` 现有顺序已满足，新增列**不得**改变语句顺序，也不得在中间插入新语句类型。

**8.3 SQL 白名单是前后端锁步点**（关键）：
- `BACKUP_RESTORE_INSERT_COLUMNS`（`sync.rs:30-56`）是精确字符串白名单，`groups` 为 `id,name,parent_id,sort_order,created_at`（`:31`）、`projects` 为 20 列（`:42`）。
- 前端 INSERT 加列后若未同步改这里，`validate_backup_database_statement`（`:72`）会整批拒绝并回滚，恢复**完全失败**而非部分失败。
- 因此前端列清单与 Rust 白名单必须在同一次提交里同时修改，且列顺序完全一致。
- validator 只放行白名单 DELETE 与 `INSERT INTO t (cols) VALUES (...)`；任何 `UPDATE` / 多语句（含 `;`）都会被拒——不要试图用"恢复后补一条 UPDATE 修外观"的方案。
- 参数预算：单语句 ≤ 30000 个绑定参数（`:20`）、单次 ≤ 1000 条语句（`:19`）。projects 20 → 22 列、groups 5 → 7 列，需复核 `buildBatchInsertStatements` 的分片行数仍在预算内。

**8.4 应用内写入顺序**：
- 新建分组时外观随 **同一条 INSERT** 落库，禁止 "INSERT 后再 UPDATE" 两步——两步会与 `projectStore.fetchAll()` 刷新交错，出现先自动色后跳变。
- 外观修改只发针对单行的 UPDATE（带 id），不做整表或整行全字段重写，避免与并发的其他字段写入互相覆盖。
- 恢复完成后必须重新 `fetchAll()`，否则内存态与库不一致；恢复期间不要允许外观编辑提交（恢复持有全局锁，此时写入会等锁或超时）。
