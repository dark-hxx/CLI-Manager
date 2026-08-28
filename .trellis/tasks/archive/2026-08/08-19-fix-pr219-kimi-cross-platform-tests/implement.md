# Implementation Plan — PR #219 Kimi Cross-Platform Test Repairs

## Preconditions

- Work only in the clean isolated checkout of
  `kcng0/CLI-Manager:agent/kimi-code-cli-hooks`.
- Preserve all unrelated local changes in the original `master` worktree.
- Do not rebase or merge the PR branch in this task.

## Ordered Steps

1. Change the frontend test reader to normalize CRLF prior to function matching;
   immediately run `node scripts/kimiHookFrontend.test.mjs`.
2. Mark the remote Kimi planner test and its Unix-only helper imports with
   `#[cfg(unix)]`; immediately run the SSH Agent's focused test suite on the
   Windows host.
3. Add concise V1.3.7 repair records to `CHANGELOG.md` and the existing
   Kimi Hook section of `docs/功能清单.md`.
4. Run the full planned validation set, inspect the diff, run GitNexus
   `detect_changes`, commit with `Refs #219`, and push to the fork source
   branch.  Then request a fresh PR review; do not rebase or merge.

## Validation

```powershell
node scripts/kimiHookFrontend.test.mjs
cargo test --manifest-path src-tauri/ssh-agent/Cargo.toml
npx tsc --noEmit
cargo fmt --manifest-path src-tauri/ssh-agent/Cargo.toml --check
git diff --check
```

Run GitNexus `detect_changes` before committing.  A merge-tree check and
base-branch synchronization are explicitly deferred to the post-review stage.

## Risks and Checks

- The known base-branch `CHANGELOG.md` conflict remains deferred.  Do not
  resolve it as part of this repair commit.
- The host test passing must not be achieved by allowing a Windows path through
  the remote Agent's canonical-path validator.
- Do not claim real Kimi CLI or desktop UI validation; those remain manual
  environment checks outside this repair.
