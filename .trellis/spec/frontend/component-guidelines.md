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

### Convention: Settings top search appears only for tabs with real filtering

**What**: In `SettingsModal`, set `searchPlaceholder` only for tabs whose page consumes `searchValue` to filter visible content. For tabs without filtering, omit `searchPlaceholder` and let `SettingsTopBar` render only the close button.

**Why**: A placeholder like "搜索通用设置（预留）" makes an unfinished feature look interactive. Optional `searchPlaceholder` keeps real search working for pages such as shortcuts/templates without showing dead controls on static settings pages.

**Example**:

```tsx
// Good: only pages with real filtering expose search
const SETTINGS_TAB_CONFIG = {
  shortcuts: { label: "快捷键", searchPlaceholder: "搜索快捷键" },
  hooks: { label: "Hook 设置" },
};

// Good: top bar treats search as optional
{searchPlaceholder && <Input value={searchValue} placeholder={searchPlaceholder} />}

// Bad: reserved search that does not filter anything
const hooks = { label: "Hook 设置", searchPlaceholder: "搜索 Hook 设置（预留）" };
```

**Tests**: After changing settings search behavior, run `npx tsc --noEmit` and manually verify searchable tabs still filter while static tabs do not show a search input.

### Convention: Terminal tab drag uses overlay plus explicit pane drop zones

**What**: Terminal tab drag interactions use dnd-kit `DragOverlay` for the cursor-following tab, while pane movement/splitting is driven by explicit drop ids:

```typescript
type TerminalPaneDropEdge = "left" | "right" | "top" | "bottom";
type PaneDropTarget =
  | { type: "center"; paneId: string }
  | { type: "edge"; paneId: string; edge: TerminalPaneDropEdge };
```

**Why**: sortable tab transforms are optimized for in-list reordering and can visually lock a tab to the tab bar. Pane-level drop zones make center move and edge split behavior testable without guessing from DOM position after drop.

**Correct**:

```tsx
<DndContext collisionDetection={terminalTabCollisionDetection}>
  <SplitTerminalView node={paneTree} renderLeaf={renderLeaf} />
  <DragOverlay dropAnimation={null}>{activeTabOverlay}</DragOverlay>
</DndContext>
```

**Wrong**:

```tsx
// Do not infer pane splits from tab bar reorder transforms only.
const horizontalTransform = transform ? { ...transform, y: 0 } : transform;
```

**Tests**: For terminal drag UI changes, run `npx tsc --noEmit` and manually verify same-pane reorder, pane-center move, and left/right/top/bottom edge split previews in the Tauri desktop app.

---

## Props Conventions

(To be filled by the team)

---

## Styling Patterns

### Convention: Settings pages use Mantine controls for the new visual shell

**What**: Inside the current settings shell, prefer Mantine `Card`, `Stack`, `Group`, `TextInput`, `Select`, `Switch`, `SegmentedControl`, `Button`, `Modal`, and `Badge` for standard settings controls. Keep custom Tailwind/CSS compositions only for specialized visual content such as terminal theme swatches, previews, path rows, and compact status summaries.

**Why**: Mixed custom shadcn-style controls and Mantine controls create inconsistent spacing, selected states, focus states, and modal behavior across settings pages. Using Mantine for the standard controls keeps the settings experience visually consistent without changing application state contracts.

**Example**:

```tsx
<Card className="ui-surface-card" p="md">
  <Stack gap="md">
    <Select
      label="默认 Shell"
      value={shellSelectValue}
      data={shellOptions}
      allowDeselect={false}
      onChange={(value) => {
        if (value) void update("defaultShell", value);
      }}
    />
    <Switch
      color="cliPrimary"
      checked={enabled}
      onChange={(event) => void update("someSetting", event.currentTarget.checked)}
    />
  </Stack>
</Card>
```

**Contracts**:

- Do not rename `SettingsTab` ids for a visual-only migration.
- Do not rename persisted settings store fields or alter storage schema.
- Do not change Tauri command names or payloads while only updating settings visuals.
- Keep page-level search behavior only on tabs that actually consume `searchValue`.

**Tests**: For settings visual migrations, run `npx tsc --noEmit` and `npm run build`; desktop runtime UI verification remains manual.

---

## Accessibility

(To be filled by the team)

---

## Common Mistakes

### Common Mistake: Setting only `borderColor` on Mantine selection cards

**Symptom**: A settings option card looks borderless even though it has Tailwind `border` or a shared class such as `ui-selection-card`.

**Cause**: Mantine component styles can reset the button/card border after app CSS is bundled, especially on `UnstyledButton`. Setting only `borderColor` does not restore border width/style when the shorthand `border` has been reset to `0`.

**Fix**: Put the full border contract in the shared class and make it specific enough to beat Mantine's base selector:

```css
.ui-selection-card,
.ui-selection-card.ui-selection-card {
  border: 1px solid color-mix(in srgb, var(--border) 82%, transparent);
}
```

Selected variants may keep overriding `border-color`, but the base rule must own width and style.

**Prevention**: When a Mantine-backed settings card appears borderless, inspect the computed `border-width` and `border-style` before changing colors.

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

### Common Mistake: Treating `cursorBlink` as full cursor visibility control

**Symptom**: A TUI such as Codex still shows rapid cursor flashing after `cursorBlink` is set to `false`.

**Cause**: `cursorBlink` only controls xterm's own blink animation. Terminal applications can still emit DECTCEM sequences (`CSI ?25h` show cursor, `CSI ?25l` hide cursor), and xterm honors those independently while processing PTY output.

