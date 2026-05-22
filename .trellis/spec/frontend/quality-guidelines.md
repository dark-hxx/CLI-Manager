# Quality Guidelines

> Code quality standards for frontend development.

---

## Overview

Quality checks in this frontend are lightweight but real.
The current repository does not have separate npm scripts for linting or frontend tests. The explicit build gate today is:

- `npm run build` -> `tsc && vite build`

Quality also depends on manual verification for interaction-heavy UI:

- keyboard behavior
- focus handling
- resize/drag behavior
- tree interaction
- modal/dialog behavior
- theme regressions in light and dark palettes

Key references:

- `package.json` for the actual scripts
- `tsconfig.json` for compile-time strictness
- `src/App.tsx`, `src/components/sidebar/TreeNodeItem.tsx`, and `src/hooks/useFocusTrap.ts` for current accessibility patterns

---

## Forbidden Patterns

### Don't: Recreate standalone field styles in JSX

**Problem**:
```tsx
<input className="rounded-lg border border-border bg-surface-container-high px-2 py-1.5 text-xs outline-none" />
<select className="rounded-lg border border-border bg-surface-container-highest px-2 py-1 text-xs outline-none" />
```

**Why it's bad**: The project already centralizes standalone field chrome in `.ui-input` and shared form components. Recreating the same shape inline produces inconsistent radius, spacing, hover, and focus states.

**Instead**:
```tsx
<Input className="text-xs" />
<Select className="text-xs" />
<Textarea className="h-16 resize-none text-sm" />
```

### Don't: Claim automated coverage that does not exist

There is no established frontend unit/integration test suite in `package.json` today.
Do not document or rely on imaginary Jest/Vitest/Cypress coverage.

### Don't: Bypass shared shell classes for large visual rewrites

If a layout already depends on `ui-workspace-shell`, `ui-main-shell`, `ui-tree-*`, `ui-history-*`, or `ui-input`, extending those primitives is safer than sprinkling one-off replacements across many components.

---

## Required Patterns

- Before adding a new button style, search for an existing shared class in `src/App.css` and extend that pattern instead of creating a one-off variant in JSX.
- Keep action hierarchy obvious: one primary action per group, secondary actions visually lighter, destructive actions only when necessary.
- For light theme polish fixes, prefer removing noisy background treatments at the shell level over stacking more overrides on individual children.
- For standalone form fields, default to shared controls from `src/components/ui/` and treat `className` as layout/size overrides only.
- Before changing `.ui-input`, search all consumers and verify shell-based search fields, tree inline editors, and sliders still use the correct special-case styles.
- For sidebar tree refreshes, start by tuning the existing `ui-tree-*` styles in `src/App.css` and keep the current tree structure/interaction model unless the user asks for a deeper redesign.
- If a tree/list redesign adds extra wrappers, louder gradients, heavier shadows, or more chrome per row than the current tree needs, treat it as a regression candidate and simplify before merging.
- Run `npm run build` after frontend changes unless the task explicitly says not to.
- When touching interaction-heavy UI, manually verify keyboard and focus behavior in the changed screen.

---

## Current Quality Gates

### Compile/build gate

`package.json` currently exposes only these frontend-relevant scripts:

- `dev`
- `build`
- `preview`
- `tauri`

There is no separate `lint` or `test` npm script.
That means `npm run build` is the minimum explicit gate for frontend changes.

### Type gate

Type safety is enforced through `tsconfig.json` rather than a separate lint script:

- `strict: true`
- `noUnusedLocals: true`
- `noUnusedParameters: true`
- `noFallthroughCasesInSwitch: true`

### Accessibility/manual interaction gate

The repository already contains real accessibility work that should be rechecked after UI changes:

- `src/App.tsx` skip link
- `src/components/sidebar/TreeNodeItem.tsx` tree roles and ARIA state
- `src/hooks/useFocusTrap.ts` dialog focus trapping
- `src/App.css` global `:focus-visible`, `ui-focus-ring`, and reduced-motion handling

---

## Testing Requirements

### Current expectation

Because there is no formal frontend test suite yet, testing is a mix of:

