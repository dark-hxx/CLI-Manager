# Code Reuse Thinking Guide

> **Purpose**: Stop and think before creating new code - does it already exist?

---

## The Problem

**Duplicated code is the #1 source of inconsistency bugs.**

When you copy-paste or rewrite existing logic:
- Bug fixes don't propagate
- Behavior diverges over time
- Codebase becomes harder to understand

---

## Before Writing New Code

### Step 1: Search First

```bash
# Search for similar function names
grep -r "functionName" .

# Search for similar logic
grep -r "keyword" .
```

### Step 2: Ask These Questions

| Question | If Yes... |
|----------|-----------|
| Does a similar function exist? | Use or extend it |
| Is this pattern used elsewhere? | Follow the existing pattern |
| Could this be a shared utility? | Create it in the right place |
| Am I copying code from another file? | **STOP** - extract to shared |

---

## Common Duplication Patterns

### Pattern 1: Copy-Paste Functions

**Bad**: Copying a validation function to another file

**Good**: Extract to shared utilities, import where needed

### Pattern 2: Similar Components

**Bad**: Creating a new component that's 80% similar to existing

**Good**: Extend existing component with props/variants

### Pattern 3: Repeated Constants

**Bad**: Defining the same constant in multiple files

**Good**: Single source of truth, import everywhere

### Pattern 4: Source-panel interaction lifecycles

**Problem**: Two panels can expose the same user action while each owns its own pointer threshold, preview, cleanup, and target delivery code. The behavior works initially, then one source silently misses later fixes.

**Good**: For application-internal file-to-terminal drags, every source panel must use `useTerminalFilePointerDrag`. The shared hook owns the pointer threshold, payload creation, rAF preview, terminal drop-zone commit, cleanup, and post-drag click suppression. Source panels provide only their `{ path, kind }` item and any source-specific non-terminal drop callback.

**Checklist**:

- [ ] When adding a new file-path source, enumerate existing source panels before adding handlers.
- [ ] Keep target path resolution in `useTerminalInput`; do not fork it per producer.
- [ ] Git Changes and File Explorer supply file/directory descriptors; File Explorer additionally supplies its tree-move callback and Git Changes supplies its active repository root.

---

## When to Abstract

**Abstract when**:
- Same code appears 3+ times
- Logic is complex enough to have bugs
- Multiple people might need this

**Don't abstract when**:
- Only used once
- Trivial one-liner
- Abstraction would be more complex than duplication

---

## File Size: Bounded Responsibility

Handwritten code has a **2000 physical-line hard limit**. Prefer 400–1200 lines for normal
modules and split along responsibility boundaries, never arbitrary numbered chunks.
See [AI Architecture Contracts](../frontend/ai-architecture-contracts.md) for the executable
check, temporary shrinking baseline, and AI reading/token workflow.

The real cost of a large file is **implicit coupling**, not reading effort: when 100 functions
share the same refs, closures, and effect dependencies in one module, changing one safely means
reasoning about all of them. That is exactly the "patch here, break there" risk the
[fix-triage-guide](./fix-triage-guide.md) §1 flags as a cross-boundary hazard.

### When a big file trips the signal, ask one question

**"Is this file doing several unrelated things, or one thing thoroughly?"**

| The file is… | Action |
|---|---|
| A **junk drawer** — rendering + IPC/PTY bridging + shortcuts + state sync tangled together | Consider splitting **along responsibility seams** — to decouple and reduce blast radius, not to shrink the number |
| **Cohesive** — single responsibility, clear state, rarely churns | Keep it cohesive below the hard limit; above it, extract named data, tests or sub-responsibilities while preserving the public entry |

### If you do split

- Split by **responsibility boundary**, never by line count.
- Don't create a `utils.ts` junk drawer — that hides coupling instead of removing it.
- This is a refactor: run `gitnexus_impact` first, and it needs its own task/approval — don't fold it into an unrelated change.

---

## After Batch Modifications

When you've made similar changes to multiple files:

1. **Review**: Did you catch all instances?
2. **Search**: Run grep to find any missed
3. **Consider**: Should this be abstracted?

---

## Gotcha: Asymmetric Mechanisms Producing Same Output

**Problem**: When two different mechanisms must produce the same file set (e.g., recursive directory copy for init vs. manual `files.set()` for update), structural changes (renaming, moving, adding subdirectories) only propagate through the automatic mechanism. The manual one silently drifts.

**Symptom**: Init works perfectly, but update creates files at wrong paths or misses files entirely.

**Prevention checklist**:
- [ ] When migrating directory structures, search for ALL code paths that reference the old structure
- [ ] If one path is auto-derived (glob/copy) and another is manually listed, the manual one needs updating
- [ ] Add a regression test that compares outputs from both mechanisms

---

## Checklist Before Commit

- [ ] Searched for existing similar code
- [ ] No copy-pasted logic that should be shared
- [ ] Constants defined in one place
- [ ] Similar patterns follow same structure
