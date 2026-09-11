# Implementation plan

1. Implement pure selection/batch helpers with executable Node tests.
2. Extend store selection, scoped clipboard, batch execution, dirty protections, mutation/refresh coordination and conflict results.
3. Wire tree and both search views, menus, keyboard and pointer/native dragging; translate all new labels.
4. Add narrowly scoped backend delete/move link guard and regression tests.
5. Run focused behavioral and existing regressions, TypeScript, frontend production build and targeted Rust checks. Review full diff against artifacts.
6. Update project-file contract, CHANGELOG and feature list; produce verification report and manual checklist.
7. The user authorized a public PR on 2026-09-10. Port only the feature delta to a separate contribution branch based on upstream master; retain the shared pointer-drag hook and upstream layout. Do not alter the user's existing checkout or installation.
8. Re-run focused tests, strict architecture, TypeScript/build and Rust checks on the contribution branch. Review the explicit staged paths, commit, push to the existing contribution fork and create the PR. Do not include local deployment paths, hashes, process IDs, logs or binaries.
