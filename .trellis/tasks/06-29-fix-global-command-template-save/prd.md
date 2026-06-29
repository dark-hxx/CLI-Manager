# fix global command template save without project path

## Goal

修复命令模板在“全局”作用域下的保存限制，允许全局模板在 `command` 为空时也能创建，并保持现有项目模板、会话模板行为不被破坏。

## What I already know

* 用户反馈：“命令模板的全局生效，不写项目路径就无法保存。”
* 用户确认：设置页模板管理、终端命令模板弹层两个入口都存在相同问题。
* 用户确认：点击保存后没有报错，但新建的全局模板不会出现在列表里。
* 用户最终确认的目标行为：
  当作用域是全局时，允许 `command` 为空也能保存模板。
* 模板持久化表 `command_templates` 仅包含 `project_id`，数据库层允许 `NULL`。
* 当前前端有两个创建入口：
  `src/components/settings/pages/TemplateSettingsPage.tsx`
  `src/components/CommandTemplatePanel.tsx`
* 两个入口都会调用 `src/stores/templateStore.ts` 的 `createTemplate` / `createSessionTemplate`。
* 代码中没有找到显式“必须填写项目路径”或“命令必须包含 ${projectPath}”的校验。
* GitNexus 影响分析结果：
  `TemplateSettingsPage` 上游风险 `LOW`
  `CommandTemplatePanel` 上游风险 `LOW`
* 已直接检查真实运行数据库：
  `C:\\Users\\Administrator\\AppData\\Roaming\\com.cli-manager.app\\cli-manager.db`
  现有 `command_templates` 表结构允许 `project_id = NULL`。
* 已对真实库做临时探针插入并回滚，`project_id = NULL` 的全局模板可以成功写入。

## Assumptions (temporary)

* 当前代码中的真实限制是前端把 `command` 当作统一必填项，而不是数据库约束。
* “项目路径”更像是 UI 侧上下文/提示带来的现象，不是数据库字段本身。

## Requirements (evolving)

* 当作用域为全局时，允许 `command` 为空并保存模板。
* 当作用域为项目时，仍然要求 `command` 非空，且仍需显式绑定项目。
* 当作用域为会话时，仍然要求 `command` 非空，且仍需依赖当前活跃会话。
* 设置页模板管理与终端命令模板弹层两个入口行为必须一致。

## Acceptance Criteria (evolving)

* [ ] 在设置页中，选择“全局”后，即使 `command` 为空也可以保存模板。
* [ ] 在终端命令模板弹层中，选择“全局”后，即使 `command` 为空也可以保存模板。
* [ ] 项目模板在 `command` 为空时仍然不可保存，且缺少项目绑定时仍然不可保存。
* [ ] 会话模板在 `command` 为空时仍然不可保存，且缺少活跃会话时仍然不可保存。
* [ ] `npx tsc --noEmit` 通过。

## Definition of Done (team quality bar)

* Tests added/updated (unit/integration where appropriate)
* Lint / typecheck / CI green
* Docs/notes updated if behavior changes
* Rollout/rollback considered if risky

## Out of Scope (explicit)

* 不改动命令模板的数据表结构。
* 不重做模板管理 UI。
* 不调整命令模板执行时的变量替换语义。

## Technical Notes

* 已检查：
  `src/components/settings/pages/TemplateSettingsPage.tsx`
  `src/components/CommandTemplatePanel.tsx`
  `src/stores/templateStore.ts`
  `src-tauri/src/lib.rs`
* 近期相关改动主要在：
  `c7b2bd5`
  `e53f2da`
* 当前最高概率修复点：
  `src/components/settings/pages/TemplateSettingsPage.tsx`
  `src/components/CommandTemplatePanel.tsx`
* 计划把 `command` 是否必填改为“按作用域判断”，不改数据库结构。
