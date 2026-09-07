# Split terminal feature

## Goal

Split terminal feature

## Requirements

- Split XTermTerminal, TerminalTabs and terminalStore below 2000 physical lines by responsibility.
- Preserve process ownership, attach/replay/ACK ordering, snapshots, timers, hook order and store identity.
- Keep local/WSL/SSH, worktree, split pane, Workspan, file/history/Git panels and bilingual UI behavior unchanged.

## Acceptance Criteria

- [ ] All extracted modules meet physical and long-line limits without numbered chunks.
- [ ] TypeScript, declaration/body equivalence, affected terminal tests and production build pass.
- [ ] TEMP records, feature inventory, dependency boundaries and shrinking baseline updated.

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
