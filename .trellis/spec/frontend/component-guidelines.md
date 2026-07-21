# Component Guidelines

## Convention: Terminal output uses PtyHost binary frames and xterm parse ACK

**What**: `XTermTerminal` receives PTY data only through `TerminalProcessManager` / `PtyHostSocket`. Hidden terminals remain attached and parse output. ACK is sent from the `terminal.write` callback, never when the WebSocket message arrives.

**Why**: This keeps process transport out of components, prevents hidden-tab replay corruption, and makes daemon backpressure represent xterm parser progress instead of network delivery.

**Contracts**:

- Output/replay frames carry `sessionId`, `sequence`, `cols`, `rows`, and raw bytes.
- Initial and reconnect Replay apply recorded dimensions before each frame while PTY resize forwarding is suspended. The final Replay frame is an explicit client-side batch boundary; force-fit the current container before releasing queued live output or resuming normal resize forwarding.
- `TerminalProcessManager` owns every received frame until xterm's write callback commits it. Component cleanup must only detach the consumer; it must not discard or persist-and-duplicate uncommitted frames.
- Live frames may be combined for one xterm write, but completion commits and ACKs the constituent frames in sequence order using each frame's raw UTF-16 length.
- A remounted Display receives all uncommitted frames again. Commit callbacks from an older attachment generation are ignored.
- Closing the last attached session cancels any scheduled reconnect; a delayed reconnect callback must return without opening a socket when no non-tombstoned sessions remain.
- No component or store may call `listen("pty-output-...")` or invoke `pty_write/pty_resize/pty_close` directly.
- Large-buffer horizontal resize uses a leading + trailing latest-wins cadence capped at 34ms; vertical resize remains immediate. Consecutive `ResizeObserver` frames replace only the pending fit RAF and must not cancel that horizontal cadence. macOS/Linux enable xterm cursor-line reflow so a rapid shrink does not expose the old-width cursor row while waiting for the PTY application's `SIGWINCH` redraw; Windows keeps the existing ConPTY compatibility policy. Shrink and grow must both expose xterm's live resize as soon as its queued render is ready. Immediately before each visible horizontal shrink, keep a pixel copy of the last stable `.xterm-screen` above the hidden live screen, but display that copy at its original CSS size inside an overflow-clipped viewport; never stretch the bitmap or hold it for the whole drag. Reveal the live renderer after two animation frames, and restart only this two-frame guard if another `Terminal.resize()` arrives first. `ResizeObserver` events that occur while waiting for the next throttled terminal resize may update the clip bounds but must not delay the reveal. WebGL must preserve its drawing buffer for this copy, and the barrier must validate that a captured frame contains visible pixels before hiding the live screen; a failed/empty capture leaves the live renderer visible. Capture geometry and visibility belong to `.xterm-screen`; root-level canvas lookup is only a compatibility fallback and must exclude the overview ruler. This barrier starts immediately before `Terminal.resize()`, never during the throttle wait, so it hides only xterm/WebGL's corrupt intermediate reflow frame without freezing the whole drag. Before a normal-buffer column change, if the user is above the live bottom, register a temporary marker at `viewportY`; after `Terminal.resize()` wait two animation frames for xterm's queued render and DOM viewport synchronization, then scroll to the marker's updated line and dispose it. A synchronous `scrollToLine()` is forbidden because the old DOM scroll height clamps the target before xterm's queued viewport sync. Cancel and dispose a pending marker on a newer resize or terminal detach. Do not force bottom-following or alternate-buffer terminals. Visibility restore fits immediately and forces a full refresh only when natural rendering does not complete within two frames or the renderer was rebuilt.
- Split-pane leaf and divider bounds must align to the current display's physical pixel grid using the split root's global origin and `window.devicePixelRatio`. Arbitrary persisted/drag-preview ratios, fractional container bounds, nested splits, and fullscreen leaves must not place an xterm canvas at a fractional device-pixel origin. Snap divider start/end boundaries and derive the second pane from the remaining aligned space so the layout has no gap or overlap. Refresh the grid metrics on container resize and window changes, and use a resolution media query that rebinds itself whenever DPR changes so moving an unchanged-size window among 1080p, 2K fractional-scaling (including DPR 1.25/1.5), and Retina displays cannot retain the previous screen's pixel grid.

**Wrong**:

```tsx
listen(`pty-output-${sessionId}`, ({ payload }) => terminal.write(atob(payload)));
```

**Correct**:

```tsx
terminalProcessManager.subscribeOutput(sessionId, (delivery) => {
  terminal.write(decode(delivery.frame.data), () => {
    delivery.commit(rawLength);
  });
});
```

**Tests**: Run `npx tsc --noEmit` and `node --test scripts/ptyHostSocket.test.mjs scripts/terminalProcessManager.test.mjs scripts/terminalReplay.test.mjs scripts/terminalResizeDebouncer.test.mjs scripts/terminalResizeRenderBarrier.test.mjs scripts/terminalSplitLayout.test.mjs scripts/terminalReflowPolicy.test.mjs`; manually verify background output, reconnect replay, rapid split/fullscreen shrink, equal text sharpness across adjacent panes, transparent terminal backgrounds, IME, WebGL fallback, and no duplicate output after daemon reconnect.

### Convention: OSC color-query normalization has no frontend PTY side effects

**What**: Rust PTY owns live OSC 10/11 replies. Frontend normalization only removes residual queries from live, replay, and restored display text; it must not import the process manager or write a reply.

**Why**: A WebView → daemon → PTY round trip can exceed a CLI's short terminal-probe window. The late response is then parsed as user input. Replay is historical output and must also remain side-effect free.

**Correct**:

```ts
const text = normalizeTerminalOutput(rawText);
```

**Wrong**:

```ts
terminalProcessManager.write(sessionId, colorReply);
```

**Contracts**: See [Terminal OSC Color Contracts](../backend/terminal-osc-color-contracts.md) for protocol, validation, local/WSL/SSH behavior, and required tests.

**Tests**: Run `node --test scripts/terminalOsc.test.mjs`; assert both live and replay queries are filtered and `useTerminalOsc.ts` contains no `terminalProcessManager.write` or `replyToColorQueries` path.

> How components are built in this project.

---

## Overview

(To be filled by the team)

---

## Component Structure

### Convention: User-facing app shell text goes through `useI18n`

**What**: New or changed user-facing labels, button text, menu text, aria labels, tooltips, settings titles, empty states, toast messages, OS notifications, stats/history text, and hook-notification script text must use `src/lib/i18n.ts` through `useI18n()` or `translateCurrent()` instead of hard-coded Chinese/English strings. Persisted language preference lives in `settingsStore.language` as `"auto" | "zh-CN" | "zh-TW" | "en-US"`.

**Why**: Language switching must be consistent across visible shell UI. Keeping translation keys in one local module avoids adding a heavyweight i18n dependency while the app supports Simplified Chinese, Traditional Chinese, and English.

**Correct**:

```tsx
import { useI18n } from "../lib/i18n";

const { t } = useI18n();

<button aria-label={t("sidebar.openSettings")}>{t("sidebar.settings")}</button>
```

**Wrong**:

```tsx
<button aria-label="打开设置">设置</button>
```

**Contracts**:

- Use `language: "auto"` as the default; resolve it from WebView/browser locale.
- Set document language from the resolved language in `App`.
- Add both `zh-CN` and `en-US` entries for every new translation key; `zh-TW` is generated from `zh-CN` unless a task explicitly needs a Traditional Chinese override.
- Treat i18n as part of every frontend requirement, not as a later cleanup. If a task adds UI, tooltip, notification, history, stats, settings, or hook-facing copy, the task is incomplete until all supported languages work, including `zh-TW`.
- For non-React event paths, background callbacks, and hook notification handlers, use `translateCurrent()` so messages still follow the persisted language outside render scope.
- When inline code needs to choose between Chinese and English copy, route it through `pickByLanguage()` so `zh-TW` resolves to converted Traditional Chinese instead of falling back to Simplified Chinese or English.
- Keep clock-only times in 24-hour format by passing `hour12: false` when formatting with `toLocaleTimeString`; switching to English must not turn `15:31` into `03:31`.
- Do not introduce a third-party i18n library without an explicit dependency-change decision.

