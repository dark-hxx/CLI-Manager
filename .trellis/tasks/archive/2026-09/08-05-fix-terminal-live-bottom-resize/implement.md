# Terminal Live-Bottom Resize Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep a normal-buffer terminal at the live bottom across horizontal reflow and asynchronous xterm viewport synchronization, while preserving the existing history marker behavior.

**Architecture:** `useTerminalDisplay.resizeTerminal()` captures whether horizontal resize starts at the live bottom or in scrollback. History continues through a marker; live bottom is reasserted immediately and after the existing two-frame viewport synchronization window using only xterm public APIs.

**Tech Stack:** React hooks, TypeScript, `@xterm/xterm`, Node.js built-in test runner, TypeScript compiler.

## Global Constraints

- Do not access or mutate xterm private `_core` or `isUserScrolling` fields.
- Do not change daemon, ConPTY, replay, input forwarding, dependencies, or xterm version.
- Only horizontal normal-buffer resize may schedule live-bottom restoration.
- Historical normal-buffer viewports must continue following their marker; alternate buffer must not be forced to scroll.
- Every implementation change must be covered by `scripts/terminalReplay.test.mjs`.

---

### Task 1: Add the live-bottom regression and boundary tests

**Files:**
- Modify: `scripts/terminalReplay.test.mjs:132-329`

**Interfaces:**
- Consumes: `useTerminalDisplay().scheduleFit()` and `cancelScheduledFit()`.
- Produces: `FakeTerminal.scrollToBottom()` and deterministic regression coverage for immediate/deferred bottom restoration.

- [ ] **Step 1: Extend `FakeTerminal` with the public xterm scroll API**

Add this method next to `scrollToLine()`:

```js
  scrollToBottom() {
    this.buffer.active.viewportY = this.buffer.active.baseY;
    this.events.push(`scroll-bottom:${this.buffer.active.viewportY}`);
  }
```

- [ ] **Step 2: Replace the live-bottom test with the failing asynchronous regression**

```js
test("horizontal reflow restores live-bottom intent after asynchronous viewport drift", () => {
  const { display, terminal, events, detachViewport } = createDisplay({ cols: 60, rows: 24 });
  terminal.cols = 120;
  terminal.rows = 24;
  terminal.buffer.active.baseY = 277;
  terminal.buffer.active.cursorY = 23;
  terminal.buffer.active.viewportY = 277;
  terminal.viewportMaxScrollLine = 277;
  terminal.reflowBaseYDelta = 300;

  display.scheduleFit(true, false);
  flushNextAnimationFrame();

  assert.equal(terminal.buffer.active.viewportY, 577);
  assert.deepEqual(events, ["resize:60x24", "scroll-bottom:577"]);

  // Reproduce the delayed DOM viewport event that can leave xterm at the top.
  terminal.buffer.active.viewportY = 0;
  flushNextAnimationFrame();
  assert.equal(terminal.buffer.active.viewportY, 0);

  flushNextAnimationFrame();
  assert.equal(terminal.buffer.active.viewportY, 577);
  assert.deepEqual(events, ["resize:60x24", "scroll-bottom:577", "scroll-bottom:577"]);
  detachViewport();
});
```

- [ ] **Step 3: Add non-horizontal and alternate-buffer safety tests**

```js
test("vertical resize does not force a live-bottom scroll", () => {
  const { display, terminal, events, detachViewport } = createDisplay({ cols: 120, rows: 30 });
  terminal.cols = 120;
  terminal.rows = 24;
  terminal.buffer.active.baseY = 277;
  terminal.buffer.active.viewportY = 277;

  display.scheduleFit(true, false);
  flushAnimationFrames();

  assert.deepEqual(events, ["resize:120x30"]);
  detachViewport();
});

test("alternate buffer resize does not force a live-bottom scroll", () => {
  const { display, terminal, events, detachViewport } = createDisplay({ cols: 60, rows: 24 });
  terminal.cols = 120;
  terminal.rows = 24;
  terminal.buffer.active.type = "alternate";

  display.scheduleFit(true, false);
  flushAnimationFrames();

  assert.deepEqual(events, ["resize:60x24"]);
  detachViewport();
});
```

- [ ] **Step 4: Add cancellation coverage for the deferred restore**

```js
test("cancelling a scheduled fit cancels pending live-bottom restoration", () => {
  const { display, terminal, events, detachViewport } = createDisplay({ cols: 60, rows: 24 });
  terminal.cols = 120;
  terminal.rows = 24;
  terminal.buffer.active.baseY = 277;
  terminal.buffer.active.viewportY = 277;
  terminal.reflowBaseYDelta = 300;

  display.scheduleFit(true, false);
  flushNextAnimationFrame();
  terminal.buffer.active.viewportY = 0;

  display.cancelScheduledFit();
  flushAnimationFrames();

  assert.equal(terminal.buffer.active.viewportY, 0);
  assert.deepEqual(events, ["resize:60x24", "scroll-bottom:577"]);
  detachViewport();
});
```

- [ ] **Step 5: Run the focused test and verify the intended failure**

Run: `node --test scripts/terminalReplay.test.mjs`

Expected: the new live-bottom test fails because current `resizeTerminal()` never calls `scrollToBottom()`; history and existing replay tests remain green.

---

### Task 2: Restore live-bottom intent through the public xterm API

**Files:**
- Modify: `src/hooks/useTerminalDisplay.ts:44-154`
- Modify: `src/hooks/useTerminalDisplay.ts:471-510`
- Test: `scripts/terminalReplay.test.mjs`

