# SSH remote file panel

## Goal

Read-only remote tree/search/preview provider and sidebar routing with path confinement.

## Requirements

- Provide a read-only SSH file provider rooted at the project remote path.
- Support lazy directory paging, refresh, filename search, bounded content search, text/image preview, and path copy.
- Route sidebar open-folder and history/diff file references to the remote provider.
- Reject create, rename, delete, move, paste, save, drag, external opener, and Worktree operations.

## Acceptance Criteria

- [ ] Traversal, absolute child path, NUL/newline, symlink escape, size, MIME, timeout, and permission tests pass.
- [ ] Local filesystem commands are never called for SSH projects.
- [ ] Tree operations reuse the Host bridge and stale state is explicit on disconnect.
- [ ] Existing local/WSL file panel behavior remains unchanged.

## Notes

- Depends on `07-19-ssh-agent-bridge-runtime`.