**Tests**: Run `npx tsc --noEmit` and `npm run build`; manually verify Settings > General language switching changes the touched UI and persists after restart across `zh-CN`, `zh-TW`, and `en-US`. Smoke-test hover cards/tooltips, right-side action buttons, session history, stats panels, toast/system notifications, and hook notifications when those areas are touched.

### Convention: Text input and confirmation prompts use themed application dialogs

**What**: User-facing flows that request text input or confirmation must use themed application dialogs such as `useAppPrompt` and `useAppConfirm`. Do not call `window.prompt` or `window.confirm` anywhere in frontend code.

**Why**: WebView prompt styling and behavior vary by platform, do not follow the application theme, and create an inconsistent desktop experience.

**Correct**:

```tsx
const { prompt, promptDialog } = useAppPrompt();
const name = await prompt({ title: t("settings.statuslineProfiles.createPrompt") });

const { confirm, confirmDialog } = useAppConfirm();
const confirmed = await confirm({ title: t("sidebar.toast.unsavedFileConfirm"), danger: true });

return <>{promptDialog}{confirmDialog}</>;
```

**Wrong**:

```tsx
const name = window.prompt("Enter a name");
const confirmed = window.confirm("Discard changes?");
```

**Contracts**:

- Dialog text must use the existing i18n system.
- Cancel resolves without performing the operation.
- Name-like values are trimmed and empty values cannot be submitted by default. Use an explicit `allowEmpty` option only when blank input has a defined action such as clearing an optional custom name.
- Confirmation dialogs resolve to `true` only after explicit confirmation; cancel, Escape, close, replacement, or component unmount resolve to `false`.
- Sequential workflows such as import conflict resolution must stop without committing when the user cancels.

**Tests**: Run `rg "window\\.(prompt|confirm)" src` and expect no matches; run `npx tsc --noEmit`; manually verify submit, confirm, Enter, Escape, cancel, default values, empty input, danger styling, and both supported languages.

### Convention: Persisted font family values must be CSS-serialized before applying

**What**: Any UI or terminal font family value loaded from settings or system font discovery must be normalized through `normalizeFontFamilyStack` or `normalizeTerminalFontFamily` before it is written into inline styles, CSS variables, generated `<style>` text, Mantine theme config, or xterm options.

**Why**: System font names can contain spaces, commas, CJK characters, punctuation, or other characters that need CSS string serialization. If a raw persisted value or raw system-font option is injected directly, CSS can parse it differently from the intended family and some settings surfaces can keep rendering with the fallback font. For terminal fonts, generic fallbacks such as `monospace` must stay after the selected concrete family; otherwise xterm resolves the generic font first and the user's selected system/custom terminal font never appears.

**Option matching contract**: Normalize the persisted current value, built-in options, and system options with the same context-specific normalizer. Terminal selectors pass `normalizeTerminalFontFamily` to `mergeFontFamilyOptions`; UI selectors keep the default `normalizeFontFamilyStack`. Serialize a discovered system font as one CSS family before appending fallbacks so a comma inside the family name is not treated as a stack separator.

**Correct**:

```tsx
const effectiveUiFontFamily = normalizeFontFamilyStack(uiFontFamily);

document.documentElement.style.setProperty("--font-ui-sans", effectiveUiFontFamily);
styleEl.textContent = `button { font-family: ${effectiveUiFontFamily} !important; }`;

const effectiveTerminalFontFamily = normalizeTerminalFontFamily(fontFamily);
terminal.options.fontFamily = effectiveTerminalFontFamily;
```

**Wrong**:

```tsx
document.documentElement.style.setProperty("--font-ui-sans", uiFontFamily);
styleEl.textContent = `button { font-family: ${uiFontFamily} !important; }`;
terminal.options.fontFamily = fontFamily;
```

**Tests**: Run `npx tsc --noEmit`; manually select installed system/custom fonts with different name shapes, such as a space-containing font, a CJK-named font, a comma-containing font, and a punctuation-containing font when available. In Settings > General and Settings > Terminal, verify the settings navigation/content and a newly focused terminal use the selected font, and the terminal select does not show the current-custom fallback label for available system fonts.

### Convention: Auxiliary panels do not hijack primary sidebar navigation

**What**: Terminal-side auxiliary panels, such as realtime stats, Git changes, and project files, must not force the primary left sidebar into a different navigation mode. If an auxiliary panel needs to load shared data, keep the left sidebar display mode behind explicit local UI state or a dedicated left-sidebar action.

**Why**: The left sidebar is the user's project navigation anchor. Opening a right-side Files panel may need file explorer data, but it should not replace the project tree or remove the user's path back to projects.

**Correct**:

```tsx
const [showFileExplorer, setShowFileExplorer] = useState(false);

// Left sidebar project context menu explicitly enters file mode.
const handleOpenProjectFiles = async (project: Project) => {
  await openFileProject(project);
  setShowFileExplorer(true);
};

{showFileExplorer && fileProject ? (
  <FileExplorerSidebar onBackToProjects={() => setShowFileExplorer(false)} />
) : (
  <ProjectTree />
)}
```

**Wrong**:

```tsx
// Any feature that writes fileProject would unexpectedly replace the project tree.
{fileProject ? <FileExplorerSidebar /> : <ProjectTree />}
```

**Tests**: Run `npx tsc --noEmit`; manually verify opening the right Files panel leaves the left project tree visible, while the left context-menu Browse Files action still opens a file tree with a working return button.

### Convention: Optional-container Radix dialogs pick positioning by portal target

**What**: A Radix `Dialog.Portal` that accepts an optional `container` must use container-relative `absolute inset-0` positioning only when a container is supplied. When the portal falls back to `document.body`, the overlay and content must use viewport-relative `fixed inset-0`.

**Why**: `absolute inset-0` is correct inside a known `relative` panel such as the history detail pane. With the default body portal, the same classes can render only the overlay or place content in the wrong positioning context, which looks like a black screen.

**Correct**:

```tsx
const portalContainer = container ?? undefined;
const positionClass = container ? "absolute inset-0" : "fixed inset-0";

<DialogPrimitive.Portal container={portalContainer}>
  <DialogPrimitive.Overlay className={cn(positionClass, "bg-black/45")} />
  <DialogPrimitive.Content className={cn(positionClass, "flex items-center justify-center")} />
</DialogPrimitive.Portal>
```

**Wrong**:

```tsx
<DialogPrimitive.Portal container={container ?? undefined}>
  <DialogPrimitive.Overlay className="absolute inset-0 bg-black/45" />
  <DialogPrimitive.Content className="absolute inset-0" />
</DialogPrimitive.Portal>
```

**Tests**: Run `npx tsc --noEmit` and `npm run build`; manually verify both a container-scoped caller and a default body-portal caller can open and close the dialog with visible content.

### Convention: Hook-dependent fallback props use stable module constants

**What**: If an optional array or object prop is used in a hook dependency list, do not default it to an inline literal in the function parameter list. Use a module-level constant instead.

**Why**: Defaults such as `items = []` create a fresh array on every render. If an effect depends on that prop and calls `setState`, callers that omit the prop can trigger repeated effects and React's "Maximum update depth exceeded" error.

**Correct**:

```tsx
const EMPTY_ITEMS: Item[] = [];

function Panel({ items = EMPTY_ITEMS }: { items?: Item[] }) {
  useEffect(() => {
    setRows(buildRows(items));
  }, [items]);
}
```

**Wrong**:

```tsx
function Panel({ items = [] }: { items?: Item[] }) {
  useEffect(() => {
    setRows(buildRows(items));
  }, [items]);
}
```

**Tests**: Run `npx tsc --noEmit`; manually verify a caller that omits the optional prop can open, close, and rerender the component without a React maximum-depth error.

### Convention: Markdown rendering goes through the shared MarkdownContent component

**What**: Any UI that renders user/session/release Markdown must use `src/components/ui/MarkdownContent.tsx`. Do not import `react-markdown` directly from feature components.

**Why**: Markdown content comes from history files, prompts, update notes, and tool transcripts. Keeping rendering in one component preserves the same GFM support, `skipHtml` safety policy, link behavior, image placeholder behavior, code highlighting, search highlighting, and GitHub-style visual treatment everywhere.

**Correct**:

