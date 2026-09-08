# Repair and merge PR 252

## Goal

Repair and merge PR 252

## Requirements

- Merge PR #252 with current master, preserving SFTP and terminal layout contracts.
- Repair protocol capabilities, SQLite readiness, Git restore refs and dialog safety.

## Acceptance Criteria

- [x] Conflict repair pushed without force and PR merged through GitHub CLI at 78cd43ed.
- [x] Desktop Rust 1237 passed/1 ignored, Agent 97 passed; targeted frontend/static/build checks completed.
- [x] Existing mainline length-test failure and remaining manual checks documented in docs/AI架构治理验收.md; the editor responsibility failure was subsequently fixed by the parent refactor.

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
