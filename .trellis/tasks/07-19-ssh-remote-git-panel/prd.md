# SSH remote Git panel

## Goal

Read-only repository discovery, status, diff, branches, upstream and ahead/behind through Agent RPC.

## Requirements

- Deliver the read-only Git panel in first scope through Agent RPC.
- Support repository discovery, status, staged/unstaged/untracked/conflict/rename, diff, branches, upstream, ahead/behind, and `asOf`.
- Use stable repo IDs and fixed Agent commands; never accept arbitrary repository paths after discovery.
- Reject all mutation, network, credential, Worktree, external diff, and textconv operations.

## Acceptance Criteria

- [ ] Root, nested, `.git` file Worktree, no-Git, non-repo, dubious ownership, detached HEAD, and no-upstream cases pass.
- [ ] NUL porcelain parsing preserves spaces and Unicode paths.
- [ ] Diff size/binary/encoding/generation limits are tested.
- [ ] Existing local/WSL Git panel remains unchanged and SSH never invokes local Git.

## Notes

- Depends on `07-19-ssh-agent-bridge-runtime` and `07-19-ssh-remote-file-panel`.
