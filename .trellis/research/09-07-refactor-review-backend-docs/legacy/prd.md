# Review refactor commits and document all backend methods

## Goal

Review the nine architecture-refactor commits for introduced defects and document every handwritten backend function/method so its behavior is understandable without changing runtime behavior.

## Requirements

- Review commits 33916085, 220564b5, b9b00a04, 2d1eb7fe, fc92405e, 6cf6222d, 9488d0be, 8cf2a86c and 8a5325df against their original parent, distinguishing introduced defects from pre-existing issues.
- Cover desktop Rust, helper binaries, SSH agent, shared Rust crates, build scripts and test helpers; exclude generated/vendor sources. Inventory any other backend language before finalizing coverage.
- Add concise Chinese method-level explanations grounded in implementation; preserve useful existing comments. Explain relevant side effects, error paths, concurrency and boundary assumptions, not merely translate function names.
- Preserve behavior, signatures, IPC, serialization, persistence, module visibility and source-size limits. No mass boilerplate or new dependencies.
- Report confirmed review findings with source locations, triggering scenarios, severity and supporting evidence. Review does not authorize automatic bug fixes.
- Use TEMP in CHANGELOG.md and update docs/功能清单.md for delivered changes.
- Task creation/planning and implementation plan approved (user: ok). No push, app launch, real remote service or destructive Git operation.

## Acceptance Criteria

- [ ] All nine commits have evidence-backed review coverage, including module/resource paths, initialization order, state ownership, JSX/CSS and backend boundaries.
- [ ] Every in-scope backend function/method has an accurate explanatory comment, verified against an explicit inventory including private, trait, test and platform-specific methods.
- [ ] Comment-only changes preserve executable tokens; any necessary source extraction is separately reviewed and verified.
- [ ] Strict architecture checks, relevant frontend regressions/build and all affected backend package compilation/tests pass; unsupported platform/manual coverage is explicitly listed.
- [ ] Review report, TEMP delivery records and task evidence accurately distinguish completed work and limitations.

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
