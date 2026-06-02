# terminal-cli-tool-combobox-custom-input

## Goal

新增终端/项目配置时，CLI 工具字段改为可下拉选择常用工具，同时保留自定义输入能力，避免只能从固定选项里选。

## What I already know

* 用户希望“新增终端的时候 CLI 工具的选项改成下拉框选择也需要支持自定义输入”。
* `src/components/ConfigModal.tsx` 目前维护 `cliTool` 状态，并在保存时写入 `cli_tool`。
* 初步搜索显示 CLI 工具字段当前渲染为 `Field label="CLI 工具" ... placeholder="claude / codex / custom"`。

## Assumptions (temporary)

* 本任务范围只覆盖新增/编辑项目配置弹窗里的 CLI 工具输入，不改变终端启动、历史、项目存储逻辑。
* 下拉常用选项至少包含现有占位提示里的 `claude`、`codex`，自定义值仍应按原逻辑 trim 后保存。

## Open Questions

* 无阻塞问题。默认沿用现有占位提示里的 `claude`、`codex` 作为候选项。

## Requirements (evolving)

* CLI 工具字段支持从常用项下拉选择。
* CLI 工具字段支持输入任意自定义值。
* 保存行为沿用现有 `cli_tool` 写入逻辑。
* 不新增依赖，不调整数据库结构。

## Acceptance Criteria

* [x] 新增终端/项目时可以选择常用 CLI 工具。
* [x] 可以输入不在下拉项里的自定义 CLI 工具名称并保存。
* [x] 编辑已有项目时，已有自定义 CLI 工具值能正确显示。
* [x] 类型检查通过。
* [x] 生产构建通过。
* [ ] 浏览器/桌面手动验证（用户选择跳过）。

## Definition of Done (team quality bar)

* Tests added/updated where appropriate.
* Lint / typecheck / CI-relevant checks pass.
* Docs/notes updated if behavior changes.
* Rollout/rollback considered if risky.

## Out of Scope (explicit)

* 不改变 `cli_tool` 的数据结构或数据库迁移。
* 不改变终端启动命令解析逻辑。
* 不新增依赖。

## Decision (ADR-lite)

**Context**: CLI 工具字段需要同时支持常用项选择和任意自定义输入。
**Decision**: 使用原生 `Input` + `datalist`，候选项为 `claude`、`codex`。
**Consequences**: 改动最小，无依赖和数据结构变化；下拉外观由 Chromium 原生控件决定。

## Technical Notes

* 候选文件：`src/components/ConfigModal.tsx`。
* `cliTool` 当前是字符串 state，保存时已经按 `cliTool.trim()` 写入 `cli_tool`，因此数据层无需改动。
* 当前 CLI 工具字段使用本地 `Field` + `Input` 文本框渲染。
* 项目已有 `Select` 是 Radix Select，适合固定选项，不适合自定义输入；原生 `input[list]` + `datalist` 更符合本任务。
* GitNexus impact：`ConfigModal` LOW，0 direct callers，0 affected processes；`Field` LOW，0 direct callers，0 affected processes。
* 项目偏好：最小改动、沿用现有 React 状态与 CSS 模式。
