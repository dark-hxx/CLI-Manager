# 完善终端 Tab 悬浮信息卡

## Goal

修复默认单终端 Workspan 顶层 Tab 无法显示悬浮信息的问题，并让悬浮卡片跟随终端主题、提供清晰的字段图标、CLI 厂商图标和路径复制能力。

## Requirements

- 设置中的“终端 Tab 悬浮信息”开关同时控制 Pane 内终端 Tab 与单终端 Workspan 顶层 Tab。
- 悬浮卡片背景、文字、边框、阴影和交互色跟随当前终端主题。
- CLI、Shell、项目、路径、Session ID 标签显示对应 Lucide 图标。
- CLI 值根据现有 `inferVendor` / `VendorIcon` 显示厂商图标，例如 Codex 显示 OpenAI 图标；未知 CLI 不显示错误图标。
- 路径与 Session ID 均提供复制按钮，复制完整值而不是省略后的显示文本。
- 新增或修改的可见文案兼容 `zh-CN`、`zh-TW` 和 `en-US`。
- 多终端 Workspan 不展示单一 Session 信息，避免误导。

## Acceptance Criteria

- [ ] 开启悬浮信息后，普通终端 Tab 与单终端 Workspan Tab 均可显示卡片；关闭后均不显示。
- [ ] Codex、Claude 等已知 CLI 显示对应厂商图标，未知 CLI 保持可读且不报错。
- [ ] CLI、Shell、项目、路径、Session ID 五行标签均有一致尺寸的图标。
- [ ] 路径复制按钮复制完整路径，并提供双语可访问名称和成功/失败提示。
- [ ] Session ID 复制行为保持正常。
- [ ] 深色、浅色及自定义终端主题下卡片可读。
- [ ] `npx tsc --noEmit` 与 `git diff --check` 通过。

## Technical Approach

- 复用现有 `VendorIcon`、Lucide 图标导出和终端菜单主题变量，不新增依赖。
- 在 `TerminalTabHoverInfo` 中携带推断后的厂商标识；卡片行模型同时携带字段图标和可选复制动作。
- 复制按钮使用语义化 `button`、双语 `aria-label` / `title` 和现有 toast 机制。

## Out of Scope

- 不为多终端 Workspan 设计聚合详情卡。
- 不修改终端主题系统或 CLI 厂商映射规则。
- 不启动 Tauri 应用执行自动视觉验证。

## Changelog Target

`[TEMP]`

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
