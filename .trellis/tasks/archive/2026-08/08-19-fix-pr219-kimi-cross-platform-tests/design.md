# Technical Design — PR #219 Kimi Cross-Platform Test Repairs

## Boundaries and Root Causes

### Frontend source-text boundary

`scripts/kimiHookFrontend.test.mjs` reads a TypeScript source file as text and
extracts one function with a regular expression.  Git's Windows CRLF checkout
conversion happens before that extractor, while the expression requires LF-only
function delimiters.  Normalize CRLF to LF immediately after reading the source;
the extracted TypeScript and the production `mapCliHookEvent` function remain
unchanged.

### Host-test versus remote-Agent runtime boundary

The SSH Agent's `validate_canonical_path` deliberately admits only absolute
POSIX-style paths and rejects backslashes.  The Agent is built and distributed
for Linux x64/arm64.  The Kimi plan test constructs a real host temporary path,
so it is meaningful only on Unix.  Apply `#[cfg(unix)]` to that test and to the
two Kimi helpers used only by Unix tests.  Do not weaken the runtime validator.

### Git integration boundary

The fork head branch has a known `CHANGELOG.md` conflict against the base
branch.  This repair deliberately does not rebase or merge: it creates a
reviewable fix commit on the fork head branch first.  Base synchronization and
conflict resolution remain a post-review, user-directed operation.

## Change Set

| File | Change | Why |
| --- | --- | --- |
| `scripts/kimiHookFrontend.test.mjs` | Normalize CRLF before regex extraction. | Makes the focused test checkout-format independent. |
| `src-tauri/ssh-agent/src/hook_config.rs` | Gate the POSIX-only Kimi planner test and its helper imports. | Keeps Linux-path coverage while allowing Windows host tests to pass. |
| `CHANGELOG.md` | Add a V1.3.7 Kimi validation repair note. | Required release record. |
| `docs/功能清单.md` | Add the corresponding Kimi Hook test-compatibility statement. | Required feature inventory record. |
| `.trellis/tasks/08-19-fix-pr219-kimi-cross-platform-tests/` | Planning and validation record. | Trellis task traceability. |

## Compatibility and Safety

- CRLF and LF checkouts produce the same extracted test module.
- Unix continues to execute the remote Agent planner test; Windows does not
  attempt to validate a Windows temporary path as a remote Linux configuration
  root.
- No persisted settings, IPC fields, Hook commands, or production path
  validation behavior changes.

## Rollback

The implementation will be a focused commit on the fork branch.  Reverting that
commit restores the former test behavior without data migration or runtime
state recovery.
