# 外观数据层：icon/color 字段与外观解析

父任务：`08-24-sidebar-node-appearance`。技术契约见父任务 `design.md` §1、§2、§7。
依赖：无。子任务 ③④⑤ 依赖本任务产出的字段与 helper。

## Goal

落地外观数据的存储与解析：数据库列、TS 类型、写入路径，以及三处项目树共用的唯一外观解析实现（含自动配色兜底）。本任务不改任何渲染。

## Requirements

- R-D1 migration version 33，为 `groups` 与 `projects` 各增加 `icon` / `color` 两列，均 `TEXT NOT NULL DEFAULT ''`，不修改任何历史 migration。
- R-D2 `src/lib/types.ts` 的 `Project` / `Group` 增加对应字段；`projectStore` 的读写路径（`SELECT *` 读取、`createGroup` / `updateProject` 等写入）覆盖新字段。
- R-D3 新增 `src/lib/nodeAppearance.ts`，导出 `resolveNodeAppearance`，签名与语义严格按父任务 `design.md` §2。
- R-D4 自动配色使用名称的稳定 hash（如 FNV-1a），禁止 `Math.random()` / 时间 / 数组下标参与，保证同名同色、排序变化不换色。
- R-D5 调色板 10 色以 CSS 变量 `--node-accent-p1..p10` 定义在 `src/styles/components.css`，亮/暗主题分别给值，并用 `src/lib/contrast.ts` 校验与文字/背景的对比度。
- R-D6 `color` 只接受调色板 token 或空串，非法值按空串处理（回落自动色），不得抛错。

## 非目标

- 不改 `TreeNodeItem` 及任何渲染组件。
- 不做编辑 UI，不改 WebDAV 同步（分别属子任务 ③ 与 ⑤）。

## Acceptance Criteria

- [ ] 全新数据库与既有数据库都能升到 33，旧数据行新列为空串
- [ ] `resolveNodeAppearance` 有单元级验证：同名稳定、非法 token 回落、emoji 优先级正确
- [ ] 10 色在亮/暗主题下均通过对比度校验
- [ ] `npx tsc --noEmit` 与 `cd src-tauri && cargo check` 通过
- [ ] `CHANGELOG.md` 与 `docs/功能清单.md` 已更新

## 备注

`CLAUDE.md` 中"migrations 当前到 v13"的描述已过期（实际 32），本任务顺带更正该处文档。
