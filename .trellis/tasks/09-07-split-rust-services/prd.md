# Split Rust history and services

## Goal

Split Rust history and services

## Requirements

- Split history parsing/discovery/statistics and cc-connect service responsibilities into named modules below 2000 physical lines.
- Keep original Tauri command registration, wire signatures, serde fields, persistence keys, process ownership and storage behavior.
- Split tests by domain, retain all assertions and shared fixtures; no arbitrary numbered chunks.

## Acceptance Criteria

- [ ] Every handwritten Rust source remains below the hard limit after formatting.
- [ ] Desktop and SSH Agent tests pass without reduced coverage; normal/test compilation has no new warnings.
- [ ] Architecture baseline only shrinks, and TEMP change records describe the actual scope.

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
