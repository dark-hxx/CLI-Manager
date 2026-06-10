# keyboard shortcut discoverability

## Goal

让会话历史和命令面板的入口更容易被发现，同时修正命令面板打开后的默认可见性问题，降低用户对快捷键和面板状态的困惑。

## Requirements

* 将会话历史快捷键纳入现有快捷键设置，默认 `Ctrl+K`。
* 会话历史入口 tooltip / UI 文案使用当前设置值，而不是硬编码。
* `Ctrl+K` 打开会话历史时继续触发全局历史搜索聚焦。
* 命令面板打开后，在未输入搜索词时直接展示默认可用条目。
* 命令面板补充清晰的快捷键 / `Esc` 退出提示。
* `Esc` 关闭历史和命令面板的现有行为保持不变。

## Acceptance Criteria

* [x] 快捷键设置页出现“会话历史”，默认值为 `Ctrl+K`，且可修改。
* [x] 会话历史按钮 tooltip 显示当前配置的快捷键。
* [x] 使用配置后的会话历史快捷键能打开会话历史并聚焦全局搜索。
* [x] `Ctrl+P` 打开命令面板后，不输入搜索词也能看到默认命令/项目/模板条目。
* [x] 命令面板可见区域提示 `Esc` 关闭。
* [x] `npx tsc --noEmit` 通过。

## Definition of Done

* 代码改动最小，优先复用现有设置和面板结构。
* 不引入新依赖。
* 按项目规范不自动启动 Tauri 桌面应用，交互验证项交给用户手动确认。

## Technical Approach

复用 `settingsStore.keyboardShortcuts`，新增 `sessionHistory` 动作并依赖现有默认值 merge 兼容旧配置；`useKeyboardShortcuts` 从设置读取该动作；`CommandPalette` 保持现有数据源，只修正默认渲染/提示，不重做命令体系。

## Decision (ADR-lite)

**Context**: `Ctrl+K` 目前是硬编码入口，用户无法在快捷键设置中发现或修改；命令面板已有设置项但打开后默认体验不清晰。

**Decision**: 将 `Ctrl+K` 纳入现有快捷键设置体系，同时只对命令面板做最小 UI/渲染修正。

**Consequences**: 旧配置通过默认值 merge 自动补字段；如果用户配置冲突，沿用现有快捷键设置页冲突提示，不新增复杂冲突阻止逻辑。

## Out of Scope

* 不重做整套快捷键体系。
* 不改动终端核心交互。
* 不新增依赖或后台服务。
* 不自动启动 Tauri 桌面应用。

## Technical Notes

* `src/hooks/useKeyboardShortcuts.ts`
* `src/components/TerminalTabs.tsx`
* `src/components/CommandPalette.tsx`
* `src/components/settings/pages/ShortcutSettingsPage.tsx`
* `src/stores/settingsStore.ts`
* `package.json`
* Relevant specs: `.trellis/spec/frontend/state-management.md`, `.trellis/spec/frontend/component-guidelines.md`, `.trellis/spec/frontend/quality-guidelines.md`, `.trellis/spec/frontend/type-safety.md`
