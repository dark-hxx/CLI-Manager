# Fix command template submission in Codex

## Goal

Running a saved command template submits once in Codex instead of inserting a
newline, without regressing Claude Code or ordinary shells.

## Requirements

- Cover both the terminal template panel and the global command palette.
- Preserve template contents, substitutions, scopes and the selected session.
- Keep physical keyboard input, startup commands and PTY wire protocols unchanged.
- Do not add CLI-name heuristics, fixed delays, retries or dependencies.
- Rebuild the local macOS application for user acceptance; do not terminate live sessions.

## Acceptance Criteria

- [x] Reproduce the old behavior without sending prompts to a model.
- [x] Both template execution entry points use the same submission boundary.
- [x] Respect the target terminal's current bracketed-paste mode and xterm normalization.
- [x] Cover multiline/Unicode text, ordinary shells, session switching, disposal and write errors.
- [x] Pass targeted tests, TypeScript and the independent strict architecture check.
- [x] Produce and verify an ad-hoc-signed local macOS app.
- [x] Update the changelog and command-template feature inventory.

## Notes

- User explicitly authorized task creation, repair and rebuilding on 2026-10-24.
- Changelog version requested; use TEMP unless the user specifies a version.
