# Cross-Layer Thinking Guide

> **Purpose**: Think through data flow across layers before implementing.

---

## The Problem

**Most bugs happen at layer boundaries**, not within layers.

Common cross-layer bugs:
- API returns format A, frontend expects format B
- Database stores X, service transforms to Y, but loses data
- Multiple layers implement the same logic differently

---

## Before Implementing Cross-Layer Features

### Step 1: Map the Data Flow

Draw out how data moves:

```
Source → Transform → Store → Retrieve → Transform → Display
```

For each arrow, ask:
- What format is the data in?
- What could go wrong?
- Who is responsible for validation?

### Step 2: Identify Boundaries

| Boundary | Common Issues |
|----------|---------------|
| API ↔ Service | Type mismatches, missing fields |
| Service ↔ Database | Format conversions, null handling |
| Backend ↔ Frontend | Serialization, date formats |
| Component ↔ Component | Props shape changes |

### Step 3: Define Contracts

For each boundary:
- What is the exact input format?
- What is the exact output format?
- What errors can occur?

---

## Common Cross-Layer Mistakes

### Mistake 1: Implicit Format Assumptions

**Bad**: Assuming date format without checking

**Good**: Explicit format conversion at boundaries

### Mistake 2: Scattered Validation

**Bad**: Validating the same thing in multiple layers

**Good**: Validate once at the entry point

### Mistake 3: Leaky Abstractions

**Bad**: Component knows about database schema

**Good**: Each layer only knows its neighbors

### Mistake 4: Dropping Relationship Metadata at a Boundary

**Bad**: A source transcript contains a parent/child identifier, but the
parser, catalog schema, or frontend normalizer omits it; the UI then falls
back to a path convention that only works for one provider.

**Good**: Treat relationship metadata as part of the session summary
contract. Trace it through source parsing, cache/catalog persistence, API
serialization, frontend normalization, and tree construction. Keep provider
specific path inference only as an explicit compatibility fallback.

### Mistake 5: Letting a drag source resolve its target terminal path

**Bad**: A file source panel inserts one relative path string itself. A different project, Worktree, SSH host, or remote root terminal then cannot distinguish the source filesystem location.

**Good**: The source creates `TerminalFileDragPayload { text, absolutePath, source }`; the registered terminal drop zone delivers that payload to `useTerminalInput`, which compares source and target locations before choosing relative text or absolute fallback. All source panels share `useTerminalFilePointerDrag`; only the target owns the location decision.

### Mistake 6: Misclassifying local persistence contention as a remote failure

**Bad**: A Tauri command reserves or updates a shared SQLite row with a
deferred read-then-write transaction. When another supported app process owns
the writer slot, the command forwards `database is locked` into a generic UI
fallback that asks the user to check a Provider, model, or network.

**Good**: At the database ownership boundary, choose the transaction mode and
bounded busy timeout deliberately. A short read-then-write mutation on the
shared main database acquires `BEGIN IMMEDIATE` before reading, maps SQLite
busy/locked codes to one stable local-persistence error, and lets the frontend
render a separate localized retry message. Do not change the supported
production-plus-development shared-data contract merely to hide contention.

### Mistake 7: Treating a WebView Promise as sufficient async isolation

**Bad**: The frontend calls `invoke(...)` without awaiting it in an event
handler, but the Rust entrypoint is a synchronous `#[tauri::command] fn` that
uses `tauri::async_runtime::block_on` for a multi-second HTTP/SQLx operation.
The renderer-facing Promise does not change the command macro's blocking
execution context, so the application can still appear frozen.

**Good**: Make the long-running entrypoint a Tauri `async fn`. If an existing
helper future is non-`Send`, let the async command await a dedicated
`tauri::async_runtime::spawn_blocking` worker that owns the `block_on`; never
put that wait back in the synchronous IPC handler. Keep the command name and
payload stable, retain the existing pending/duplicate guard, and add a
source-level regression assertion for the execution boundary.

### Mistake 8: Using a terminal IPC response as the loading signal

**Bad**: A store keeps a non-reactive duplicate-request `Map`, while a component
only displays loading when terminal metadata returned by `await invoke(...)`
contains `state: "pending"`. A one-shot command that returns only after a slow
Provider call then gives the user no feedback between click and completion.

**Good**: When an action accepts a request, publish a non-persistent,
session/resource-keyed in-flight state before any detail load or IPC wait.
Combine it with persisted pending metadata in every affected view, disable
duplicate actions, and clear it only if the same request still owns that key.
Do not invent terminal data or persist the visual state merely to render a
spinner.

---

## Checklist for Cross-Layer Features

Before implementation:
- [ ] Mapped the complete data flow
- [ ] Identified all layer boundaries
- [ ] Defined format at each boundary
- [ ] Decided where validation happens
- [ ] When file-type eligibility is duplicated across frontend, local backend, and remote agent, did every classifier agree and receive a regression test for ambiguous extensions?

