# Component Guidelines

> How components are built in this project.

---

## Overview

The frontend uses React function components with TypeScript props.
Component design is mostly pragmatic:

- Parent shells hold state and side effects
- Child components receive explicit props and callbacks
- Shared visual primitives stay small and live in `src/components/ui/`
- Styling is a mix of Tailwind utility classes and centralized `ui-*` classes from `src/App.css`

This codebase does not use class components, render props, or heavy component abstraction layers.

---

## Component Structure

A typical component file follows this order:

1. Imports
2. Local `Props` interface and small helper interfaces/types
3. `export function ComponentName(...)`
4. Derived values and event handlers near the top of the component body
5. JSX return

### Observed patterns

- `src/components/history/HistoryListPane.tsx` defines a local `HistoryListPaneProps` interface and keeps the component presentational.
- `src/components/settings/SettingsTopBar.tsx` defines a focused `SettingsTopBarProps` interface and delegates all state changes through callbacks.
- `src/components/sidebar/TreeNodeItem.tsx` keeps helper components (`InlineRename`) and helper functions (`countDescendants`) in the same file when they are tightly coupled to that component.

### Composition pattern

Large shells compose smaller pieces instead of growing one file forever:

- `src/App.tsx` composes the app shell
- `src/components/HistoryWorkspace.tsx` composes history list, session detail, prompt library, and diff modal
- `src/components/sidebar/index.tsx` composes header, search, tree, and footer

---

## Props Conventions

### Define local props explicitly

Use a local interface per component file unless the type is truly shared.

Examples:

- `HistoryListPaneProps` in `src/components/history/HistoryListPane.tsx`
- `SettingsTopBarProps` in `src/components/settings/SettingsTopBar.tsx`
- `TreeNodeItemProps` in `src/components/sidebar/TreeNodeItem.tsx`

### Use callback props for upward actions

State flows down, actions flow up:

- `HistoryListPane` receives `onOpenSession`, `onRefresh`, `onGlobalQueryChange`, `onStartResize`
- `SettingsTopBar` receives `onSearchChange` and `onClose`
- `StatsPanel` is opened and closed by its parent in `src/App.tsx`

Prefer `onX` names for event-like props and keep callback responsibility obvious.

### Keep prop surfaces narrow

Do not pass entire stores or giant context objects into presentational children unless there is already an established context boundary.
The current code usually passes only the values and handlers a child needs.

### Type refs and DOM props directly

When a child works with DOM refs, use explicit React types:

- `RefObject<HTMLElement | null>` in `HistoryListPane.tsx`
- `ButtonHTMLAttributes`, `InputHTMLAttributes`, `SelectHTMLAttributes`, `TextareaHTMLAttributes` in `src/components/ui/*`

---

## Styling Patterns

- Reuse shared visual primitives in `src/App.css` before introducing one-off class combinations.
- Toolbar-style actions should use `ui-flat-action` as the base and layer semantic variants on top:
  - `ui-toolbar-button` for standard top-bar / panel trigger buttons
  - `ui-toolbar-button-compact` for denser sidebar action rows
  - `ui-primary-action` only for the primary action in the group
- When a search area has related actions, place those actions above the search field if horizontal space is tight. Keep them on one lightweight row before falling back to larger button treatments.
- In light theme, page-level shells should stay on solid surface colors. Avoid decorative gradients or radial textures on `ui-workspace-shell` / `ui-main-shell`.
- For sidebar tree rows, prefer extending the existing `ui-tree-*` patterns in `src/App.css` instead of replacing the tree with a new component style system.
- Tree hierarchy should come from indentation, compact spacing, and restrained selected states. Avoid adding extra shells, loud gradients, or heavy shadow stacks per row.

### Convention: Shared Form Controls

**What**: Standalone form fields must reuse the shared controls in `src/components/ui/input.tsx`, `src/components/ui/select.tsx`, and `src/components/ui/textarea.tsx`.

