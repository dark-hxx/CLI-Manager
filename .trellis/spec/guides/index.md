# Thinking Guides

> **Purpose**: Expand your thinking to catch things you might not have considered.

---

## Why Thinking Guides?

**Most bugs and tech debt come from "didn't think of that"**, not from lack of skill:

- Didn't think about what happens at layer boundaries → cross-layer bugs
- Didn't think about code patterns repeating → duplicated code everywhere
- Didn't think about edge cases → runtime errors
- Didn't think about future maintainers → unreadable code

These guides help you **ask the right questions before coding**.

---

## Available Guides

| Guide | Purpose | When to Use |
|-------|---------|-------------|
| [Fix Triage Guide](./fix-triage-guide.md) | Triage: minimal fix vs root-cause fix; scenario-enumeration gate for new features / root causes | **Before every bug fix or new feature — pass this gate first** |
| [Code Reuse Thinking Guide](./code-reuse-thinking-guide.md) | Identify patterns and reduce duplication | When you notice repeated patterns |
| [Cross-Layer Thinking Guide](./cross-layer-thinking-guide.md) | Think through data flow across layers | Features spanning multiple layers |
| [Cross-Platform Thinking Guide](./cross-platform-thinking-guide.md) | Check platform-specific process and terminal behavior | Windows, WSL, Bash, or other platform-dependent behavior |
| [Task Delivery Checklist](./task-delivery-checklist.md) | Enforce repo-specific start/finish delivery rules | Before any file-writing task and before final commit |
| [Tauri User File Security Checklist](./tauri-user-file-security-checklist.md) | Verify boundary defenses on user paths and asset/fs scopes | Adding a Tauri command that accepts a path, or broadening assetProtocol/fs scope |
| [Version Update Checklist](./version-update-checklist.md) | Keep npm/Tauri/Rust versions aligned and verify updater release signing/artifacts | Before bumping or tagging CLI-Manager release version |

---

## Quick Reference: Thinking Triggers

### First Decision: Minimal Fix or Root-Cause Fix? (before any bug fix / new feature)

- [ ] Task is "fix a bug / fix an issue" → run the triage test first, don't rush to edit
- [ ] Task is "add a feature / requirement" → enumerate scenarios first, don't build only the happy path
- [ ] You feel the urge to "wrap it in a try/catch / add a fallback" at the error site
- [ ] The bug only reproduces under a specific state (focus, split pane, WSL, Worktree, hook installed or not…)

→ Read [Fix Triage Guide](./fix-triage-guide.md) (entry gate; points back to the two guides below for depth)

### When to Think About Cross-Layer Issues

- [ ] Feature touches 3+ layers (API, Service, Component, Database)
- [ ] Data format changes between layers
- [ ] Multiple consumers need the same data
- [ ] You're not sure where to put some logic

→ Read [Cross-Layer Thinking Guide](./cross-layer-thinking-guide.md)

### When to Think About Code Reuse

- [ ] You're writing similar code to something that exists
- [ ] You see the same pattern repeated 3+ times
- [ ] You're adding a new field to multiple places
- [ ] **You're modifying any constant or config**
- [ ] **You're creating a new utility/helper function** ← Search first!

→ Read [Code Reuse Thinking Guide](./code-reuse-thinking-guide.md)

### When to Think About Task Delivery

- [ ] You're about to edit files after spending time away from the repo
- [ ] The task changes user-visible behavior or internal workflow behavior
- [ ] The user cited a GitHub issue and wants the commit to be traceable
- [ ] The task changes product functionality and may affect the feature inventory

→ Read [Task Delivery Checklist](./task-delivery-checklist.md)

### When to Think About Tauri File-Boundary Security

- [ ] Adding a `#[tauri::command]` whose argument is a path or contains a path fragment
- [ ] Broadening `assetProtocol.scope` or any `fs:scope` block
- [ ] Adding a new `fs:*` permission to `capabilities/*.json`
- [ ] Storing a user-picked file path in `settings.json` or SQLite
- [ ] Loading a local file in the WebView via `convertFileSrc`

→ Read [Tauri User File Security Checklist](./tauri-user-file-security-checklist.md)

---

## Pre-Modification Rule (CRITICAL)

> **Before changing ANY value, ALWAYS search first!**

```bash
# Search for the value you're about to change
grep -r "value_to_change" .
```

This single habit prevents most "forgot to update X" bugs.

---

## How to Use This Directory

1. **Before coding**: Skim the relevant thinking guide
2. **During coding**: If something feels repetitive or complex, check the guides
3. **After bugs**: Add new insights to the relevant guide (learn from mistakes)

---

## Contributing

Found a new "didn't think of that" moment? Add it to the relevant guide.

---

**Core Principle**: 30 minutes of thinking saves 3 hours of debugging.
