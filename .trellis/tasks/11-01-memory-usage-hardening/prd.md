# Full project memory and usability hardening

Source: docs/analysis/memory-and-usage-audit-2026-11-01.md. Task creation and implementation approved by the user's request to proceed with the recommended Trellis tasks and fully repair the findings. Version: TEMP.

## Requirements

- Bound replay residency across sessions; load snapshot patches only when needed, with readable failures and retry.
- Keep expensive system sampling off the GUI thread and avoid duplicated background inventory requests or false zero-task states.
- Bound daemon memory on storage failure, count checkpoints, and reduce spool read/write amplification without silently losing output.
- Reduce unnecessary emoji/capability/editor/terminal/history residency without losing dirty edits, terminal replay, input modes, search navigation, or recovery.
- Enforce text limits against bytes actually read, retaining the normal 1 MiB preview policy and a separate safe 4 MiB replay policy.

## Acceptance

- Scoped synthetic regressions verify each changed boundary; no real disk-full/OOM or reads of user history/terminal content.
- Cross-layer type/compile and standalone strict architecture checks pass; source files remain below 2000 lines.
- Existing annotations, session persistence, worktree/WSL/SSH behavior and bilingual copy remain intact.
- Record completed source checks separately from installed-app, long-run and GUI acceptance; never equate a partial implementation with full closure.
- No dependencies, migrations, installation replacement, version bump, commit or release.