**Why**: Input border, radius, background layer, and focus ring are now centralized by `.ui-input` in `src/App.css`. Repeating those classes inline caused visual drift between settings pages, modal forms, and template editors.

**Use this for**:
- Standard text / number / password / url inputs
- Standalone selects in forms and filter bars
- Standalone multi-line text areas

**Example**:
```tsx
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

<Input value={name} onChange={(e) => setName(e.target.value)} className="text-sm" />
<Select value={scope} onChange={(e) => setScope(e.target.value)} className="text-xs" />
<Textarea value={payload} onChange={(e) => setPayload(e.target.value)} className="h-16 resize-none text-sm" />
```

### Exceptions: Shell-Based Search and Inline Tree Editing

Keep raw native controls when the surrounding container owns the visual shell:
- Search shells such as `ui-sidebar-search-shell` and `ui-history-search-shell`
- Inline rename/edit fields that rely on `ui-tree-inline-input`
- Native `input[type="range"]` sliders

**Why**: These controls are not plain standalone fields. Their border, padding, and focus treatment come from the outer shell or a dedicated special-case class.

### More observed styling examples

- `src/components/history/HistoryListPane.tsx` uses a raw `<input>` inside `ui-history-search-shell`, which is an allowed exception.
- `src/components/sidebar/TreeNodeItem.tsx` uses `ui-tree-inline-input` for inline rename instead of the shared `Input` component.
- `src/components/ui/button.tsx`, `input.tsx`, `select.tsx`, and `textarea.tsx` wrap shared `ui-*` primitives instead of rebuilding them everywhere.

---

## Accessibility

Accessibility work is manual but visible in the current codebase. Preserve these patterns when changing components.

### Current patterns to follow

- `src/App.tsx` includes a skip link to `#main-content`.
- `src/components/sidebar/TreeNodeItem.tsx` uses `role="treeitem"`, `aria-level`, `aria-expanded`, and `aria-selected` for the project tree.
- `src/hooks/useFocusTrap.ts` traps focus for active dialog-style containers.
- `src/components/history/HistoryListPane.tsx` adds `aria-label` to icon-only and compact controls.

### Practical rules

- If a control has no visible text, add `aria-label`.
- If you build keyboard-navigable tree or dialog UI, preserve the existing ARIA roles and focus behavior.
- Prefer real `button`, `input`, `select`, and `textarea` elements over clickable `div`s.
- Keep focus styles compatible with `ui-focus-ring` and the global `:focus-visible` rules in `src/App.css`.

---

## Common Mistakes

### Common Mistake: Rebuilding form-field chrome inline

**Symptom**: One page uses `bg-surface-container-high`, another uses `bg-surface-container-highest`, and focus borders behave differently.

**Cause**: Raw `input` / `select` / `textarea` elements were styled ad hoc in JSX instead of reusing shared controls.

**Fix**: Replace the standalone field with `Input`, `Select`, or `Textarea`, then keep only size/layout overrides in `className`.

**Prevention**: If you are about to type `rounded`, `border`, `bg-surface-*`, or `outline-none` on a standalone form field, stop and check whether the shared control already covers it.

### Common Mistake: Moving parent-owned state into every child

**Symptom**: A child starts owning selected item state, modal state, and fetch triggers that its parent also needs.

**Cause**: Presentational children were turned into mini-containers.

**Fix**: Keep orchestration in shells like `App.tsx`, `HistoryWorkspace.tsx`, and `sidebar/index.tsx`; pass the child only the values and callbacks it needs.

### Common Mistake: Replacing shell-owned inputs with the shared control blindly

**Symptom**: Search shells or tree inline edit fields lose spacing, focus treatment, or layout after being swapped to `Input`.

**Cause**: The exception cases were treated as standard standalone fields.

**Fix**: Preserve raw native controls when the outer shell already provides the visual frame.
