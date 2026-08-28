# Fix Triage Guide

> **Purpose**: Before touching code, triage — is this a *minimal fix* or a *root-cause fix*? For a new feature, have you enumerated all the scenarios?
> This document is an **entry gate**, not a thinking aid. For depth it points back to [cross-layer](./cross-layer-thinking-guide.md) and [code-reuse](./code-reuse-thinking-guide.md); it does not restate them.

---

## 0. Triage Entry

Any "fix a bug / add a requirement" task splits into two classes first:

```
Nature of the task?
├─ New feature ─────→ No "minimal" path. Do the [scenario enumeration] first, then the [discovery list]. Go to §5 + §4.
└─ Bug fix ─→ run the §1 triage test ─→ minimal fix (§3) or root-cause fix (§4)
```

A new feature crosses touchpoints and involves multiple scenarios by nature — there is no "minimal change" lane for it. Only a bug fix needs the triage below.

---

## 1. Triage Test (bug fixes only)

### All satisfied → take the [minimal fix] lane (§3)

- [ ] The change is only a **presentation-layer static value**: color, copy, spacing, icon, constant, label
- [ ] Confined to a **single layer / single file**, no data crossing a boundary
- [ ] **Does not touch** behavior, state, timing, async, lifecycle, or processes
- [ ] You can **point at the exact wrong line and say why**, no investigation/repro needed

### Any one hit → you must take the [root-cause fix] lane (§4)

- [ ] The symptom is **behavioral**: failure / hang / race / duplication / leak / wrong state
- [ ] The error site is a **consumer** of some data or state (the true cause may be upstream)
- [ ] **Crosses a boundary**: IPC, PTY / process, serialization, WebDAV sync, layer-to-layer
- [ ] You **want to add** a try/catch, an `if` guard, a retry, or a default value at the symptom site ← the smell of patching, stop
- [ ] It is a **regression** ("it used to work")
- [ ] It is **intermittent** or timing-related

> The sharpest single test: **the moment you feel the urge to "add a fallback where the error shows up," it's almost certainly time to find the root cause.**

### Calibration examples

| Task | Verdict | Basis |
|---|---|---|
| Fix a button color | Minimal fix | Presentation-layer static value + single layer + no behavior — all four satisfied |
| Terminal Ctrl+C interrupt fails | Root cause | Behavioral + crosses process boundary (ConPTY/daemon) + regression |

The real Ctrl+C fix validated the root-cause approach: the cause was "the daemon spawned with a detached/new process group," and the fix landed **at the process-spawn origin**, not as a guard in the keypress handler.

---

## 2. The Red Line for the Verdict

**The verdict is always based on your post-investigation judgment of the bug's nature, never on the user's wording.**

Users say "the button does nothing," "the jump is broken," "take a look at this." They **won't** — and **can't** — state the trigger condition (a bug whose condition they could articulate would already have been worked around). The real trigger condition is something *you* dig out after **reproducing + locating** it.

So: don't wait for the user to say "when … happens." Reproduce it yourself, and reach the conclusion "this depends on some runtime state" yourself.

---

## 3. Lane A · Minimal Fix

- Just make the change; verify the changed scope with `npx tsc --noEmit` (frontend) or `cargo check` (Rust).
- **Don't overthink it.** No refactor, no "while I'm here" cleanup, no scope expansion. This lane exists to be fast.
- If, after starting, you hit any root-cause condition from §1 → switch to §4 immediately, don't force it into a minimal fix.

---

## 4. Lane B · Root-Cause Fix

The deliverables are **mandatory** and must appear in the report.

### 4.1 Root-Cause Statement

One sentence: **which boundary / which layer the bug lives at, and why the fix lands at that layer.**

Forbidden: catching / falling back / injecting a default at the symptom layer without touching the upstream that actually produces the bad data.

### 4.2 State-Dependency Self-Check ★

After writing the root-cause statement, check whether it contains a **state qualifier** — focus in which window, which pane, minimized or not, which session type, WSL vs local, Worktree, hook installed or not…

**If the root-cause statement contains any such state qualifier** (whether or not the user mentioned it), this is a **state-dependent failure**, often a landmine left by an older feature that "didn't cover all the scenarios back then." In that case:

→ Do not fix only the one state you reproduced. **Against the scenario matrix in §5, enumerate the feature's behavior across all state combinations**, and confirm each one is either "missing, must be added" or "intentionally unsupported."

> Real case: the hook "view" button couldn't jump across windows. Written out, the root-cause statement was "the jump logic assumes the target session is in the currently focused window; when focus is in another window, locating it fails" — "when focus is in another window" is the state qualifier that triggers scenario enumeration. Fixing only that one jump = the next state keeps breaking = whack-a-mole.

### 4.3 Discovery List (code touchpoints)

List **every** code touchpoint the change reaches, check each off; even the ones you clear must be explicitly marked "confirmed unrelated" — don't silently skip them.

Pick the generation method by availability; **the deliverable itself is tool-agnostic**:

1. **Preferred** — GitNexus: `gitnexus_impact` (upstream+downstream) / `gitnexus_query`
2. GitNexus unavailable or not installed → the matching `.trellis/spec/*-contracts.md` contract doc + cross-references
3. Fallback → `grep -r` for symbols / keywords

Whichever lane, the discovery list **must land in the report**.

### 4.4 How to Find All the Touchpoints

- Horizontal "who does changing this reach" → see [cross-layer-thinking-guide](./cross-layer-thinking-guide.md)
- "Am I reinventing a wheel / did I miss a sibling instance" → see [code-reuse-thinking-guide](./code-reuse-thinking-guide.md)

This document does not restate those two; open them when needed.

---

## 5. Scenario Matrix (project-specific)

**Why**: GitNexus can tell you "who calls this function" (code touchpoints), but it **cannot tell you "under what runtime state a user triggers it"** (scenario touchpoints). Missing scenarios are the real culprit behind "did 80%, missed 20%," and they're exactly the part tools can't find — a human has to walk the matrix.

**When to use**: before starting a new feature (§0), and when a root-cause fix hits the state self-check (§4.2). For each dimension, ask "in every value of this dimension, does my feature behave correctly?"

| Dimension | Values to cover |
|---|---|
| Window focus | Focus in this window / in another window / app not focused |
| Split pane | Target in the current pane / in another pane of the same window / in a deep node of the split tree |
| Minimized / tray | Normal window / minimized / minimized to tray |
| UI presentation mode | Expanded sidebar / collapsed sidebar / compact embedded sidebar |
| Multi-session / Workspan | Single session / multiple sessions / switching across Workspans |
| Focus-mode toggle | On / off |
| Runtime environment | Local PowerShell/CMD/Pwsh / WSL / Bash |
| Worktree | Main repo / Worktree subdirectory / Worktree directory already missing / **`.git` is a *file*, not a directory** (inside a linked worktree) |
| CLI Hook | Claude/Codex hook installed / not installed / only one installed |

> This table is alive. Every time you hit "another bug caused by a scenario nobody thought of," add that dimension here (in the spirit of index.md's Contributing note).

> Real case (issue #227): the file explorer hid `.git` via a name check gated on `entry.kind === "directory"`. Inside a linked git worktree `.git` is a **file**, so the gate silently failed and `.git` showed up in the tree. Any name-based check for VCS/tooling metadata must not assume the entry is a directory.

---

**Core principle**: pass the gate first (triage) → the gate tells you which lane → open cross-layer / code-reuse for depth when needed. The three don't compete side by side; they form an "entry + aids" hierarchy.
