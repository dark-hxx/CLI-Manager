# Final architecture convergence

## Goal

Final architecture convergence

## Requirements

- Remove remaining long-line debt without changing literal values or JSX rendering.
- Complete feature-first ownership, narrow public entries and import rewrites across frontend and Rust while preserving package/process boundaries.
- Keep standalone architecture checks independent of build/dev, validate zero length debt and enforce real layer boundaries.
- Preserve IPC, persistence, i18n, stylesheet cascade and behavior; record human-only desktop validation separately.

## Acceptance Criteria

- [ ] No handwritten file above 2000 physical lines or line above 500 characters; empty debt baseline and strict check pass.
- [ ] Populated domain directories and explicit public entries replace legacy implementation owners without duplicate state or new runtime import cycles.
- [ ] TypeScript, Node regression suites, Rust checks/tests and production build pass; TEMP records/specs/tasks/journal synchronized.

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
