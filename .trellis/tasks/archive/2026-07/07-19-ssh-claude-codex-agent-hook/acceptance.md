# SSH Agent Hook Acceptance

## Stage Commits

| Stage | Commit | Scope |
| --- | --- | --- |
| S06 | `34ba3f8` | Remote history indexing, catalog cache, pagination, detail chunks, offline state |
| S07 | `3ab7a1b` | Same-source Claude/Codex resume, identity/cwd preflight, ownership |
| S08 | `25d0055` | Read-only remote files, bounded search/preview, path confinement |
| S09 | `cd618d4` | Read-only remote Git repository/status/diff/branches/upstream |
| S10 | `7281494` | Remote realtime stats, catalog usage fallback, docs and security review |

## Automated Evidence

- Agent tests: `58 passed`.
- Agent Clippy: `-D warnings`, clean.
- Desktop library tests: `620 passed, 1 ignored`.
- `npx tsc --noEmit`: clean.
- Both Rust crates: `cargo fmt --check` clean.
- `git diff --check`: clean.
- GitNexus staged audits completed for S08, S09, and S10; HIGH scope was expected for shared file/Git panels and was reviewed.

## Manual Verification Matrix

1. Configure an SSH Host and explicitly install/inspect the Agent and Claude/Codex Hook. Opening settings alone must not connect or mutate the remote host.
2. Open an SSH project with the file panel. Verify lazy directory expansion, filename/code search, UTF-8 text preview, image preview, remote path copy, and history-to-file navigation.
3. Verify SSH file menus do not expose save, create, rename, delete, paste/move, drag, system Explorer/Finder, or local watcher actions. Calling the store methods directly must return `remote_project_read_only`.
4. Open the SSH Git panel. Verify repository selection, status, conflict/untracked labels, bounded Diff, branch list, upstream, ahead/behind, and an `asOf` timestamp.
5. Verify remote Git exposes no stage, commit, discard, checkout, branch creation, pull, push, fetch, Worktree, credential, external diff, or textconv action. Direct store calls must return `remote_git_read_only`.
6. Open SSH terminal statistics. Verify the active session detail and today usage update through one Agent history consumer; disconnect the bridge and verify the last snapshot remains visible with stale/offline behavior rather than falling back to local paths.
7. Switch between local, WSL, and SSH projects, multiple windows, split panes, minimized/focused states, Worktrees, and Claude/Codex. Local and WSL file/Git/history behavior must remain unchanged.
8. Switch `zh-CN`/`en-US` in Settings and verify new read-only labels, errors, Git/Stats states, and 24-hour timestamps are localized.

## Security Boundaries

- Remote file and Git RPCs accept only canonical root plus confined relative paths; symlink escapes, traversal, NUL/CR/LF, oversized files, oversized Diff, and excessive traversal/results are rejected.
- Remote Git uses fixed allowlisted read commands with optional locks, fsmonitor, external diff, and textconv disabled. No arbitrary argv, network, credential helper, or Worktree operation is exposed.
- Remote paths remain opaque references and never enter local filesystem, local Git, Worktree, provider, edit, delete, or Explorer APIs.
