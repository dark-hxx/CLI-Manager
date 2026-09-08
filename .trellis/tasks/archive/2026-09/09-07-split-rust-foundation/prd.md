# Split Rust app and infrastructure

## Goal

Split Rust app and infrastructure

## Requirements

- Bound Rust app/runtime, database repair and provider modules without changing public paths, IPC, storage or lifecycle.
- Separate test-only responsibilities first, then extract production responsibilities where still oversized.

## Acceptance Criteria

- [x] All affected source and test files are at most 2000 lines with named boundaries.
- [x] Existing desktop and Agent tests retain discovery/counts and pass; cargo check passes.

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