**Interfaces:**
- Consumes: `Terminal.scrollToBottom()`, `Terminal.scrollToLine()`, `Terminal.registerMarker()`, `requestAnimationFrame()`.
- Produces: the local discriminated union `PendingViewportRestore` and `scheduleViewportRestore(pending)`.

- [ ] **Step 1: Generalize the pending restore state**

Replace the marker-only interface with:

```ts
type PendingViewportRestore =
  | {
    kind: "bottom";
    terminal: Terminal;
  }
  | {
    kind: "marker";
    marker: IMarker;
    terminal: Terminal;
  };
```

- [ ] **Step 2: Make cancellation and deferred restoration handle both intents**

```ts
  const cancelPendingViewportRestore = () => {
    if (viewportRestoreRafRef.current !== null) {
      cancelAnimationFrame(viewportRestoreRafRef.current);
      viewportRestoreRafRef.current = null;
    }
    const pending = pendingViewportRestoreRef.current;
    pendingViewportRestoreRef.current = null;
    if (pending?.kind === "marker" && !pending.marker.isDisposed) pending.marker.dispose();
  };

  const scheduleViewportRestore = (pending: PendingViewportRestore) => {
    pendingViewportRestoreRef.current = pending;
    viewportRestoreRafRef.current = requestAnimationFrame(() => {
      if (pendingViewportRestoreRef.current !== pending) return;
      viewportRestoreRafRef.current = requestAnimationFrame(() => {
        viewportRestoreRafRef.current = null;
        if (pendingViewportRestoreRef.current !== pending) return;
        pendingViewportRestoreRef.current = null;
        try {
          if (terminalRef.current !== pending.terminal) return;
          if (pending.kind === "bottom") {
            pending.terminal.scrollToBottom();
          } else if (!pending.marker.isDisposed) {
            pending.terminal.scrollToLine(pending.marker.line);
          }
        } finally {
          if (pending.kind === "marker" && !pending.marker.isDisposed) pending.marker.dispose();
        }
      });
    });
  };
```

- [ ] **Step 3: Capture and restore the pre-resize scrolling intent**

Replace the current marker construction and post-resize scheduling block with:

```ts
    const buffer = terminal.buffer.active;
    const isHorizontalReflow = cols !== terminal.cols;
    const wasAtLiveBottom = (
      isHorizontalReflow
      && buffer.type === "normal"
      && buffer.viewportY === buffer.baseY
    );
    // Horizontal reflow changes physical row indexes; a marker follows the logical viewport line.
    const viewportMarker = (
      isHorizontalReflow
      && buffer.type === "normal"
      && buffer.viewportY < buffer.baseY
    )
      ? terminal.registerMarker(buffer.viewportY - buffer.baseY - buffer.cursorY)
      : undefined;
    terminal.resize(cols, rows);
    resizeRenderBarrierRef.current?.noteContainerResize();
    if (wasAtLiveBottom) {
      // Reassert xterm's live-follow intent before and after its asynchronous DOM viewport sync.
      terminal.scrollToBottom();
      scheduleViewportRestore({ kind: "bottom", terminal });
    } else if (viewportMarker) {
      scheduleViewportRestore({ kind: "marker", marker: viewportMarker, terminal });
    }
```

- [ ] **Step 4: Cancel stale restore work when output state resets**

Add `cancelPendingViewportRestore();` to `resetOutputState()` before clearing pending output chunks.

- [ ] **Step 5: Run focused tests and verify all cases pass**

Run: `node --test scripts/terminalReplay.test.mjs`

Expected: all terminal replay tests pass, including the asynchronous drift, history marker, alternate buffer, vertical resize, and cancellation cases.

- [ ] **Step 6: Commit the tested fix**

```bash
git add src/hooks/useTerminalDisplay.ts scripts/terminalReplay.test.mjs
git commit -m "fix(terminal): preserve live bottom across resize"
```

---

### Task 3: Update the terminal contract and verify the branch

**Files:**
- Modify: `docs/terminal-known-issues.md:37`
- Modify: `.trellis/spec/frontend/component-guidelines.md:19`

**Interfaces:**
- Consumes: the completed live-bottom behavior from Task 2.
- Produces: an accurate `TERM-F05` contract for future terminal resize changes.

- [ ] **Step 1: Update `TERM-F05` mitigation text**

Document that history uses a marker while live bottom is reasserted immediately and after DOM synchronization through `scrollToBottom()`; alternate buffer remains untouched.

- [ ] **Step 2: Update the frontend terminal guideline**

Replace the assumption that xterm automatically follows live bottom with the explicit requirement that horizontal normal-buffer resize preserves both live-bottom and historical viewport intent.

- [ ] **Step 3: Run focused and static validation**

Run:

```bash
node --test scripts/terminalReplay.test.mjs
npx tsc --noEmit
git diff --check
```

Expected: tests pass, TypeScript reports no errors, and `git diff --check` reports no whitespace errors.

- [ ] **Step 4: Run the project build**

Run: `npm run build`

Expected: production frontend build completes successfully.

- [ ] **Step 5: Commit the contract update**

```bash
git add docs/terminal-known-issues.md .trellis/spec/frontend/component-guidelines.md
git commit -m "docs: clarify terminal resize scroll intent"
```

- [ ] **Step 6: Review the final branch diff**

Run:

```bash
git status --short
git diff master...HEAD --check
git diff --stat master...HEAD
```

Expected: only the design, implementation plan, terminal display, replay test, and two terminal contract documents are included; diagnostic cache directories remain untracked and are never staged.
