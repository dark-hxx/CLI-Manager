# Integrate PR 252 and restructure for AI development

## Goal

Repair and merge PR #252, then split all tracked handwritten source files over 2000 lines into feature-first modules with architecture governance optimized for AI token usage.

## Requirements

- Integrate PR #252 in full with a merge commit while preserving current `master` behavior.
- Repair SSH-agent protocol compatibility, SQLite schema readiness, Git mutation safety,
  accessibility, and missing high-risk tests before merging the PR.
- Reorganize tracked handwritten application source by feature, keeping IPC, persistence,
  event, i18n, styling, and public module contracts stable.
- Split every tracked handwritten source file above 2,000 physical lines; target 400-1,200
  lines for normal modules and reject compressed giant logic lines.
- Add independent architecture check and report commands optimized for concise AI output.
- Record code changes under `TEMP` in `CHANGELOG.md` and `docs/功能清单.md`.

## Acceptance Criteria

- [x] PR #252 is conflict-free, repaired, tested, pushed without force, and merged via GitHub CLI.
- [x] SSH Agent 0.1.14 / protocol 1.15 preserves protocol 1.14 SFTP behavior and gates Git capabilities.
- [x] SQLite usage schema readiness cannot skip required columns, indexes, views, or marker repair.
- [x] Destructive Git operations have explicit confirmation/safety behavior and regression coverage.
- [x] All tracked handwritten application source files are at most 2,000 physical lines.
- [x] Feature-first dependency rules and long-line rules are executable through npm scripts.
- [x] TypeScript, Rust workspace, SSH-agent, targeted tests, and architecture checks pass.
- [x] Trellis tasks, changelog, and feature inventory accurately describe the delivered result.

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