```tsx
import { MarkdownContent } from "../ui/MarkdownContent";

<MarkdownContent content={message.content} query={sessionQuery} />
<MarkdownContent content={releaseNotes} linkBehavior="open" />
```

**Wrong**:

```tsx
import ReactMarkdown from "react-markdown";

<ReactMarkdown>{releaseNotes}</ReactMarkdown>
```

**Contracts**:

- Keep `skipHtml` enabled for untrusted Markdown.
- Default links to preview-only behavior unless the surrounding flow explicitly allows opening external URLs.
- Keep remote images as placeholders by default; do not load remote images from history/session content without a separate reviewed allowlist or setting.
- Terminal-specific Markdown theming must stay opt-in. If one caller needs a light/dark-aware code theme or palette override, add an explicit prop or caller-owned class instead of changing the shared `variant="terminal"` default for every consumer.
- Scope terminal-variant CSS overrides to the caller container (for example a transcript shell or file-preview wrapper). Do not widen `.ui-markdown-terminal` defaults just to fix one surface.
- When changing Markdown styles, update `src/components/ui/markdownSample.ts` so the manual preview covers the new element or edge case.

**Tests**: Run `npx tsc --noEmit` and `npm run build`; manually inspect the Markdown style preview in Settings > About in both default and terminal variants. If the change targets a terminal-only caller such as a transcript or file preview, also verify that scoped caller still matches the active terminal theme while the other `variant="terminal"` callers keep their prior appearance.

### Convention: Hidden terminal WebGL cleanup releases renderer only

**What**: In `XTermTerminal`, low-memory cleanup and Linux constrained-graphics cleanup for hidden terminals may dispose only the `WebglAddon` after the configured hidden delay. It must not dispose the xterm `Terminal`, PTY listener, fit/search addons, scrollback buffer, active write queue, or input state.

**Why**: The goal is to release WebView2 GPU resources while preserving the live terminal session. Disposing the terminal component itself would force replay/recreation, risk lost output/input, and can make tab switching feel like a terminal reload.

**Correct**:

```tsx
if (!isVisible && lowMemoryMode) {
  webglDisposeTimerRef.current = window.setTimeout(() => {
    if (isVisibleRef.current) return;
    webglAddonRef.current?.dispose();
    webglAddonRef.current = null;
    needsViewportRefreshRef.current = true;
  }, 10_000);
}
```

**Wrong**:

```tsx
// This kills the renderer and the terminal session UI state.
terminal.dispose();
terminalRef.current = null;
```

**Contracts**:

- Clear the hidden-WebGL timer when the terminal becomes visible again and during component unmount.
- Re-check `isVisibleRef.current` inside the timer callback before disposing.
- Recreate WebGL only while visible and only when the existing theme/background conditions allow it (not transparent, not light theme, not an explicit Linux WebKit fallback mode, and no prior context loss in the current terminal instance).
- After recreating WebGL, schedule a fit/viewport refresh so the existing xterm buffer repaints without reloading terminal history.
- The initial terminal creation effect must not add `lowMemoryMode` as a dependency that recreates the whole terminal when the setting toggles.

**Tests**: Run `npx tsc --noEmit`. Manually enable low memory mode, switch away from a terminal for more than 10 seconds, verify the session keeps running, then switch back and confirm the current viewport repaints without restarting the shell or losing scrollback.

### Convention: Terminal display state stays in the Display controller

**What**: `useTerminalDisplay` owns renderer state and output-direction state: `WebglAddon`, fit/viewport scheduling, active write queue, inactive output buffer, and the `pty-output-{sessionId}` listener. `XTermTerminal` only orchestrates the terminal instance and passes narrow ref/callback contracts into the hook.

**Why**: Display, input, and OSC handling previously shared one large lifecycle closure. Moving only the display-owned refs and listener into one controller means an input change cannot accidentally alter output buffering or renderer cleanup.

**Correct**:

```tsx
const display = useTerminalDisplay({
  terminalRef,
  fitAddonRef,
  isVisibleRef,
  isComposingRef,
  normalizeOutputRef,
  transformOutputRef,
});

// Output direction belongs to Display.
const detachPtyOutput = display.attachPtyOutput();
```

**Contracts**:

- The orchestrator owns writes to `terminalRef` and `isVisibleRef`; Display reads them only.
- Input owns writes to `isComposingRef`; Display reads it only to suppress a fit during IME composition.
- Display-owned queue, buffer, renderer, and PTY-listener refs must not be recreated in `XTermTerminal` or accessed by Input.
- Display transforms output through the supplied OSC/cursor callbacks before writing; it must not import Input state or register `terminal.onData`.

**Tests**: Run `npx tsc --noEmit` and `node scripts/terminalVisibility.test.mjs`. Manually verify tab switching with background output, resize, WebGL restoration, and IME composition after any Display controller change.

### Convention: Terminal focus requires active and visible layout state

**What**: `XTermTerminal` may focus xterm only when the session is globally active, currently visible, and no visibility-restore mask is pending. On Tab, Workspan, history-workspace, or split-pane transitions, wait for the progressive restore mask to clear, then defer `terminal.focus()` to the next animation frame.

**Why**: `isActive` can update before pane/workspan visibility. Synchronous focus against a hidden xterm helper textarea is lost when layout finishes, forcing the user to click again; focusing every visible split would instead steal input from the globally active pane.

**Contracts**:

- Depend on both `isActive` and `isVisible`.
- Blur when either value is false.
- Include `visibilityRestorePending` in the focus effect dependencies so clearing the restore mask schedules a new focus attempt.
- Re-check `terminalRef`, `isActiveRef`, and `isVisibleRef` inside the animation-frame callback.
- Re-check `visibilityRestorePendingRef` inside the animation-frame callback so an older frame cannot focus a terminal that has entered another restore cycle.
- Cancel the pending frame during effect cleanup.
- A visible but inactive split pane renders live output but never takes keyboard or IME focus.

**Tests**: Switch by mouse, keyboard, Workspan, and split pane; return from history and fullscreen; verify focus is applied only after the visibility-restore mask clears, then type immediately without clicking and confirm input reaches only the active visible terminal.

### Convention: Async terminal suggestions are scoped to one input attachment

**What**: `useTerminalInput.attachSuggestions()` resets all suggestion state and assigns an attachment generation. Delayed template/history/path/AI results must verify that generation before they update the ghost suggestion.

**Why**: Input suggestions are asynchronous while terminal sessions can be disposed and recreated immediately. Resetting shared refs alone lets an old request observe the new session's reset state and paint stale text into its terminal.

**Correct**:

```tsx
const generation = resetSuggestionState();
const isCurrentAttachment = () => (
  attachmentGenerationRef.current === generation && !suggestionDisposedRef.current
);

const result = await getTerminalInputSuggestionAiResult(context);
if (!isCurrentAttachment() || context.input !== getInput()) return;
```

**Contracts**:

- `attachSuggestions()` resets timers, in-flight flags, request ids, cache, previous-command state, and the visible ghost before registering a new session.
- Every asynchronous completion and delayed timer checks the current attachment generation before mutating a ref or React state.
- Cleanup invalidates only its own attachment; it must not clear callbacks installed by a newer session.

**Tests**: Run `npx tsc --noEmit`. With AI suggestions enabled, type a prefix and immediately switch sessions or close/reopen the tab; no ghost text from the old session may appear. Also verify local, path, and AI suggestions still accept with Tab, Right Arrow, and Ctrl+Space.

### Convention: Visibility restoration prefers natural rendering with a bounded refresh fallback

**What**: When `XTermTerminal` changes from hidden to visible, mask the drawing container synchronously, fit the terminal immediately without forcing a full viewport refresh, and wait for xterm's natural visibility-resume render. If no full-viewport `Terminal.onRender` arrives within two animation frames, request one full refresh. Renderer recreation still refreshes immediately. Reveal on the next animation frame after the full render and keep a bounded timeout fallback.

**Why**: Coupling `scheduleFit(true)` to `Terminal.refresh(0, rows - 1)` makes every ordinary Tab switch repaint the complete viewport and can visibly draw from top to bottom. Never forcing a refresh reintroduces the intermittent blank/stale terminal bug. Keeping immediate resize and forced viewport refresh as separate decisions preserves both fast normal switching and a bounded recovery path.

**Correct**:

