# 项目 CLI 启动参数历史下拉

## Goal

在新建项目时，为“CLI 启动参数”输入框提供历史下拉选项，并按使用次数排序，减少重复输入。

## What I already know

- 用户要求仅明确指向“新建项目”流程。
- `src/components/ConfigModal.tsx` 负责新建、编辑和克隆项目表单。
- CLI 参数在成功创建项目后保存到 SQLite 的 `projects.cli_args`，CLI 工具保存在 `projects.cli_tool`。
- 用户已选择独立持久化历史，项目删除后仍保留使用记录。
- 用户可见文案必须同时支持 `zh-CN`、`zh-TW`（由简体转换）和 `en-US`。
- GitNexus 索引不可用：缺少 `.gitnexus/lbug`，代码触点已降级通过前端契约、`rg` 和直接文件读取确认。

## Assumptions (temporary)

- 历史使用本地设置存储持久化，不新增数据库表。
- 历史按当前 CLI 工具过滤，避免 Claude、Codex 等工具的参数混用。
- 空白参数不进入历史；参数首尾空白被忽略，参数内部保持原样。
- 使用次数相同时优先最近使用的参数。

## Open Questions

- 无。

## Requirements (evolving)

- 新建项目且已选择 CLI 工具时，CLI 启动参数输入框可展开历史选项。
- 历史选项展示参数内容和使用次数。
- 历史独立持久化，成功新建项目后累计一次，创建失败不计数。
- 下拉仅展示排序后的前 10 条。
- 历史按规范化后的 CLI 工具分别统计，避免不同工具参数混用。
- 只有从空白“新建项目”成功创建时累计；编辑和克隆均不累计。
- 选择历史项后回填输入框，仍允许继续自由编辑。
- 键盘和鼠标均可操作下拉框。

## Acceptance Criteria (evolving)

- [ ] 新建项目时可看到与当前 CLI 工具匹配的非空历史参数。
- [ ] 相同参数合并，并按使用次数从高到低排列。
- [ ] 下拉最多展示 10 条历史记录。
- [ ] 点击或键盘确认历史项后，输入框得到完整参数。
- [ ] 无历史时不展示空下拉列表，手动输入行为不受影响。
- [ ] 编辑项目流程不被改变。
- [ ] 中英文界面文案与 aria 标签正确。

## Scenario Matrix

| 场景 | MVP 行为 |
|---|---|
| 新建项目 | 展示历史下拉 |
| 编辑项目 | 保持现有输入行为，不新增历史下拉 |
| 克隆项目 | 保留克隆参数，不累计历史次数；不新增历史下拉 |
| 本地 / WSL / SSH | 参数历史逻辑一致 |
| 未选择 CLI 工具 | 不展示 CLI 参数字段及历史 |
| 切换 CLI 工具 | 历史列表随工具切换，当前手输值不自动覆盖 |
| 空参数 | 不计入历史 |
| 相同次数 | 以最近使用时间降序作为次级排序 |
| 窗口焦点、分屏、托盘、Workspan、Focus Mode、Worktree、Hook | 与该表单内本地交互无关，确认不受影响 |

## Definition of Done

- 相关 TypeScript 类型检查通过。
- 针对记录、合并和排序逻辑补充自动化测试或等价验证。
- 更新 `CHANGELOG.md` 的 `[TEMP]` 条目。
- 产品功能变化同步更新 `docs/功能清单.md`。
- 手动验证新建、编辑、克隆、CLI 工具切换、无历史和中英文界面。

## Out of Scope (explicit)

- 历史项的手动删除、置顶或管理页面。
- 启动命令字段的历史下拉。
- 修改终端实际启动命令拼接逻辑。
- 新增依赖。

## Technical Notes

- 主要候选文件：`src/components/ConfigModal.tsx`、`src/lib/i18n.ts`。
- 持久化使用 `settingsStore`，复用现有 Tauri Store，并纳入偏好设置快照同步。
- 参数最终消费仍由 `src/lib/projectStartupCommand.ts` 负责，本需求不修改该链路。
- Changelog Target: `[TEMP]`。

## Decision (ADR-lite)

**Context**: 历史需要在项目删除后仍可用于下次填写。

**Decision**: 独立持久化 CLI 参数使用记录；成功新建项目时累计次数；下拉按次数、最近使用时间排序并截取前 10 条。

**Consequences**: 需要新增本地设置字段及兼容默认值，但无需修改 SQLite 表结构。

**Additional decision**: 每个 CLI 工具维护独立历史排行。

**Additional decision**: 只有空白新建项目成功后累计；编辑和克隆不累计。

**Additional decision**: CLI 参数历史随偏好设置快照同步，恢复时覆盖本地历史，不合并两端计数。

## Technical Approach

- 在独立纯函数模块中定义历史记录结构、兼容清洗、累计和排序逻辑。
- 在 `settingsStore` 增加历史字段和记录方法，复用现有 Tauri Store；同步策略标记为 `preferences`。
- `ConfigModal` 仅在 `!isEdit && !isClone` 时渲染历史组合输入框；成功创建后再调用记录方法。
- 下拉按当前 CLI 工具过滤，排序规则为次数降序、最近使用时间降序，渲染前 10 条。
- 下拉复用现有 `CliToolCombobox` 的键盘、焦点关闭和 listbox 可访问性模式。

## Discovery List

- `src/components/ConfigModal.tsx`：输入、创建成功时机、下拉交互；需要修改。
- `src/stores/settingsStore.ts`：本地持久化、默认值、加载清洗、记录动作；需要修改。
- `src/lib/syncSettings.ts`：历史归入偏好设置快照；恢复时遵循现有整字段覆盖语义，不合并两端计数。
- `src/lib/i18n.ts`：次数、历史下拉 aria/提示文案；需要修改。
- `src/lib/projectStartupCommand.ts`：仅消费最终参数，确认无关，不修改。
- `src/stores/projectStore.ts`：负责项目创建；组件已能判断成功返回，确认无需修改。
- `src/lib/types.ts`：项目结构不变，确认无需修改。
- `CHANGELOG.md`、`docs/功能清单.md`：交付文档需要更新。
