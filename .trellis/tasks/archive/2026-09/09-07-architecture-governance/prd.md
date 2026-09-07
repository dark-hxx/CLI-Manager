# Add AI architecture governance

## Goal

Add AI architecture governance

## Requirements

- Standalone check/report with no new dependencies and no build/startup hooks.
- 2000 physical-line limit, 500-character line guard, explicit generated exclusions.
- Temporary shrinking baseline and enforcement of new-layer import directions.

## Acceptance Criteria

- [x] Boundary tests pass; current debt is reported, not hidden.
- [x] AGENTS, shared guide and layer specs agree; TEMP records updated.

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