```tsx
const beginVisibilityRestore = (deferViewportRefresh: boolean) => {
  visibilityRestorePendingRef.current = true;
  setVisibilityRestorePending(true);
  revealTimerRef.current = window.setTimeout(finishVisibilityRestore, 500);
  if (deferViewportRefresh) scheduleTwoFrameRefreshFallback();
};

terminal.onRender((range) => {
  if (!visibilityRestorePendingRef.current) return;
  if (!didRenderFullTerminalViewport(range, terminal.rows)) return;
  revealRafRef.current = window.requestAnimationFrame(finishVisibilityRestore);
});

// Ordinary visibility restore: resize now, refresh only if natural rendering stalls.
beginVisibilityRestore(true);
scheduleFit(true, false);

// Recreated WebGL/default renderer: the canvas is known to need a complete refresh.
beginVisibilityRestore(false);
scheduleFit(true, true);

const hidden = inactiveReplayPending || visibilityRestorePending;
```

**Wrong**:

```tsx
// This forces a complete repaint on every ordinary Tab switch.
if (becameVisible) {
  markViewportRefreshNeeded();
  scheduleFit(true);
}

// This has no bounded recovery when xterm does not naturally repaint.
if (becameVisible) scheduleFit(true, false);
```

**Contracts**:

- Mask only the xterm drawing container; keep the wrapper/background mounted and never recreate the `Terminal`, PTY listener, addons, scrollback, or input state.
- The hidden-to-visible render must be masked synchronously from the first visible React commit, before the visibility effect schedules fit/refresh.
- `scheduleFit(immediateResize, forceViewportRefresh)` keeps immediate geometry synchronization separate from complete viewport repainting. Existing callers that pass only `true` retain the explicit full-refresh behavior.
- Ordinary Tab/Workspan visibility restore calls `scheduleFit(true, false)` and gives xterm two animation frames to emit a natural full-viewport render.
- If no full render arrives within those two frames, mark the viewport dirty and call `scheduleFit(true, true)`. WebGL/default-renderer recreation takes this immediate full-refresh path without waiting.
- Use the public `Terminal.onRender` row range as the primary completion signal. A full viewport render covers row `0` through the current `terminal.rows - 1`.
- Reveal on the next animation frame after the full render event so canvas/WebGL output can reach the compositor.
- Keep a short final timeout fallback and clear the reveal timer, reveal frame, two-frame refresh fallback, and pending state on repeated restores, visibility loss, and unmount.
- Inactive-output replay masking remains independent. Clearing visibility-refresh masking must not reveal a terminal whose queued replay is still running.

**Tests**:

- Unit-test full, partial, and zero-row render-range decisions.
- Unit-test that immediate fit can skip viewport refresh and that an explicit refresh still repaints the complete grid when dimensions are unchanged.
- Run `npx tsc --noEmit` and the terminal visibility regression tests.
- Manually switch normal tabs and Workspans repeatedly; verify there is no progressive diagonal repaint.
- Manually switch back to a terminal with background output; verify the final buffer appears without blanking, partial replay, lost scrollback, or shell restart.
- Manually verify the timeout fallback cannot leave the terminal permanently hidden.

### Convention: Custom terminal scrollback keeps one effective row count

**What**: `terminalScrollbackCustomEnabled` defaults to `false`. When it is disabled, every terminal uses `TERMINAL_SCROLLBACK_ROWS_DEFAULT` (9000). When enabled, terminals use the validated `terminalScrollbackRows` value in the 1000–50000 range.

**Contracts**:

- Terminal construction, xterm option hot updates, and hidden-output buffer sizing must all use the same effective row count.
- Changing the switch or row value must update the existing xterm instance; do not recreate the terminal, reconnect the PTY, or reset addons/input state.
- Keep the saved custom value while the switch is disabled so re-enabling restores the user's value.
- Hidden terminal output remains bounded; disabling custom rows does not mean unlimited scrollback.

**Tests**: Run `npx tsc --noEmit`; manually toggle Custom in Settings > Terminal and verify existing/new/hidden terminals use 9000 rows while disabled and the saved custom value while enabled.

### Convention: Session history transcripts use a history render layer before Markdown

**What**: When rendering Claude/Codex session history message bodies, use `src/components/history/SessionTranscriptContent.tsx` instead of rendering raw message content directly with `MarkdownContent`. `SessionTranscriptContent` may detect session-log structures such as XML-ish blocks, workflow-state blocks, Git status lines, long lists, paths, commit hashes, and status tokens; ordinary Markdown content must still delegate to `HistoryMarkdownContent` / shared `MarkdownContent`.

**Why**: History files are mixed transcripts, not pure Markdown. They contain system context, workflow metadata, Git changes, paths, and task states. A render-layer adapter preserves readability without changing backend history parsing, storage, or the shared Markdown safety policy.

**Correct**:

```tsx
import { SessionTranscriptContent } from "./SessionTranscriptContent";

<SessionTranscriptContent content={message.content} query={sessionQuery} />
```

**Wrong**:

```tsx
<MarkdownContent content={message.content} query={sessionQuery} />
```

**Contracts**:

- Keep transcript parsing render-only; do not mutate stored history data or backend parsing contracts for visual grouping.
- Keep unsupported transcript text safe by falling back to the shared Markdown path.
- Do not use `dangerouslySetInnerHTML` for transcript highlighting.
- Do not add a second Markdown parser inside history components.
- Long transcript sections should remain bounded through collapse/preview behavior so virtualized message rows do not inflate unnecessarily.

**Tests**: Run `npx tsc --noEmit`; manually inspect a history session containing XML-ish blocks, workflow-state blocks, Git changes, long lists, and normal Markdown.

### Convention: History session parent-child grouping is render-only and conservative

**What**: When the history sidebar groups main agent sessions and subagent transcript sessions, keep the grouping in the render layer. Derive child sessions only from explicit path structure such as `.../<parent-session-id>/subagents/agent-*.jsonl`, and only attach them when the matching parent session is already present in the currently loaded list.

**Why**: History loading is paginated and source/project filtered. Scanning outside the current page or matching by loose path/session hints can add latency and can incorrectly attach a subagent to the wrong parent. A conservative render-only transform preserves the backend history contract and avoids misleading UI.

**Correct**:

```tsx
const parentSessionId = inferSubagentParentSessionId(session);
const parent = currentRowsBySessionId.get(`${session.source}:${session.project_key}:${parentSessionId}`);
if (parent) {
  attachChildUnderLoadedParent(parent, session);
}
```

**Wrong**:

```tsx
// Do not scan all history files or attach by project/path similarity when the parent is not loaded.
const guessedParent = findAnySessionWithSameProject(session);
attachChildUnderLoadedParent(guessedParent, session);
```

**Tests**: Run `npx tsc --noEmit`; manually verify a loaded parent with `subagents/agent-*.jsonl` children renders as a tree, while an orphan child remains a normal row.

### Convention: History session source icons use explicit source mapping

**What**: History session list source icons must map known history `source` values explicitly. Use `claude` -> `VendorKey "claude"` and `codex` -> `VendorKey "openai"` or the current Codex/OpenAI brand icon. Use `inferVendor(source)` only as a fallback for unknown future source strings.

**Why**: `source` is an app-level history source identifier, not a provider/model name. Passing it directly through generic vendor inference can make Claude and Codex sessions share the wrong icon when inference rules change or overlap with model/provider names.

**Correct**:

```tsx
const vendor =
  source === "claude" ? "claude" :
  source === "codex" ? "openai" :
  inferVendor(source);
```

**Wrong**:

```tsx
const vendor = inferVendor(source);
```

**Tests**: Run `npx tsc --noEmit`; manually verify the history list renders different source icons for Claude and Codex sessions in both light and dark themes.

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

### Convention: Project provider badges flow through sidebar tree context

**What**: Project-level provider badge rendering must consume `projectStore.providerBadges` through the sidebar tree context and render in `TreeNodeItem`. Badge data is produced by the store, not recomputed in individual tree rows.

**Why**: Provider switching has multiple adapters: Claude badges are probed by the backend from `.claude/settings.json`, while Codex badges come from `project.provider_overrides.codex`. Keeping both sources normalized in `projectStore.providerBadges` prevents sidebar rows from duplicating provider-specific logic and avoids regressions where switching succeeds but the project tree chip disappears.

**Correct**:

