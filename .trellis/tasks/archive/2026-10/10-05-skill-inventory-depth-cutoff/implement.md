# Implementation plan

- Add bounded local traversal state, retaining the existing inventory error codes and outer API.
- Mirror classification and soft/hard cutoff semantics in WSL Python; keep partial entries on truncation.
- Add Rust regressions and direct embedded-Python tests.
- Run focused tests, architecture gates and affected-package compilation where dependencies permit.
- Document exact commands and platform/build gaps; never label isolated-function checks as full desktop acceptance.
- Update V1.4.2 changelog and the existing Skills feature-list section.
- Review diff for unexpected files and secrets before commit/fork/PR. PR publication needs owner confirmation.

## Maintainer review fixes (2026-10-08)

The maintainer requested both P2 fixes, conflict resolution and a push to the existing PR; publication is authorized for that branch.

1. Add failing regressions for vanished entries, lazy iterator budgets, exhausted child-directory opening, metadata reuse and real access errors.
2. Replace eager WSL enumeration with budgeted `scandir`; align native pre-enumeration limits and disappearance handling without changing public IPC.
3. Run focused embedded-Python and Rust inventory tests, compare scanning cost on disposable wide-directory fixtures, and run required compilation/architecture checks.
4. Merge current upstream master, resolve CHANGELOG by preserving both feature sections under V1.4.2, and review the final diff against upstream.
5. Record exact validation and platform gaps, commit, push without force to the existing PR branch, and verify remote head and conflict status.

Rollback: revert the dedicated fix commit on the PR branch; preserve the upstream merge and never rewrite published history or modify user Skill caches.
