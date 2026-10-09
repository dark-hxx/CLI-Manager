# Root cause and bounded design

## Root-cause statement

Filesystem inventory checks depth before classifying ordinary files, then propagates a deep child's limit through `?`; one deep irrelevant branch aborts all remaining sibling discovery. The review also found that the WSL producer treats a vanished enumerated file as a fatal subprocess failure and materializes whole directories before the path-budget check. Both fixes belong in the traversal producer, not the frontend warning.

## Impact analysis

The original author lacked GitNexus. During maintainer review its index was refreshed, but FTS was unavailable and context/impact still could not resolve the inventory symbols. Use the fallback explicitly allowed by fix-triage-guide: extensions-management-contracts, exact symbol references and Git diff; do not interpret unresolved symbols as zero impact.

- `scan_local` -> `inspect` -> `extensions_skills_inventory` -> Skill inventory consumers: preserve entries/warnings public shape.
- `scan_wsl` / `WSL_SCAN` are sibling implementations: align traversal and retain partial entries through the private subprocess result.
- Existing native/plugin/builtin tests and new regression tests: affected.
- Inventory UI completeness/protected operations: unchanged contract; warnings remain for actual truncation.
- Skill import/deployment/uninstall, DB ownership, credentials, terminal Hooks, cc-connect: unrelated and unchanged.

Risk: localized filesystem traversal change, medium. Continuing siblings must not create unbounded work. Keep maximum depth 8, maximum entries 500, no link recursion, WSL 15-second/1-MiB process bounds; introduce a 10,000-path per-root work budget. Do not indiscriminately exclude node_modules, which might contain a legitimate Skill.

## Design

Classify ordinary files before the depth cutoff. Treat directory depth cutoff as soft truncation and continue bounded siblings. Treat path/entry budgets as hard stops. The local wrapper returns the existing limit code after a partial traversal so outer inventory preserves entries plus a warning.

The WSL subprocess returns a private `{entries, limited}` envelope rather than discarding partial entries through process failure. Filesystem failures still fail; the public IPC shape does not change. Missing paths and directories replaced by ordinary files during traversal are stale enumeration entries, so skip them and continue. Permission and other I/O failures remain errors.

Use a context-managed `os.scandir` iterator in WSL, checking capacity before opening it and before every `next`. Reuse `DirEntry` file-kind information so ordinary files do not require separate lexists/isdir/islink probes. Never sort or collect all filesystem entries; the existing Rust inventory aggregation owns presentation sorting. An exhausted hard budget conservatively reports an incomplete scan without peeking at another entry. Keep native `ReadDir` equally lazy, and align its missing-path handling and pre-enumeration checks.

Refresh directory candidates with `lstat` before inspecting/traversing them so a cached directory type cannot conceal a replacement symlink. Ordinary files retain the cached fast path. A mocked fresh-link metadata regression verifies this boundary without claiming real POSIX or privileged Windows symlink acceptance.

WSL keeps only depth-bounded iterators and at most 500 result records; the native visited set is bounded by the 10,000-path budget. Traversal includes the root in that budget. OS directory buffering is implementation-dependent, but application-level iterator advancement must stay within the remaining budget. Tests count actual iterator advances/opens and metadata probes, not only the returned `limited` flag. Include removal between enumeration/classification, removal before opening a directory, permission errors, exact limits, nested exhausted budgets and iterator cleanup.

## Scenarios

Native Windows: ordinary file, nested plugin/builtin, valid depth-eight Skill, over-depth directory/Skill, output/path bounds, missing root, disappearing children, directory links. WSL: same embedded Python logic, lazy wide-directory enumeration, removal/replace races and unreadable directories; real distro transport remains separately unverified because WSL is not installed on the maintainer host. Enumeration order is filesystem-owned; final inventory sorting remains stable. Worktree .git files are ordinary files. Window focus/tray/panes/Hooks do not affect filesystem scan and are confirmed unrelated. Native install/uninstall, SQLite ownership, provider configuration, credentials and terminal processes are confirmed unrelated.