```tsx
// Sidebar root subscribes once and passes the normalized map through context.
const { tree, providerBadges } = useProjectStore(useShallow((s) => ({
  tree: s.tree,
  providerBadges: s.providerBadges,
})));

<TreeContext.Provider value={{ ...treeActions, providerBadges }}>
  <ProjectTree tree={tree} />
</TreeContext.Provider>

// TreeNodeItem reads providerBadges[project.id] and renders the existing chip.
```

**Wrong**:

```tsx
// Do not probe cc-switch or parse provider_overrides inside every tree row.
const badge = await invoke("ccswitch_probe_projects", { projectPaths: [project.path] });
```

**Contracts**:

- `projectStore.refreshProviderBadges()` is the single refresh point for provider badge data.
- Claude project badges come from backend `ccswitch_probe_projects` and preserve the previous `.claude/settings.json` behavior.
- Codex project badges come from `provider_overrides.codex` and must not trigger cc-switch DB reads per row.
- Badge chips must preserve the provider/vendor icon SVG when `inferVendor(providerName)` can infer one; do not regress to text-only chips.
- Rows with an override but no matched provider name use the localized custom-provider fallback.
- After applying or resetting a provider in `ProviderSwitchModal`, call `refreshProviderBadges()` so the tree chip updates without requiring an app restart.

**Tests**: Run `npx tsc --noEmit`; manually switch a Claude provider and a Codex provider and verify the project tree chip appears/clears immediately and after a fresh `fetchAll()`.

### Convention: Terminal tab drag uses overlay plus explicit pane drop zones

**What**: Terminal tab drag interactions use dnd-kit `DragOverlay` for the cursor-following tab, while pane movement/splitting is driven by explicit drop ids:

```typescript
type TerminalPaneDropEdge = "left" | "right" | "top" | "bottom";
type PaneDropTarget =
  | { type: "center"; paneId: string }
  | { type: "edge"; paneId: string; edge: TerminalPaneDropEdge };
```

**Why**: sortable tab transforms are optimized for in-list reordering and can visually lock a tab to the tab bar. Pane-level drop zones make center move and edge split behavior testable without guessing from DOM position after drop.

**Intent boundary**:

- A Workspan dragged inside the top tab bar remains a sortable tab operation.
- Once the pointer enters a pane content rectangle, its outer directional regions become split targets. Resolve left/right/top/bottom from the pointer position relative to the pane center, while keeping a neutral center region so entering a pane does not immediately force a split.
- Session tabs inside a multi-view pane keep the existing center-move and explicit edge-split behavior.
- Collision detection identifies the pane only. Resolve the Workspan split direction in `onDragOver` and `onDragEnd` from `activatorEvent + delta` and `over.rect`; do not synthesize a pane-edge collision inside the collision detector.
- The dragged Workspan is the source and the currently visible Workspan is the target. They must be different Workspans.

**Correct**:

```tsx
<DndContext collisionDetection={terminalTabCollisionDetection}>
  <SplitTerminalView node={paneTree} renderLeaf={renderLeaf} />
  <DragOverlay dropAnimation={null}>{activeTabOverlay}</DragOverlay>
</DndContext>

const dropTarget = parsePaneDropTarget(String(event.over.id));
const edge = dropTarget ? resolveWorkspanDropEdge(event, dropTarget) : null;
if (edge) setActiveDropPreview({ paneId: dropTarget.paneId, edge });
```

**Wrong**:

```tsx
// Do not infer pane splits from tab bar reorder transforms only.
const horizontalTransform = transform ? { ...transform, y: 0 } : transform;
```

**Tests**: For terminal drag UI changes, run `npx tsc --noEmit` and manually verify top-bar Workspan sorting, neutral pane center behavior, outer-region Workspan directional splitting, same-pane reorder, pane-center move, and left/right/top/bottom edge split previews in the Tauri desktop app.

### Convention: Drag responsiveness uses shared thresholds and frame-bounded previews

**What**: Sortable surfaces use `DND_ACTIVATION_CONSTRAINT` and `DND_SORTABLE_TRANSITION` from `src/lib/dragInteraction.ts`. Custom pointer drags use the same start distance, while cursor-following previews update DOM transforms at most once per animation frame.

**Why**: Divergent 5-8px activation distances and dnd-kit's default 200ms transform transition make similar drag surfaces feel inconsistent. Calling a large parent component's `setState` on every `pointermove` also rerenders expensive trees and terminal children faster than the browser can paint.

**Correct**:

```tsx
const sensors = useSensors(
  useSensor(PointerSensor, { activationConstraint: DND_ACTIVATION_CONSTRAINT })
);

useSortable({ id, transition: DND_SORTABLE_TRANSITION });

pendingPointRef.current = { x, y };
frameRef.current ??= requestAnimationFrame(() => {
  frameRef.current = null;
  const pending = pendingPointRef.current;
  if (pending && previewRef.current) {
    previewRef.current.style.transform = `translate3d(${pending.x}px, ${pending.y}px, 0)`;
  }
});
```

**Wrong**:

```tsx
useSensor(PointerSensor, { activationConstraint: { distance: 8 } });

const onPointerMove = (event: PointerEvent) => {
  setPreview({ x: event.clientX, y: event.clientY });
};
```

**Contracts**:

- Keep a non-zero activation distance so clicks, double-click rename, buttons, and context menus remain usable.
- Disable transform transitions for the actively dragged source; only displaced siblings use the short sortable transition.
- Do not write an equivalent drop-preview object when pane id and edge are unchanged.
- Hidden Workspans and hidden/fullscreen-excluded panes must disable their droppable regions.
- React state may create and remove a custom drag preview, but pointer movement uses `requestAnimationFrame` plus direct DOM transform updates.

**Tests**: Run `npx tsc --noEmit`; manually verify project/group sorting, terminal Tab/Workspan/toolbar sorting, settings-card sorting, file-tree preview tracking, pane-edge previews, and click/double-click behavior.

### Convention: Terminal split layout uses flat absolute positioning to preserve component identity

**What**: `SplitTerminalView` renders pane leaves and dividers using flat absolute positioning with computed geometry rather than nested flexbox recursion. All pane leaves are direct children keyed by `pane.id` under a single parent container.

**Why**: When a pane leaf is split using nested rendering, the original leaf moves to a new React parent path (wrapped by the new split node), causing `PaneLeafView` and its child `XTermTerminal` to remount. This remount destroys the xterm.js instance's in-memory scrollback buffer, making terminal history disappear after manual split or sub-agent hook auto-split.

**Implementation**:

```typescript
interface Rect { left: number; top: number; width: number; height: number; }
interface LeafLayout { leaf: TerminalPaneLeaf; rect: Rect; }
interface DividerLayout { split: TerminalPaneSplit; rect: Rect; splitRect: Rect; }

function buildSplitLayout(node: TerminalPaneNode, rect: Rect): { leaves: LeafLayout[]; dividers: DividerLayout[] } {
  if (node.type === "leaf") return { leaves: [{ leaf: node, rect }], dividers: [] };
  
  // Compute first/second pane rects and divider rect from split ratio + DIVIDER_SIZE
  const firstLayout = buildSplitLayout(node.first, firstRect);
  const secondLayout = buildSplitLayout(node.second, secondRect);
  
  return {
    leaves: [...firstLayout.leaves, ...secondLayout.leaves],
    dividers: [{ split: node, rect: dividerRect, splitRect: rect }, ...firstLayout.dividers, ...secondLayout.dividers],
  };
}

// Render all leaves as stable keyed children; split/unsplit only changes style.left/top/width/height
<div className="relative h-full w-full overflow-hidden">
  {layout.leaves.map(({ leaf, rect }) => (
    <div key={leaf.id} className="absolute overflow-hidden" style={rectStyle(rect)}>
      {renderLeaf(leaf)}
    </div>
  ))}
  {layout.dividers.map(({ split, rect }) => (
    <div key={split.id} onMouseDown={(e) => handleDragStart(split, e)} style={rectStyle(rect)} />
  ))}
</div>
```

**Contracts**:

