# Document every handwritten backend function and method

## Goal

Document every handwritten backend function/method accurately without changing behavior.

## Requirements

- Cover desktop, helpers, SSH agent, shared crates, build scripts, private/trait/test/cfg methods and inventory other backend scripts. Chinese concise explanations grounded in implementation; no name-only boilerplate. Preserve useful comments and the 2000-line limit. Update TEMP changelog and feature inventory.

## Acceptance Criteria

- [x] Complete auditable coverage inventory and source-grounded review.
- [x] Verify relevant contracts and regression tests; explicitly report untested runtime/platform scenarios.
- [x] Deliver report with evidence; documentation child additionally proves no missing method comments and executable equivalence.

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
