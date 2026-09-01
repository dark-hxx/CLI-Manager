# Implementation plan

## Preconditions and review gates

- [x] Re-run and report the read-only branch/upstream check immediately before starting:
  `git status --short --branch`, `git branch -vv`, and
  `git rev-list --left-right --count 'HEAD...@{upstream}'`. Do not synchronize Git.
- [x] Keep the pre-existing `AGENTS.md`, `CLAUDE.md`, and
  `.trellis/tasks/08-31-terminal-scroll-to-bottom/` changes out of this task.
- [x] User reviews this `design.md` and `implement.md`; only then run
  `python ./.trellis/scripts/task.py start .trellis/tasks/08-31-ssh-terminal-paste-agent-only`.
- [x] Before each existing symbol edit, run GitNexus `impact` upstream and record the result.
  GitNexus FTS is currently unavailable, so use exact symbol context plus `rg` as the fallback
  and report any unavailable impact result. Stop and warn before a HIGH/CRITICAL edit.
- [x] After task start, read `trellis-before-dev/SKILL.md` and the injected frontend/backend
  specs before editing source.

## Ordered changes

1. [x] Add the shared frontend SSH attachment-root validator and extend `SshHost` input/output
   types. Add the Host editor field, form normalization, save validation, settings error
   mapping, and zh-CN/en-US labels, descriptions, placeholder, and context error text.
2. [x] Add SQLite migration 37 and migration tests. Update `sshHostStore` CRUD/load behavior and
   ensure imported Config aliases default the new field to empty.
3. [x] Extend `syncStore` portable Host select/column/restore paths. Sanitize missing or invalid
   imported roots to empty, while continuing to keep identity files, credentials, config files,
   and ProxyCommand machine-local.
4. [x] Refactor `sshAgentHistory` to share Agent resolution between project and Host launch
   builders. Add `buildSshAgentHostLaunch`, include the Host attachment root in the attachment
   launch type, and add focused builder tests if the current test setup supports them.
5. [x] Update `sshRemoteFiles` with session-scoped attachment context and optional
   `attachmentRoot` in both Tauri invokes. Update `useTerminalInput` image, clipboard-file,
   native drop, Tauri drop, and text-paste attachment paths to use the target session’s
   `sshHostId`/`remotePath`; remove only the attachment-time SSH Project prerequisite.
6. [x] Add the optional attachment-root parameter to desktop Rust attachment commands, validate it
   at the IPC boundary, include it in Begin payloads, and preserve any-file/legacy-image
   fallback and remote-path validation.
7. [x] Update daemon bridge capability handling and no-project Readonly bridge validation. Add
   regression tests proving custom-root requests are rejected before wire output when the
   capability is absent, while empty-root requests still use old capabilities.
8. [x] Update the remote Agent Begin request, custom-root resolver, managed namespace, symlink/path
   checks, cleanup boundary, capability advertisement, version/protocol constants, lockfile,
   and release identity tests. Add tests for namespace isolation, default compatibility, and
   invalid roots.
9. [x] Update `.trellis/spec/backend/ssh-agent-contracts.md` and the relevant section of
   `docs/功能清单.md`; add a versioned `V1.3.9` entry to `CHANGELOG.md`. Do not change unrelated
    SSH project, Hook, history, Git, local, or WSL documentation.

10. [x] Remove only the SSH Host list authentication badge and add a Host-scoped SFTP-style
    attachment dialog with local selection, remote attachment listing, and transfer queue.
11. [x] Add the optional Agent `fileAttachmentRoot` read request so the UI can discover the
    actual default/custom attachment directory without guessing remote HOME or XDG paths; keep
    uploads available when an older Agent lacks this optional capability.
12. [x] Add bilingual UI/error copy, update V1.3.9 changelog and feature inventory, and extend
    this task's scenario/acceptance notes without changing terminal or project binding rules.

## Required focused assertions

- [x] A Host-only SSH session with installed Agent uploads both an image and a regular file; the
  launch uses that session’s Host ID and remote path, empty project/tool fields, and returns an
  absolute Agent path.
- [x] Two Host IDs and two sessions do not share the configured root/session upload namespace;
  changing the selected project or pane does not change the target.
- [x] Empty Host root sends no custom-root directive and retains old Agent behavior. A configured
  root returns a path below its Agent-managed child namespace.
- [x] Invalid root forms (relative, `..`, control, backslash, shell-expansion markers, and symlink
  component) fail before remote upload; unrelated files in the configured parent survive Agent
  cleanup.
- [x] Old Agent behavior remains: default-root images can use legacy `fileAttach`; arbitrary files
  require `fileAttachAny`; custom-root requests produce an explicit upgrade error.
- [x] Local/WSL text, image, file, drag/drop, Worktree, and registered SSH project flows retain
  their existing target/path behavior.
- [x] Host list no longer renders auth mode; Host editor and OpenSSH auth behavior remain intact.
- [x] Each Host opens an isolated two-pane attachment dialog; selected local files upload through
  the installed Host Agent and appear in the transfer queue/remote listing without project IDs.

## Validation commands

Run from the repository root after implementation:

```powershell
npx tsc --noEmit
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo fmt --manifest-path src-tauri/ssh-agent/Cargo.toml -- --check
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/ssh-agent/Cargo.toml
cargo test --manifest-path src-tauri/ssh-agent/Cargo.toml
```

Also run exact `rg` checks for remaining project-only attachment guards and for both locale
keys. Run GitNexus `detect_changes()` before any commit; if the index remains unavailable,
record the failure and use the changed-symbol/static diff review as the fallback. Manually
switch Settings → General → Interface language between Chinese and English and confirm the
new Host field and paste errors render in both languages without changing 24-hour time output.

## Rollback points

- If migration or Host CRUD fails, stop before changing paste behavior; the additive column can
  remain unused and existing rows default to empty.
- If Agent protocol tests fail, keep the desktop custom-root field persisted but disable sending
  non-empty `attachmentRoot`; default-root uploads remain available while the Agent release is
  corrected.
- If session context tests fail, revert only the new Host-only attachment entry point and keep
  the Host setting/migration isolated; do not add a local-path fallback to SSH paste.
- Before handoff, inspect `git diff`/`git status` and verify unrelated working-tree changes are
  preserved.
