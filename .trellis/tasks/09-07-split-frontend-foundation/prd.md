# Split frontend i18n and styles

## Goal

Split frontend i18n and styles

## Requirements

- Split locale data by named domain and styles by existing contiguous responsibility sections.
- Preserve all translation keys/values, traditional conversion, runtime entry, CSS rule order and asset URLs.
- Update source-reading tests to follow composition instead of requiring monolithic storage.

## Acceptance Criteria

- [x] Original and extracted dictionary maps and ordered CSS rules are equal.
- [x] No extracted file exceeds 2000 lines; type/build and affected source tests pass.

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