1. `npm run build`
2. targeted manual verification on the changed UI

### Manual checks to run when relevant

| Change type | Minimum manual check |
|---|---|
| Form/control styling | verify shared inputs/selects/textareas still match surrounding UI |
| Dialog or modal changes | verify initial focus, Tab loop, Escape/close behavior |
| Sidebar tree changes | verify keyboard focus, selection state, expand/collapse, context menu, drag/resize if touched |
| History workspace changes | verify search focus, session opening, pagination, and message jump behavior |
| Theme/styling changes | compare light and dark themes, especially shell backgrounds and selected states |

### Real examples to use as baselines

- `src/components/settings/pages/SyncSettingsPage.tsx` for form-heavy UI
- `src/components/HistoryWorkspace.tsx` for effect-heavy interaction logic
- `src/components/sidebar/index.tsx` and `TreeNodeItem.tsx` for dense keyboard/mouse interaction

---

## Scenario: Tauri Window and Tray Exit Contract

### 1. Scope / Trigger

- Trigger: changes to Tauri close handlers, tray menu actions, or frontend session cleanup.
- This is a cross-layer contract because Rust tray events decide when the frontend must clear persisted sessions before the app exits.

### 2. Signatures

- Rust tray menu id: `tray_quit`
- Rust event emitted to main webview: `tray-quit-requested` with payload `()`
- Frontend listener: `listen("tray-quit-requested", async () => { ... })`
- Persisted setting: `closeBehavior: "ask" | "minimize" | "exit"`

### 3. Contracts

- `closeBehavior = "ask"`: prevent window close and show the confirmation dialog.
- `closeBehavior = "minimize"`: prevent window close and hide the window; do not clear sessions.
- `closeBehavior = "exit"`: allow shutdown path only after `useSessionStore.getState().clear()` completes.
- Tray quit must emit `tray-quit-requested` when the main window exists; the frontend owns session cleanup and final `destroy()`.
- Rust may call `app.exit(0)` only when there is no main window left to notify.

### 4. Validation & Error Matrix

| Condition | Expected behavior |
|---|---|
| User clicks window close with `ask` | `preventDefault()`, confirmation dialog opens |
| User clicks window close with `minimize` | `preventDefault()`, window hides, sessions remain restorable |
| User clicks window close with `exit` | sessions are cleared before exit continues |
| User clicks tray quit while window exists | Rust emits `tray-quit-requested`; frontend clears sessions then destroys window |
| Window hide/destroy fails | log warning; do not silently skip session cleanup |

### 5. Good/Base/Bad Cases

- Good: tray quit emits the event, frontend clears session persistence, then destroys the window.
- Base: close button minimize hides the window and keeps session persistence intact for restore.
- Bad: Rust calls `app.exit(0)` from tray quit while the webview still exists, bypassing frontend cleanup.

### 6. Tests Required

- Build gate: `npm run build` after frontend close-flow changes.
- Rust gate: `cargo check --manifest-path src-tauri/Cargo.toml` after tray or setup changes.
- Manual assertion: verify close-button `ask`, `minimize`, and `exit` modes.
- Manual assertion: verify tray `显示` restores/focuses the window and tray `退出` does not restore closed terminal sessions on next launch.

### 7. Wrong vs Correct

#### Wrong

```rust
"tray_quit" => app.exit(0)
```

#### Correct

```rust
"tray_quit" => {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.emit("tray-quit-requested", ());
    } else {
        app.exit(0);
    }
}
```

---

## Code Review Checklist

- Are standalone `input` / `select` / `textarea` fields using `Input`, `Select`, or `Textarea` instead of repeating border/background/focus classes inline?
- If a raw native control remains, is it a real exception (search shell, tree inline edit, or range slider) rather than drift?
- If `.ui-input` changed, were all affected form pages and modal editors rechecked for spacing and focus consistency?
- Did the change extend existing `ui-*` shell classes before inventing a parallel styling system?
- If keyboard or dialog behavior changed, was focus handling rechecked manually?
- If data loading changed, did `npm run build` still pass?
- Does the update match current repo reality, rather than assuming lint/test infrastructure that is not present yet?
