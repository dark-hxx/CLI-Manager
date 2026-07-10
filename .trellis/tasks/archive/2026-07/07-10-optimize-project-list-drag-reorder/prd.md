# Optimize Project List Drag Reorder

## Goal

Make project/group drag-and-drop reordering update the sidebar immediately on drop instead of waiting for SQLite persistence and a full project refresh.

## Requirements

- Apply the reorder result to the Zustand project state synchronously before persistence completes.
- Preserve SQLite persistence for same-level reordering and cross-group moves.
- Keep the current drag/drop rules, grouping behavior, search behavior, and ordering semantics unchanged.
- Do not add dependencies or change database schema.
- Record the user-visible fix under `CHANGELOG.md` target `[TEMP]`.

## Acceptance Criteria

- [ ] Dropping a project or group in a new same-level position updates the tree immediately.
- [ ] Moving a project into/out of a group updates the tree immediately.
- [ ] Moving a group between parents updates the tree immediately.
- [ ] The final order remains correct after reloading project data or restarting the app.
- [ ] Persistence failures do not leave the in-memory tree permanently inconsistent with SQLite.
- [ ] `npx tsc --noEmit` passes.

## Technical Approach

- Update `projectStore` optimistically by changing `sort_order`, `group_id`, or `parent_id`, then rebuild `tree` from the updated arrays.
- Persist the same mutation to SQLite in the existing store actions.
- On persistence failure, restore the previous in-memory snapshot and rethrow the error.
- Avoid the post-write `fetchAll()` on successful drag mutations because it delays visible feedback and also performs unrelated refresh work.

## Out of Scope

- Changing collision detection, drag overlays, activation distance, or drop targeting rules.
- Refactoring unrelated project CRUD actions.
- Adding automated UI drag tests or new test dependencies.

## Technical Notes

- Drag completion is handled in `src/components/sidebar/index.tsx` and delegates to `projectStore` actions without awaiting them.
- `reorderItems`, `moveProjectToGroup`, and `moveGroupToParent` currently update SQLite first and call `fetchAll()` afterward; the sidebar only changes after that refresh completes.
- `fetchAll()` may include project path health checks and provider refresh work, which should not gate drag feedback.
- Changelog Target: `[TEMP]`.

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