- `buildSplitLayout` recursively walks the split tree and computes absolute rectangles for every leaf and divider. Geometry uses same 4px `DIVIDER_SIZE` and `split.ratio` as prior nested flexbox layout for visual equivalence.
- Divider drag calculates ratio relative to the split's own computed rectangle (`splitRect`), not the root container, so nested split drags work correctly.
- `PaneLeafView` keeps `key={pane.id}` stable; when a leaf is split, only its `style` props change — React preserves the original component instance.
- ResizeObserver on the container recalculates layout when window/pane size changes; `useMemo` avoids redundant geometry computation.

**Tests**: For changes affecting split rendering, run `npx tsc --noEmit` and manually verify in the desktop app:

- [ ] After outputting terminal history, manually split the terminal; original pane history remains visible and scrollable.
- [ ] Sub-agent hook auto-split creates transcript pane; parent terminal history remains visible.
- [ ] Divider drag resizing still works; nested splits resize correctly.
- [ ] Pane tab switching and session activation unchanged.

### Convention: Terminal resize drag uses local or DOM preview, then commits once

**What**: For terminal split dividers and terminal-side resizable panels, the drag interaction must update only a local preview during `mousemove` and commit the final width/ratio to React/Zustand state on `mouseup`. Do not write heavy global state or rerender embedded stats / git panels on every drag frame.

**Why**: Terminal panes contain xterm, realtime stats, and git views. Writing `paneTree` or panel width state every frame causes the whole terminal shell or panel subtree to rerender during drag, which makes width adjustment feel sticky and unsmooth.

**Correct**:

```tsx
const onMove = (event: MouseEvent) => {
  pendingWidthRef.current = nextWidth;
  if (frameRef.current === null) {
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      panelRef.current!.style.width = `${pendingWidthRef.current}px`;
    });
  }
};

const onUp = () => {
  const finalWidth = pendingWidthRef.current ?? widthRef.current;
  setWidth(finalWidth);
  localStorage.setItem(storageKey, String(finalWidth));
};
```

```tsx
const onMove = (event: MouseEvent) => {
  latestRatio = clampSplitRatio(rawRatio);
  if (rafId === null) {
    rafId = requestAnimationFrame(() => {
      rafId = null;
      setDragPreview({ splitId, ratio: latestRatio });
    });
  }
};

const onUp = () => {
  setDragPreview(null);
  setSplitRatio(splitId, latestRatio);
};
```

**Wrong**:

```tsx
const onMove = (event: MouseEvent) => {
  setWidth(nextWidth);
};
```

```tsx
const onMove = (event: MouseEvent) => {
  setSplitRatio(splitId, nextRatio);
};
```

**Contracts**:

- Drag preview may use local component state or direct DOM width updates, but the persistent width/ratio source of truth updates once on drag end.
- For split panes, keep pane content component identity stable while only wrapper geometry changes.
- For terminal-side panels, avoid rerendering `TerminalStatsPanel` / `GitChangesPanel` on every mousemove.

**Tests**: Run `npx tsc --noEmit`; manually verify split drag, stats panel drag, and git panel drag remain smooth while persisted width/ratio still survives reopen.

### Convention: Git tree compresses consecutive single-child directory chains at render time

**What**: In `GitTreeNodeComponent`, when rendering a directory node, walk consecutive single-child directory chains and compress them into a single display row showing the top directory name plus a weakened path suffix (JetBrains style).

**Why**: Deep directory structures such as Java package paths (`src/main/java/com/example/service/impl`) consume excessive vertical space when rendered one level per row. Compression reduces scrolling and makes file changes more visible without altering the underlying tree data or behavior.

**Example**:

```tsx
// Helper: collect consecutive single-child directory chain
function collectCompactDirectoryChain(node: GitTreeNode): { suffixParts: string[]; leaf: GitTreeNode } {
  const suffixParts: string[] = [];
  let leaf = node;

  while (leaf.type === "directory" && leaf.children?.length === 1 && leaf.children[0].type === "directory") {
    const next = leaf.children[0];
    suffixParts.push(next.name);
    leaf = next;
  }

  return { suffixParts, leaf };
}

// Render: top directory keeps icon, suffix parts shown in dimmed text
const { suffixParts, leaf: displayNode } = collectCompactDirectoryChain(node);

<span className="flex min-w-0 flex-1 items-baseline gap-1 truncate">
  <span className="truncate" style={{ color: TERM.fg }}>{node.name}</span>
  {suffixParts.length > 0 && (
    <span className="truncate text-[12px] font-normal" style={{ color: TERM.dim }}>
      {suffixParts.join("\\")}
    </span>
  )}
</span>
```

**Contracts**:

- Compression stops when a directory has multiple children or a child is a file (branch point).
- Collapse/expand behavior uses the leaf node's path as the collapse key, not the top node's.
- Directory-level checkbox and file collection apply to the leaf node's subtree.
- Original tree structure from `gitStore` is unchanged; compression is render-only.

**Why render-layer instead of data-layer**: Keeping the original tree structure unchanged preserves collapse state, file collection logic, and diff display paths. Render-layer compression only affects display label composition.

**Tests**: After changing Git tree rendering, run `npx tsc --noEmit` and manually verify in the desktop app:

- [ ] Deep directory chains compress into single rows with primary name + dimmed suffix.
- [ ] Clicking a compressed directory row expands/collapses the chain's leaf children.
- [ ] Directory checkbox state correctly reflects all files under the compressed chain.
- [ ] File paths in diff viewer still match the full repository path.
- [ ] Compression applies to both tracked and untracked trees.

---

## Props Conventions

(To be filled by the team)

---

## Styling Patterns

### Convention: Stats charts use a shared semantic palette

**What**: Stats and usage-analysis chart components should import semantic colors from `src/components/stats/statsPalette.ts` instead of hard-coding one-off hex/RGBA colors for token series, peak markers, cost fills, or chart tooltips.

**Why**: The app supports multiple light/dark themes. Hard-coded high-saturation chart colors can clash with theme surfaces and make related charts disagree visually. A shared palette keeps History Stats and ccusage charts consistent while still deriving colors from theme tokens.

**Example**:

```tsx
import { ACCENT, CHART_TOOLTIP, PEAK, SERIES_COLORS } from "./statsPalette";

const option = {
  color: [ACCENT, SERIES_COLORS.input, SERIES_COLORS.output],
  tooltip: { trigger: "axis", confine: true, ...CHART_TOOLTIP },
  series: [{ itemStyle: { color: PEAK } }],
};
```

**Tests**: For stats chart styling changes, run `npx tsc --noEmit` and manually verify the charts in at least one light theme and one dark theme.

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

**Contrast contract**: Transparent terminal background compositing must be theme-brightness aware. Dark terminal themes may use black alpha for the xterm cell background and image overlay, but light terminal themes must use white alpha so muted ANSI text stays readable. Light terminal themes should avoid WebGL because its glyph rendering and alpha compositing can make glyph edges look soft on bright surfaces even without a background image. Do not increase xterm `fontWeight` as a contrast fix; it can change cell metrics and make glyphs collide in light themes. Keep xterm's measured font and rendered font aligned: if global UI font CSS touches `.xterm`, route it through `--terminal-font-family` from `XTermTerminal` instead of `revert` or a hard-coded stack. Keep the decision centralized in `src/lib/terminalThemes.ts` helpers such as `isLightTerminalTheme`, `applyTransparency`, `getTerminalBackgroundOverlayColor`, and `getTerminalMinimumContrastRatio`; do not hardcode `rgba(0,0,0,...)` in `XTermTerminal` or terminal background CSS.

**Prevention checklist when wiring a new xterm appearance feature**:

- [ ] Does the feature need a non-opaque background, an alternate cursor blink, or any other "must-set-at-construction" xterm option?
- [ ] If yes, set it unconditionally at `new Terminal(...)` — do NOT gate it on the feature toggle.
- [ ] Read the JSDoc on every option you set; xterm marks construction-time options explicitly.
- [ ] When in doubt, grep `typings/xterm.d.ts` for "can't be changed later" / "must be set before".

### Common Mistake: Recreating the Terminal on settings change

**Symptom**: Toggling a terminal-related setting (font family change, background enable) causes the terminal to flash blank, lose scrollback, and re-prompt.

**Cause**: The construction `useEffect` lists a settings field in its dependency array, so changing that field disposes and recreates the Terminal.

