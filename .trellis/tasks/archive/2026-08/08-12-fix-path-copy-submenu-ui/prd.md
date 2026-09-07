# fix-path-copy-submenu-ui

## Changelog Target

`[TEMP]`

## Goal

修正路径复制菜单交互：点击“复制路径为”后只展示二级选项，隐藏一级菜单；二级菜单沿用一级文件菜单的完整样式，并使用更能表达“复制 AI 路径”和“复制相对路径”的图标。

## What I already know

- 路径菜单封装在 `src/components/PathCopyMenu.tsx`，当前使用 Radix `ContextMenuSub`，一级菜单和二级菜单同时存在。
- `ContextMenuSubContent` 已通过 Portal 脱离文件侧栏的横向裁剪，但当前子菜单仍由 Radix 默认定位在一级菜单旁边。
- 一级菜单样式来自 `context-menu` / `file-explorer-menu`，二级内容也应直接复用同一套 class 和菜单项样式。
- 当前复制 AI 路径、复制相对路径都使用通用 `Copy` 图标，缺少语义区分。

## Root Cause

Radix `ContextMenuSub` 的默认交互是保留一级菜单并在旁侧打开二级菜单，这与需求中的“点击后只保留二级菜单”相反。仅通过 Portal 修复裁剪只能改变渲染位置，不能改变菜单状态模型。

## Discovery Checklist

- [x] 窗口焦点与键盘：切换到二级菜单后将焦点放到第一项，保留 Enter/Space 选择与 Escape 关闭能力。
- [x] 分屏/窄侧栏：二级菜单沿用文件菜单表面样式，并从原菜单布局中移除一级兄弟项，避免空白高度。
- [x] 本地、WSL、SSH、Worktree：不修改路径格式化器，继续由现有项目上下文生成绝对、AI 和相对路径。
- [x] 文件树、文件搜索、代码搜索、根目录和 Git 变更节点：均复用 `PathCopyMenu`。
- [x] 中英文：继续使用现有 i18n key，不新增硬编码文案。

## Requirements

- [x] 点击“复制路径为”后，一级菜单项从布局中移除，只保留二级复制选项菜单。
- [x] 二级菜单包含“复制 AI 路径”和“复制相对路径”，并保持与一级文件菜单相同的宽度、背景、边框、阴影、字号、间距和 hover 状态。
- [x] 为 AI 路径和相对路径分别使用语义更明确且现有图标系统内的图标；不新增图标依赖。
- [x] 文件树、搜索结果、根目录和 Git 变更面板的路径复制入口行为一致。
- [x] 中英文菜单文案、键盘操作和复制行为保持不变。

## Acceptance Criteria

- [x] 右键打开路径菜单后，一级菜单显示“复制路径为”。
- [x] 点击或键盘确认“复制路径为”后，一级菜单不再遮挡或保留，二级菜单独立显示复制 AI/相对路径选项。
- [x] 二级菜单在窄侧栏和普通 Git 面板中完整可见，样式与一级菜单一致。
- [x] AI 路径与相对路径菜单项的图标可区分，图标在中英文下均不会改变布局。
- [x] `npx tsc --noEmit` 通过。

## Definition of Done

- Typecheck passes.
- `CHANGELOG.md` and `docs/功能清单.md` updated under `[TEMP]`.
- Root cause and shared menu contract captured in frontend spec if needed.
- Existing unrelated working-tree changes remain untouched.

## Technical Approach

- Replace the Radix hover submenu with a controlled “menu mode” transition in `PathCopyMenu`: selecting the submenu trigger prevents the parent from closing, then swaps the component branch in place.
- Use a shared `context-menu file-explorer-menu` surface for the replacement and remove the old sibling items from layout while the replacement is active, so only the two format choices remain.
- Focus the first format item after the swap and use existing semantic `Sparkles` and `Link2` icons.

## Decision (ADR-lite)

**Context**: Radix nested submenus preserve the parent menu while opening beside it, but the requested interaction is a single replacement menu and visual parity with the primary file menu.

**Decision**: Use a controlled in-place replacement menu for the copy-format choices, preserving the existing path-copy helper and i18n keys.

**Consequences**: The replacement no longer depends on Radix nested-menu positioning or sidebar overflow behavior; the parent menu shell must hide old siblings and keyboard focus must be restored explicitly.

## Out of Scope

- No changes to absolute/relative/AI path values or clipboard behavior.
- No new icon package or custom SVG asset.
- No changes to unrelated context menus.

## Technical Notes

- Main component: `src/components/PathCopyMenu.tsx`
- Shared menu primitives: `src/components/ui/context-menu.tsx`
- Existing icons: `src/components/icons.tsx`
- Previous fix commit: `af5403f7 fix(files): fix path submenu clipping`
