# 执行计划：外观数据层

前置阅读顺序：父任务 `prd.md` → 父任务 `design.md` §1/§2/§7 → 本文件。

## 步骤

1. `src-tauri/src/lib.rs`：仿照 `MIGRATION_BACKFILL_REQUEST_LOG_PROJECT_PATH_VERSION`（`:682`）的写法新增 `MIGRATION_ADD_NODE_APPEARANCE_VERSION: i64 = 33` 与对应 SQL 常量，并在 `migrations()` 的 `Migration` 列表尾部登记。SQL 见父任务 `design.md` §1。
2. `src/lib/types.ts`：`Project` 与 `Group` 各加 `icon: string; color: string;`。
   - `projectStore.ts:183-184` 走 `SELECT *`，读取侧无需改 SQL，但要确认新字段进入类型后无 `undefined` 访问。
3. `src/stores/projectStore.ts`：`createGroup` / 分组更新 / `updateProject` 的 INSERT/UPDATE 语句补新列，默认写空串。
4. 新增 `src/lib/nodeAppearance.ts`：
   - `NODE_ACCENT_TOKENS`（`p1..p10`）常量；
   - `hashName(name: string): number`（FNV-1a，纯函数）；
   - `resolveNodeAppearance(input)` 按 design §2 返回 `NodeAppearance`；
   - emoji 判定：取 `Array.from(icon)` 长度为 1 且非 ASCII 视为 emoji，其余按 iconKey 处理。
5. `src/styles/components.css`：定义 `--node-accent-p1..p10`，在 `[data-theme="dark"]` 下覆写；用 `src/lib/contrast.ts` 逐色核对与 `--surface-container-lowest` / `--on-surface` 的对比度，不达标则调整。
6. 验证脚本：项目无前端测试框架，写一个临时 `node --experimental-strip-types` 或 `npx tsx` 小脚本跑 `resolveNodeAppearance` 的 4 组断言（同名稳定 / 非法 token 回落 / emoji 优先 / 空值默认），跑完删除临时文件。
7. 更新 `CHANGELOG.md`（追加到既有 `## [V1.3.8]` 段）与 `docs/功能清单.md`；顺带修正 `CLAUDE.md` 里的 migration 版本描述。

## 验证

```bash
npx tsc --noEmit
cd src-tauri && cargo check
```

迁移验证：以现有本地库启动一次 `npm run tauri dev`，确认无 migration 报错、`projects` / `groups` 新列存在且为空串。

## 实现结果（与计划的偏差）

- **`nodeAppearance.ts` 保持零依赖**，并从入参里去掉了 `kind`：
  - 零依赖是为了能用 `tsc` 单文件编译后在 Node 里跑真实断言（项目无测试框架，不引新依赖）。
  - 去掉 `kind` 是因为把它掺进 hash 会让"同一节点在三处树颜色一致"依赖调用方传对 kind，一旦传错就静默漂移；只按 name 取色则任何调用方都必然一致。
  - 因此 CLI 工具图标的回退**不在**本 helper 内，仍由渲染端组合 `resolveCliToolIconKey`（子任务 ③/④ 的共享图标组件负责）。`iconKey` 为空即表示"按节点类型回退默认图标"。
- **调色板放 `themes.css` 而不是 `components.css`**：主题作用域的颜色 token 都在 `themes.css` 的 `:root, [data-theme="dark"]` / `[data-theme="light"]` 块里，放 components.css 会割裂主题体系。
- **`updateProject` 无需改造**：它本来就是按 `Object.entries(input)` 动态拼 `UPDATE ... WHERE id`，天然满足 design §8.4 的"单行、只更改动列"。只补了 icon/color 的入库前归一化。分组侧新增 `updateGroupAppearance(id, { icon?, color? })`，同样是单行局部 UPDATE。
- **额外核查（并发相关）**：`commands/db_repair.rs` 的 `repair_known_migration_drift` 只处理 v13–v15 与两个 SSH 主机 migration（`KNOWN_DRIFT_START_VERSION` / `KNOWN_DRIFT_END_VERSION`），migration 33 落在窗口外，不会被误删重放。已把该结论写进 `CLAUDE.md`。

## 已执行验证

- `npx tsc --noEmit`：无错误。
- `cd src-tauri && cargo check`：通过（4 crates 重新编译）。
- `nodeAppearance` 运行时断言：单文件编译到临时目录后用 Node 跑 20 条断言，全部通过 —— 同名稳定、trim/大小写无关、非法 hex 与越界 token 回落自动、大写 token 归一化、`null` 不抛错、emoji/ZWJ/旗帜/CJK 单字识别、内置图标 key 不误判、多 emoji 不算标记、空名称仍得合法 token、400 个名字覆盖全部 10 色。
- 调色板对比度（用 `contrast.ts` 的真实实现算）：亮色对 `#ffffff` 3.30–7.58，暗色对 `#141414` 6.18–11.04，全部 ≥ 3:1。
- 临时目录 `.tmp-verify/` 已删除。
- 注意：`npx tsc` 会被 rtk 代理包装并可能吞掉 emit，单文件编译要用 `node node_modules/typescript/bin/tsc`。
- 未执行：应用内启动验证（migration 33 实际落库、新列为空串）—— 需要用户跑一次 `npm run tauri dev` 确认。

## 2026-08-25 追加：`no such column: color` 与缺列自愈

用户反馈右键「外观标记」持续报 `error returned from database: (code: 1) no such column: color`。静态排查结论：

- migration 版本审计（脚本解析 `migrations()`）：33 条、版本唯一且单调，33 是最后一条，没有撞号或回退。
- 注册路径正确：`.add_migrations(&app_paths::db_url(), migrations())`，前端 `Database.load(paths.dbUrl)` 用的是同一个 URL，不存在两个库。
- 多语句 SQL 有仓内先例（worktree 隔离迁移同样一串四条 DDL），SQLite 允许 `ADD COLUMN ... NOT NULL DEFAULT ''`。
- 因此代码侧没找到会让 33 不执行的原因；最可能仍是运行中的 Rust 进程早于该改动（`npm run tauri dev` 只热更新前端，Rust 需要重启重建）。

为了让这个功能不会因为迁移漂移被永久卡死，新增 `ensure_node_appearance_columns`（`commands/db_repair.rs`），在每次打开数据库前的既有修复命令里执行：

- 「版本已登记 + 列缺失」→ 补列（这正是报错现象对应的漂移）。
- 「列已存在 + 版本未登记」→ 按同一 checksum 补登记，避免 sqlx 重放 ALTER 撞 `duplicate column name`。
- 「列缺失 + 版本未登记」→ 也在数据库打开前补列并登记，避免首次外观写入先于 SQLx 迁移而撞 `no such column: color`。
- 三种情况都在 `BEGIN IMMEDIATE` 事务内完成，失败回滚；列齐全且已登记时保持幂等。

配套改动：`table_columns` 支持 `groups` 表（原来只白名单了 projects 等，不加会返回 `migration_repair_unsupported_table`）；migration 33 的三个常量以 `NODE_APPEARANCE_MIGRATION_*` 形式对 crate 内公开。

验证：`cargo test --lib appearance_repair` 3 passed（已登记补列、补登记、未登记补列并登记各一条，含幂等断言）；`cargo test --lib db_repair` 18 passed；`cargo check` 通过。

## 回滚点

- 步骤 1 单独可回滚（未被任何代码读取前，新增列不影响运行）。
- 步骤 4-5 是纯新增文件与新增 CSS 变量，删除即回滚。
