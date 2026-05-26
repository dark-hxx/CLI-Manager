# Component Guidelines

> How components are built in this project.

---

## Overview

(To be filled by the team)

---

## Component Structure

### Convention: Keep settings tab ids stable when only renaming UI labels

**What**: In `SettingsModal`, `SettingsTab` ids are part of the internal navigation contract. When a change only renames or reorganizes a settings page, keep the existing tab id and update only the visible label/title/description.

**Why**: Settings tabs are passed through props such as `onOpenSettings(tab?: SettingsTab)`. Renaming an id like `"terminal-theme"` to `"terminal-settings"` creates unnecessary type and call-site churn without changing persisted settings or runtime behavior.

**Example**:

```tsx
// Good: stable id, renamed UI copy only
const SETTINGS_TAB_CONFIG = {
  "terminal-theme": {
    label: "终端设置",
    title: "终端设置",
  },
};

// Bad: id churn for a display-only rename
type SettingsTab = "general" | "terminal-settings" | "shortcuts";
```

**Tests**: After changing settings page labels or layout, assert that existing callers can still open the page through the old `SettingsTab` literal and run `npx tsc --noEmit`.

---

## Props Conventions

(To be filled by the team)

---

## Styling Patterns

(To be filled by the team)

---

## Accessibility

(To be filled by the team)

---

## Common Mistakes

### Gotcha: xterm.js `allowTransparency` is a construction-time option

**Symptom**: After toggling a "transparent background" feature on a live `Terminal` instance, the background stays opaque even though `theme.background` was updated to `rgba(...)`.

**Cause**: Per `node_modules/@xterm/xterm/typings/xterm.d.ts`:

> `allowTransparency` must be set before executing the `Terminal.open()` method and can't be changed later without executing it again.

If you write `terminal.options.allowTransparency = true` at runtime, the option silently does nothing.

**Wrong**:

```tsx
const terminal = new Terminal({ /* ...no allowTransparency... */ });
// Later, when user enables background image:
terminal.options.allowTransparency = true;        // ❌ no-op
terminal.options.theme = { background: "rgba(0,0,0,0)" };  // ❌ still opaque rendering
```

**Correct**:

```tsx
const terminal = new Terminal({
  // ...
  allowTransparency: true,   // ✅ set once, unconditionally
  theme: getInitialTheme(),
});
// Later, swap only theme.background between opaque HEX and rgba:
terminal.options.theme = isTransparent ? applyTransparency(theme) : theme;
```

**Why "always on" instead of "rebuild the Terminal on toggle"**: Rebuilding loses scrollback, breaks the PTY data stream wiring, and incurs ~50 ms of GPU/font setup. xterm's WebglAddon is alpha-capable (`alpha: true` is the default WebGL context flag), so the cost of `allowTransparency: true` is a small constant per-frame — research measured ~5-10% FPS in pathological cases, imperceptible in normal terminal use.

**Reference**: `src/components/XTermTerminal.tsx` — sets `allowTransparency: true` unconditionally; the hot-update `useEffect` only swaps `terminal.options.theme` via `applyTransparency` helper in `src/lib/terminalThemes.ts`.

**Prevention checklist when wiring a new xterm appearance feature**:

- [ ] Does the feature need a non-opaque background, an alternate cursor blink, or any other "must-set-at-construction" xterm option?
- [ ] If yes, set it unconditionally at `new Terminal(...)` — do NOT gate it on the feature toggle.
- [ ] Read the JSDoc on every option you set; xterm marks construction-time options explicitly.
- [ ] When in doubt, grep `typings/xterm.d.ts` for "can't be changed later" / "must be set before".

### Common Mistake: Recreating the Terminal on settings change

**Symptom**: Toggling a terminal-related setting (font family change, background enable) causes the terminal to flash blank, lose scrollback, and re-prompt.

**Cause**: The construction `useEffect` lists a settings field in its dependency array, so changing that field disposes and recreates the Terminal.

**Fix**: Keep the construction effect's deps as `[sessionId]`. Add a separate hot-update effect that mutates `terminal.options.*` for the changed setting. xterm supports hot-mutating `fontSize`, `fontFamily`, `theme`, `cursorBlink`, `cursorStyle`, `scrollback` without rebuild. Only `allowTransparency`, `cols`/`rows` (use Fit instead), and `rendererType` (legacy) require rebuild.
