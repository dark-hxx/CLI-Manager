# SSH remote resume workflow

## Goal

Remote session resume preflight, ownership, original cwd/config root routing, and terminal creation.

## Requirements

- Resume a selected SSH history session on the same validated machine, user, source, and config root.
- Preflight session existence, cwd, ownership, active-session collision, Host binding, and source capability.
- Create a new interactive SSH PTY for resume; history browsing itself must reuse the bridge/cache.
- Support original remote location when the project no longer exists but the Host identity remains valid.

## Acceptance Criteria

- [ ] Claude and Codex resume commands safely inject the captured config root.
- [ ] Same-client active session jumps to its existing Tab; other-client ownership blocks first delivery.
- [ ] Deleted project, deleted Host, changed machine, missing original session, and Hook-absent cases are tested.
- [ ] Remote cwd is never sent to local/WSL terminal or local opener APIs.

## Notes

- Depends on `07-19-ssh-remote-history-indexing`.