After implementation:
- [ ] Tested with edge cases (null, empty, invalid)
- [ ] Verified error handling at each boundary
- [ ] Checked data survives round-trip
- [ ] For parent/child data, verified the relationship survives source file → parser → catalog/cache → API → frontend tree
- [ ] For a shared SQLite read-then-write path, verified write-lock acquisition, a bounded busy wait, stable busy/error mapping, and a UI message that does not blame an unrelated remote dependency.
- [ ] For a Tauri command that can await a slow network or database operation, verified both the WebView call and the Rust command execution context are asynchronous; a non-`Send` helper is isolated on a dedicated blocking worker.
- [ ] For a one-shot long-running IPC request, verified the UI has an observable in-flight state before terminal response metadata is available, and that a superseded request cannot clear a newer action's feedback.

---

## Cross-Platform Template Consistency

In Trellis, command templates (e.g., `record-session.md`) exist in **multiple platforms** with identical or near-identical content. This is a cross-layer boundary.

### Checklist: After Modifying Any Command Template

- [ ] Find all platforms with the same command: `find src/templates/*/commands/trellis/ -name "<command>.*"`
- [ ] Update all platform copies (Markdown `.md` and TOML `.toml`)
- [ ] For Gemini TOML: adapt line continuations (`\\` vs `\`) and triple-quoted strings
- [ ] Run `/trellis:check-cross-layer` to verify nothing was missed

**Real-world example**: Updated `record-session.md` in Claude to use `--mode record`, but forgot iFlow, Kilo, OpenCode, and Gemini — caught by cross-layer check.

---

## Generated Runtime Template Upgrade Consistency

Some generated files are both documentation and runtime input. In Trellis,
`.trellis/workflow.md` is parsed by `get_context.py`, `workflow_phase.py`,
SessionStart filters, and per-turn hooks. Template changes must be validated
against both fresh init and upgrade paths.

### Checklist: After Modifying A Runtime-Parsed Template

- [ ] Identify every runtime parser that reads the template, not just the file
  writer that installs it
- [ ] Check whether relevant syntax lives outside obvious managed regions
  such as tag blocks
- [ ] Verify fresh `init` output and a versioned `update` scenario that writes
  the older `.trellis/.version`
- [ ] Add an upgrade regression using an older pristine template fixture, then
  assert the installed file reaches the current packaged shape
- [ ] Update the backend spec that owns the runtime contract

**Real-world example**: Codex inline mode changed workflow platform markers from
`[Codex]` / `[Kilo, Antigravity, Windsurf]` to `[codex-sub-agent]` /
`[codex-inline, Kilo, Antigravity, Windsurf]`. Fresh init was correct, but
`trellis update` only merged `[workflow-state:*]` blocks and preserved stale
markers outside those blocks. Result: upgraded projects got new hook scripts
but old workflow routing, so `get_context.py --mode phase --platform codex`
could return empty Phase 2.1 detail.

---

## Mode-Detection Probe Checklist

When a CLI auto-detects a mode by probing a remote resource (e.g., checking if `index.json` exists to decide marketplace vs direct download):

### Before implementing:
- [ ] Probe runs in **ALL** code paths that use the result (interactive, `-y`, `--flag` combos)
- [ ] 404 vs transient error are distinguished — don't treat both as "not found"
- [ ] Transient errors **abort or retry**, never silently switch modes
- [ ] Shared state (caches, prefetched data) is **reset** when context changes (e.g., user switches source)
- [ ] **Shortcut paths** (e.g., `--template` skipping picker) must have the same error-handling quality as the probed path — check that downstream functions don't call catch-all wrappers

### After implementing:
- [ ] Trace every path from probe result to the mode-decision branch — no fallthrough
- [ ] External format contracts (giget URI, raw URLs) are tested or at least documented as comments
- [ ] Metadata reads consume a complete response or use a streaming parser — never parse a fixed-size prefix as full JSON
- [ ] When reconstructing a composite identifier from parsed parts, verify **all** fields are included and in the **correct position** (e.g., `provider:repo/path#ref` not `provider:repo#ref/path`)
- [ ] Verify that **action functions** called after a shortcut don't internally use the old catch-all fetch — they must use the probe-quality variant when error distinction matters

**Real-world example**: Custom registry flow had 8 bugs across 3 review rounds: (1) probe only ran in interactive mode, (2) transient errors fell through to wrong mode, (3) giget URI had `#ref` in wrong position, (4) prefetched templates leaked across source switches, (5) `--template` shortcut bypassed probe but `downloadTemplateById` internally used catch-all `fetchTemplateIndex`, turning timeouts into "Template not found".

**Real-world example**: Agent-session update hints fetched npm `latest` metadata with `response.read(4096)` and then parsed it as complete JSON. The `@mindfoldhq/trellis` package metadata exceeded 4 KB, so the JSON was truncated, parse failed silently, and the first session injection showed no update hint. Fix: read the complete response before parsing, and add a regression where `version` is followed by an 8 KB metadata tail.

---

## When to Create Flow Documentation

Create detailed flow docs when:
- Feature spans 3+ layers
- Multiple teams are involved
- Data format is complex
- Feature has caused bugs before
