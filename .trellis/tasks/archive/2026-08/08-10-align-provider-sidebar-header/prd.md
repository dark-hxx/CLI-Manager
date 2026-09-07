# 对齐供应商侧边栏头部规范

## Changelog Target

`[TEMP]`

## Goal

让终端右侧“供应商”面板与实时统计、文件、Git 变更、时间轴和系统资源面板使用同一套标准标题栏，消除供应商面板缺少共享标题栏造成的高度、图标、字号、边框和主题背景不一致。

## Confirmed Facts

- 历史任务 `08-06-terminal-panel-header-cache-rate` 规定终端辅助面板统一使用 `TerminalPanelHeader`。
- `.trellis/spec/frontend/component-guidelines.md` 要求共享标题栏固定为 36px 高、24px 图标容器、12px 标题，并使用终端主题背景和边框。
- `ProviderQuickSwitchPanel` 当前直接从 CLI 类型选择区开始渲染，没有使用 `TerminalPanelHeader`。
- 供应商快捷面板的早期设计曾写明“不增加内容标题”，但该约束与当前共享标题栏规范及本次用户明确要求冲突，本任务以共享标题栏规范为准。

## Requirements

- `ProviderQuickSwitchPanel` 顶部使用现有 `TerminalPanelHeader`，不得复制一套私有标题栏样式。
- 标题使用现有 `terminal.panel.providers` 中英文文案，图标沿用供应商页签的 `ArrowLeftRight`，强调色使用 `TERM_PANEL.green`。
- CLI 类型分段控件继续作为面板内容过滤器显示在共享标题栏下方，保留当前切换、键盘 roving tab 和焦点行为。
- 路由状态、供应商列表、拖拽排序、队列操作和设置入口保持不变。
- 合并侧边面板和独立侧边面板均使用同一供应商内容标题栏。
- 不新增依赖，不修改后端、IPC 或供应商状态逻辑。

## Acceptance Criteria

- [x] 供应商面板顶部通过 `TerminalPanelHeader` 渲染，标题栏高度、背景、边框、图标容器和标题字号与其他终端辅助面板一致。
- [x] 标题在 `zh-CN` 显示“供应商”，在 `en-US` 显示“Providers”，并兼容现有 `zh-TW` 转换。
- [x] CLI 类型分段控件仍位于标题栏下方，Claude/Codex/Grok Build 切换与键盘操作不变。
- [ ] 合并与独立面板、最小宽度、长文案以及深浅终端侧栏皮肤下无新增水平溢出。
- [x] `npx tsc --noEmit` 与 `git diff --check` 通过。
- [x] `[TEMP]` Changelog、功能清单和共享标题栏规范同步更新。

## Technical Approach

- 在 `ProviderQuickSwitchPanel.tsx` 中复用 `TerminalPanelHeader`。
- 使用 `icon={<ArrowLeftRight size={13} />}`、`accent={TERM_PANEL.green}` 和 `title={t("terminal.panel.providers")}`。
- 保留原 CLI 类型区域为标题栏后的第一段正文，不移动其状态或事件处理逻辑。

## Decision (ADR-lite)

**Context**: 供应商面板在统一标题栏规范落地后新增，早期 PRD 沿用了“页签已提供上下文，因此不显示内容标题”的旧假设，导致它成为终端辅助面板中的例外。

**Decision**: 供应商面板加入共享 `TerminalPanelHeader`，正文过滤器与业务内容保持原位。

**Consequences**: 面板增加 36px 标准标题栏高度，但换取与其他侧边面板一致的主题、可访问结构和后续维护入口；不改变数据与交互链路。

## Out of Scope

- 重设计 CLI 类型分段控件。
- 修改路由、故障转移、供应商选择或拖拽排序行为。
- 修改 `TerminalPanelHeader` 本身的尺寸和视觉规范。

## Technical Notes

- 历史规范：`.trellis/tasks/archive/2026-08/08-06-terminal-panel-header-cache-rate/prd.md`。
- 当前契约：`.trellis/spec/frontend/component-guidelines.md` 的 “Terminal auxiliary panels share one themed header”。
- 主要实现：`src/components/terminal/ProviderQuickSwitchPanel.tsx`、`src/components/terminal/TerminalPanelHeader.tsx`。