**Wrong**:

```tsx
const terminal = new Terminal({
  cursorBlink: false,
});
// Assumes this also suppresses application-driven show/hide cursor churn.
```

**Correct**:

```tsx
if (sequence === "\x1b[?25l") {
  cancelPendingCursorShow();
  writeNow(sequence);
} else if (sequence === "\x1b[?25h") {
  scheduleCursorShow();
}
```

**Prevention**: For high-frequency TUI redraw issues, inspect application-emitted ANSI cursor visibility sequences before changing xterm appearance options. Pass hide through immediately, debounce show, and keep output processing in the PTY write path instead of adding CLI-specific UI state.

### Common Mistake: Letting xterm helper textarea follow non-IME redraw cursors

**Symptom**: During TUI redraws, including but not limited to Claude Code `/compact`, the hidden input proxy appears to make the terminal input anchor jump with a non-input cursor, often the tail/status line.

**Cause**: xterm syncs `.xterm-helper-textarea` to the terminal cursor on cursor moves. This is required for IME composition, but outside composition it can create browser scroll/anchor churn during progress-bar redraws.

**Fix**: In `XTermTerminal`, keep the helper textarea pinned to xterm's offscreen default while not composing, but keep it at least `1x1`; xterm's IME fallback for active-IME punctuation reads textarea diffs after keyCode 229, and some IMEs drop the first character when the helper textarea is `0x0`. During IME composition, anchor `.composition-view` and `.xterm-helper-textarea` to xterm's current `buffer.active.cursorX/cursorY` when that cursor is on an input prompt. If a TUI redraw moves the cursor to a status/progress row during composition, fall back to the nearest visible prompt row instead of blindly trusting that redraw cursor. Prompt recognition must include Codex's `›` prompt in addition to common shell prompts such as `>`, `$`, `#`, and `PS>`. Do not scan only the bottom rows or force a bottom-row fallback: real input can sit above the bottom while the IME candidate window still needs to follow the visible input row. Reapply the frozen composition anchor after xterm render events, because xterm's own `CompositionHelper.updateCompositionElements()` can rewrite `.composition-view` and helper textarea positions from the live buffer cursor. After `compositionend`, pin the helper textarea offscreen again.

**Correct**:

```tsx
if (!isComposingRef.current) {
  textarea.style.left = "-9999em";
  textarea.style.top = "0px";
  textarea.style.width = "1px";
  textarea.style.height = "1px";
  textarea.style.lineHeight = "1px";
}
```

**Wrong**:

```tsx
// Do not hide, remove, or disable the helper textarea.
textarea.style.display = "none";
```

**Tests / manual checks**:

- [ ] TUI redraws, with or without Claude Code `/compact`, do not make the input anchor jump.
- [ ] Chinese/IME composition text and the candidate window stay near the visible input cursor, including when the input row is not at the bottom.
- [ ] If a TUI status/progress redraw owns the current cursor during composition, the candidate window falls back to the nearest visible prompt row.
- [ ] Normal keyboard input, Enter, and paste still reach the PTY.
- [ ] Chinese/IME composition still positions the candidate window correctly.

### Gotcha: xterm `write` is asynchronous for buffer cursor reads

**Symptom**: IME fallback cursor sampling still occasionally anchors to a Claude/Codex status or animation row even though sampling waits for a short quiet period after output.

**Cause**: `terminal.write(data)` queues parser work; `terminal.buffer.active.cursorX/cursorY` is not guaranteed to reflect that write until the optional write callback fires. Starting a quiet-cursor sample before the callback can still sample the pre-write or mid-redraw cursor.

**Fix**: Any cursor-dependent logic that is caused by PTY output must be scheduled from the `terminal.write(..., callback)` callback. Guard stale callbacks if the terminal instance can be disposed.

```tsx
const writeTerminalChunk = (chunk: string) => {
  terminal.write(chunk, () => {
    if (terminalRef.current !== terminal) return;
    noteTerminalWriteActivity();
  });
};
```

**Prevention**: When reading `terminal.buffer.active` after output writes, first check xterm's `write` callback contract. Do not use timers started before `terminal.write()` as evidence that the buffer cursor has already parked at the input caret.

### Convention: xterm Windows PTY and paste handling

**What**: Internal xterm instances backed by the app's Windows PTY must use xterm's Windows compatibility and native paste path.

**Why**: ConPTY resize/reflow can make PowerShell output appear to vanish after fit/tab changes. Custom paste handlers that write directly to `pty_write` bypass xterm's CR normalization and bracketed paste markers, so TUIs such as Claude Code may treat multi-line paste as typed Enter events.

**Correct**:

```tsx
const terminal = new Terminal({
  scrollOnEraseInDisplay: true,
  windowsPty: { backend: "conpty" },
});

const pasteIntoTerminal = (text: string) => {
  terminal.paste(text);
};

terminal.onData((data) => {
  invoke("pty_write", { sessionId, data });
  // If command history needs pasted text, strip complete bracketed-paste
  // wrappers only for history; never rewrite data before sending it to PTY.
});
```

**Wrong**:

```tsx
const data = text.replace(/\r\n?/g, "\n");
invoke("pty_write", { sessionId, data });
```

**Tests / manual checks**:

- [ ] Windows 10 + PowerShell retains scrollback after tab switch / resize / fit.
- [ ] Claude Code multi-line paste preserves line order and is not submitted line-by-line.
- [ ] CMD still accepts normal paste and Enter behavior.

