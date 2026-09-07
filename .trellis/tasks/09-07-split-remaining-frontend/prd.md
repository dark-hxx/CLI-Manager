# Split remaining frontend features

## Goal

Split remaining frontend features

## Requirements

- Split Hook settings, sidebar and history store into named responsibilities below 2000 physical lines.
- Move extracted feature ownership into populated feature directories with narrow entries and compatibility facades.
- Preserve hook order, Zustand state identity/actions, callbacks, i18n values and DOM/CSS behavior.

## Acceptance Criteria

- [ ] Frontend targets and extracted modules satisfy physical/long-line limits.
- [ ] TypeScript, targeted behavior/source tests and production build pass.
- [ ] TEMP records and architecture baseline accurately track the shrinking debt.

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