**Fix**: Keep the construction effect's deps as `[sessionId]`. Add a separate hot-update effect that mutates `terminal.options.*` for the changed setting. xterm supports hot-mutating `fontSize`, `fontFamily`, `theme`, `cursorBlink`, `cursorStyle`, `scrollback` without rebuild. Only `allowTransparency`, `cols`/`rows` (use Fit instead), and `rendererType` (legacy) require rebuild.

### Common Mistake: Treating Codex half-screen scrolling as a scrollbar bug

**Symptom**: After shell output such as `dir`, starting Codex leaves the old output visible above Codex, while Codex scrolls only in the lower part of the terminal. Increasing terminal font size may make the outer scrollbar reappear, but that is only exposing the same state more clearly.

**Cause**: Codex is launched from the current shell cursor position instead of a clean viewport. The problem is the pre-launch screen state, not xterm scrollbar CSS, Codex `--no-alt-screen`, `TERM=dumb`, or terminal recreation.

**Fix**: Before direct Codex launches, send form feed (`\x0c`, Ctrl+L) to the PTY, then execute the command. Apply this to both automatic startup commands and manually typed direct `codex` commands on Enter. Keep the match narrow: direct commands such as `codex`, `codex.cmd`, `codex.exe`, and `codex.ps1` only.

**Wrong**:

```typescript
invoke("pty_write", { sessionId, data: `${command}\r` });
```

**Correct**:

```typescript
const clearBeforeLaunch = isDirectCodexStartupCommand(command) ? "\x0c" : "";
invoke("pty_write", { sessionId, data: `${clearBeforeLaunch}${command}\r` });
```

**Prevention**: When a TUI appears to scroll inside a partial screen, reproduce with prior shell output still visible. If old output remains above the TUI, fix the launch input sequence before changing scrollbar styles, TERM, alternate-screen flags, or xterm construction.

### Common Mistake: Clearing xterm directly for user-facing clear screen

**Symptom**: After a right-click "clear screen" action, the terminal output is cleared but IME candidate windows still open at the old pre-clear cursor position.

**Cause**: `terminal.clear()` mutates the xterm buffer directly and bypasses the normal PTY/shell input path. In `XTermTerminal`, IME positioning depends on xterm's helper textarea and composition anchoring. Bypassing the input path can leave the helper textarea anchored to stale pre-clear geometry.

**Wrong**:

```tsx
terminal.clear();
terminal.focus();
```

**Correct**:

```tsx
useTerminalStore.getState().markAttentionInputHandled(sessionId);
invoke("pty_write", { sessionId, data: "\x0c" });
terminal.focus();
```

**Prevention**: For user-facing terminal clear actions, send Ctrl+L (`\x0c`) through `pty_write` so the shell/TUI clears or redraws through the same path as keyboard input. Reserve `terminal.clear()` for internal buffer maintenance where IME/helper textarea position is irrelevant.

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

### Common Mistake: Estimating xterm IME cell size from container bounds

**Symptom**: IME candidate popup or composition caret drifts on secondary monitors, mixed-DPI displays, or after display-scale changes even though the terminal prompt row detection is correct.

**Cause**: `getBoundingClientRect().width / terminal.cols` and `height / terminal.rows` are only rough estimates of the rendered cell size. On xterm, the real cell metrics come from the render service and can differ slightly due to font measurement, renderer rounding, and DPI scaling. Those small errors accumulate across columns/rows and move the helper textarea away from the real caret.

**Fix**: When anchoring `.xterm-helper-textarea` or `.composition-view`, read xterm's rendered dimensions first and only fall back to DOM estimation if the internal metrics are unavailable.

```tsx
const renderedCell = (
  terminal as typeof terminal & {
    _core?: {
      _renderService?: {
        dimensions?: {
          css?: { cell?: { width?: number; height?: number } };
        };
      };
    };
  }
)._core?._renderService?.dimensions?.css?.cell;

const width = renderedCell?.width ?? fallbackWidth;
const height = renderedCell?.height ?? fallbackHeight;
```

**Prevention**:

- [ ] For xterm cursor / IME positioning, prefer `_core._renderService.dimensions.css.cell`.
- [ ] Keep DOM `getBoundingClientRect()`-based division only as fallback.
- [ ] After changing IME anchoring, manually verify primary-screen and secondary-screen input behavior.

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

### Common Mistake: Rewriting ANSI when the bug is already in xterm buffer attrs

**Symptom**: A TUI row, such as the Claude/Codex composer on a light terminal theme, keeps a stale dark background even after filtering likely SGR background sequences from the raw PTY stream.

**Cause**: The raw stream is only one input to xterm. After xterm parses control sequences, the visible state is stored on buffer cells. If the app repaints the composer or uses a sequence form the filter did not cover, pre-parse ANSI rewriting becomes guesswork and misses the actual rendered cell attributes.

**Fix**: For narrow TUI rendering fixes, run correction from the `terminal.write(data, callback)` callback, locate the visible prompt row through `terminal.buffer.active`, mutate only the known bad cell attribute, then call `terminal.refresh(row, row)`.

```tsx
terminal.write(chunk, () => {
  if (terminalRef.current !== terminal) return;
  normalizeTuiPromptBackground(terminal);
});
```

When using xterm internals, keep the hack small and version-scoped. xterm 6 exposes a read-only public `IBufferLine`, but the runtime `BufferLineApiView` keeps the mutable line on `_line`. Clear only the visual field styling when the theme/background mode makes stale TUI fields harmful, such as light themes or active terminal background-image transparency: explicit background color bits (`0x03ffffff`) and, only when inverse spans a wide part of a known bad row, the inverse flag (`0x04000000`). Do not clear isolated inverse cells; those may be the TUI caret.

```tsx
const mutableLine = (line as IBufferLine & { _line?: MutableLine })._line;
mutableLine.loadCell(x, cell);
cell.bg &= ~0x03ffffff;
if (lineHasWideInverse) cell.fg &= ~0x04000000;
mutableLine.setCell(x, cell);
terminal.refresh(row, row);
```

**Prevention**: Do not keep broadening ANSI filters after the first miss. If the defect is a visual xterm cell state, inspect or correct `terminal.buffer.active` after the write callback. Gate the fix narrowly by theme brightness and prompt signature, not only by shell/tool name; Claude and Codex can emit similar composer styling through different shells. Codex may put the dark field on the row immediately before the visible `›` prompt, so include a small prelude range when normalizing prompt rows. Submitted prompt rows can move to the upper visible viewport after output arrives, so scan the whole visible viewport, not only the bottom prompt area. Tab restore and resize can trigger an xterm repaint after React visibility effects; coalesce a post-`onRender` normalization with `requestAnimationFrame` so restored tabs do not redraw stale composer backgrounds.

For terminal background images, active transparency mode is an appearance-mode gate equivalent to theme brightness. Keep prompt detection narrow, but do not block normalization only because the terminal theme is dark; dark themes can still expose stale explicit backgrounds as opaque boxes over the image.

If a CLI draws large opaque panels or status rows over a terminal background image, remember that CLI themes only affect which ANSI colors are emitted; they do not make ANSI background cells transparent. For known full-screen AI TUIs such as Claude/Codex, the background-image mode may clear explicit background attrs and inverse flags across the visible viewport. Keep that broad pass gated by active transparency plus the known TUI session or a visible TUI signature; use the narrower prompt-row correction for unknown tools.

Do not keep WebGL enabled while a terminal background image is active. The default renderer is the safer path for transparent backgrounds and xterm buffer-attr corrections; WebGL can preserve or redraw opaque TUI cells in ways that make Codex/Ratatui panels appear as black blocks.

### Convention: Click-based terminal cursor relocation is unsupported

**What**: Clicking terminal content does not reposition the PTY line-editor cursor. The application must not register a click handler that emits cursor-movement sequences.

**Why**: Rendered xterm coordinates are not a reliable representation of shell or TUI input state. Enabling this behavior desynchronizes the visible caret, the PTY line editor, and TUI-owned input boxes.

**Tests**: Verify normal click-to-focus and mouse text selection still work. Do not add a click-to-caret acceptance test because cursor relocation is intentionally absent.

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

**Contracts**:

- Browser paste, keyboard/menu paste, in-app file drag, and native WebView file drop belong to the Input controller and must converge on one `terminal.paste()` path.
- `attachPasteAndDrop()` owns its DOM listeners, drop-zone registration, and native drag-drop unlisten callback; its returned cleanup must release all of them, including an unlisten callback that resolves after cleanup begins.
- File/image paths are formatted for the resolved shell before native paste; do not bypass shell quoting by writing the raw path directly to the PTY.

**Tests / manual checks**:

- [ ] Windows 10 + PowerShell retains scrollback after tab switch / resize / fit.
- [ ] Claude Code multi-line paste preserves line order and is not submitted line-by-line.
- [ ] CMD still accepts normal paste and Enter behavior.
- [ ] Browser text/image paste, app-internal file drag, and system file drop all focus the intended visible terminal only once.

### Convention: Terminal input selection state stays in the Input controller

**What**: useTerminalInput.attachSelection() owns current-input selection state and its mouse listeners: select-all, Shift+Arrow expansion, Arrow collapse, selection deletion/replacement, and the disabled-by-default click-cursor path. XTermTerminal may route keyboard branches to the returned controller, but must not recreate its selection snapshots or cursor-range state.

**Why**: Selection editing combines xterm viewport cells with the PTY line-editor sequence. Keeping its state inside Input prevents changes to display rendering, output buffering, or context-menu UI from silently changing selection semantics.

**Correct**:

    const selection = attachSelection(terminal, {
      markAttentionInputHandled,
      reportPtyWriteError,
    });
    inputDisposables.push({ dispose: selection.dispose });

**Contracts**:

- Create one controller per terminal attachment; its selection state must start empty and dispose() must remove its DOM listeners.
- Input owns the current-input buffer and cursor index. Callers must use the controller API rather than passing or mutating those refs.
- Use the existing terminalTextEditing and terminalCellWidth helpers for cursor indices and display cells. Do not approximate CJK/wide-character offsets with string length.
- The shared TUI composer markers belong in src/lib/terminalTui.ts; selection and rendering import the same patterns instead of defining local copies.
- forwardTerminalInput() consumes a replacement selection before writing to the PTY, then clears only the state required by the original input path.

**Tests**: Run npx tsc --noEmit; manually verify Ctrl/Cmd+A, Shift+Left/Right, collapse with Left/Right, Backspace/Delete, typing to replace a selection, Ctrl/Cmd+C selection copy versus Ctrl+C interrupt, and switching sessions after a selection.

### Common Mistake: Letting xterm sync updates clear the screen while the user is reading scrollback

**Symptom**: During Codex / Claude Code / Copilot-style TUI streaming, scrolling upward to inspect older output becomes impossible, or a later resize causes the current screen to be replayed into scrollback.

**Cause**: Modern TUIs can wrap redraw bursts in `DECSET/DECRST 2026` sync-update blocks and emit `CSI 2 J` / `CSI 3 J` clears inside those bursts. In `@xterm/xterm` 6.x on embedded terminals, those clears can yank the viewport back to the live screen or amplify resize redraws, especially on Windows ConPTY.

**Fix**: Keep the workaround in the frontend xterm stream path, not in the Rust PTY backend. Track whether the user has scrolled away from bottom, detect `\x1b[?2026h` / `\x1b[?2026l`, and while a sync-update block is active drop `CSI 2 J` / `CSI 3 J` only when preserving scrollback matters. Also defer opportunistic `fit()` calls until the sync-update block ends.

**Correct**:

```tsx
if (
  syncUpdateDepthRef.current > 0
  && shouldPreserveViewportDuringSync()
  && (sequence === "\x1b[2J" || sequence === "\x1b[3J")
) {
  continue;
}
```

**Wrong**:

```tsx
// Do not globally strip screen-clearing sequences for every terminal frame.
text = text.replace(/\x1b\[[23]J/g, "");
```

**Prevention**:

- [ ] When terminal scrollback breaks only during agent/TUI streaming, inspect sync-update and clear-screen sequences before changing PTY/backend logic.
- [ ] Scope clear-screen filtering to the "user is reading history" case; do not degrade normal at-bottom TUI redraw fidelity.
- [ ] If resize is noisy during TUI streaming, prefer deferring `fit()` rather than rebuilding the terminal or forcing outer-container scroll resets.

### Common Mistake: Misdiagnosing Claude Code scrollback duplication as a CLI-Manager rendering bug

**Symptom**: While Claude Code streams output the live view looks correct, but scrolling up later reveals duplicated blocks in scrollback. The duplicate sits at a frame boundary: the tail rows of the previous frame (e.g. diff lines `147-149`) followed by the new frame reprinting from the same rows. Duplicates are stable (selectable, survive redraws), so they are real buffer content — not a WebGL/canvas artifact.

**Cause** (investigated 2026-07-02): Upstream Claude Code bug, not ours. Its default inline (Ink) renderer leaves the old frame in scrollback and reprints a near-identical frame on relayout triggers (content crossing the viewport edge, spinner updates, SIGWINCH, Ctrl+O). Tracked upstream in anthropics/claude-code #53857, #46834, #52924, #52945, #51828 — reproduced on iTerm2, Terminal.app, VS Code, Windows Terminal across macOS/Linux/Windows, so the emulator is not the culprit. Our `scrollOnEraseInDisplay: true` amplifies the ED2-clear flavor of this (iTerm2-style "push erased screen into scrollback"), which is why duplicates can look worse here than in spec-conform terminals.

**Fix**: Do not change CLI-Manager. Mitigate on the Claude Code side: set `"env": {"CLAUDE_CODE_NO_FLICKER": "1"}` in `~/.claude/settings.json` (more reliable on Windows than the `"tui": "fullscreen"` settings key), or run `/tui fullscreen` in-session. Both switch to alt-screen rendering, which never touches scrollback (at the cost of the native scrollbar).

**Wrong**:

```tsx
// Do not remove this option to "fix" the duplication.
const terminal = new Terminal({
  // scrollOnEraseInDisplay: true,  <- removed
});
```

Removing `scrollOnEraseInDisplay: true` is a worse regression: Codex repaints via explicit ED2+ED3, so without it Codex scrollback never grows at all (xtermjs/xterm.js#5745), and PowerShell/ConPTY loses history on clear — the exact problems commit `d15495d` (2026-06-08) introduced the option to solve.

**Prevention**:

- [ ] First classify: buffer-level duplication (stable when scrolled, selectable) vs. rendering artifact (vanishes on redraw). Frame-boundary duplicates during Claude Code sessions point upstream — do not start by auditing our renderer or PTY path.
- [ ] Cross-check in Windows Terminal with the same CLI before blaming the embedded xterm.
- [ ] Treat `scrollOnEraseInDisplay: true` + `windowsPty: { backend: "conpty" }` as a coupled pair with the trade-off documented above; any change must re-verify Codex scrollback growth and PowerShell `cls` history.

### Convention: Light-theme hierarchy relies on contrast plus borders, not tint alone

**What**: When polishing existing light-theme UI surfaces, selected and active states must combine three signals: darker text or icon contrast, a stronger edge (`border` or inset outline), and a surface step that is visibly different from hover. Do not rely on a near-white tint change alone.

**Why**: Dense desktop-tool layouts compress tabs, tree rows, toolbar buttons, and side-panel shells into narrow bands. In light themes, subtle fills collapse visually into the base surface and make selection state hard to scan. Border and surface hierarchy improve readability without increasing spacing or introducing decorative gradients.

**Example**:

```css
[data-theme="light"] .ui-tab-trigger[data-selected="true"] {
  border-color: color-mix(in srgb, var(--interactive-selected-border) 68%, transparent);
  background-color: color-mix(in srgb, var(--primary) 12%, white 88%);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--interactive-selected-border) 34%, transparent);
}

[data-theme="light"] .ui-tree-project[data-selected="true"] {
  border-color: color-mix(in srgb, var(--interactive-selected-border) 58%, transparent);
  background: color-mix(in srgb, var(--primary) 13%, white 87%);
}
```

**Wrong**:

```css
[data-theme="light"] .ui-tree-project[data-selected="true"] {
  background: color-mix(in srgb, var(--primary) 5%, white 95%);
  border-color: transparent;
}
```

**Tests**: Run `npx tsc --noEmit`; manually verify at least one light palette and one dark theme. In the light theme, check project-tree selection, terminal tabs, toolbar buttons, and terminal side-panel buttons are distinguishable at a glance without changing layout density.
