# Task Delivery Checklist

> Repo-specific start/finish checklist for AI-driven changes.

---

## When to Use

Use this checklist for any task that writes files, whether it goes through the full Trellis task flow or qualifies for no-task inline handling.

---

## Before You Edit

- At the start of every task, including no-task simple work, run the read-only branch/upstream checks: `git status --short --branch`, `git branch -vv`, and `git rev-list --left-right --count 'HEAD...@{upstream}'` when an upstream exists.
- Report whether the current branch is synchronized, ahead, behind, diverged, or has no upstream. Do not automatically run `fetch`, `pull`, `push`, `merge`, or `rebase`; request explicit user authorization before changing Git state.
- If unrelated dirty files exist, keep them out of your task and surface them in the commit plan instead of silently bundling them.
- If there is no upstream configured for the current branch, surface that fact instead of pretending the remote-ahead check succeeded.

---

## During Diagnosis and Repair

### Minimal-repair stop rule

- State the one current goal before using tools. When the user supplies a concrete compiler error, fix that error rather than reopening the original broader investigation.
- For a compiler error, first inspect only the diagnostic location, the directly called implementation, and at most one required type or configuration definition. Do not load large specs, task history, full files, global search, GitNexus, or sub-agents unless the local evidence proves they are needed.
- Apply one minimal, evidence-based code change at a time. Immediately run the relevant formatter, compiler, or focused test before making another speculative change.
- If the required validation command cannot run, stop modifying and report the exact unverified state. Never substitute additional reading or architecture changes for compilation/test evidence.
- Do not add modules, abstractions, or change callers merely to suppress a compile error unless the original local implementation has been shown insufficient.
- When a user asks to stop reading, narrow scope, or stop work, stop all tool calls immediately and acknowledge the boundary.
- On a dirty worktree, avoid opportunistic refactors and preserve unrelated changes; report every file changed by the repair.

### Tool budget for a concrete compiler error

- Initial investigation: at most three targeted reads and no broad code-intelligence search by default.
- Before verification: one logic edit. Exceeding either budget requires explaining why and obtaining user approval.
- Do not call the same broad-read or impact tool repeatedly to compensate for a missing local compiler/test result.

---

## Before You Finalize

- For every code change, confirm which `CHANGELOG.md` version should receive the work. If the user does not provide a version number, ask; if the user still does not provide one or explicitly declines, use `TEMP`.
- For every code change, update [`CHANGELOG.md`](../../../CHANGELOG.md) with the version and update the relevant feature section in [`docs/功能清单.md`](../../../docs/%E5%8A%9F%E8%83%BD%E6%B8%85%E5%8D%95.md).
- Rules, workflow, and explanatory-document changes are not code changes and do not require these two product records unless the task also changes code.
- If the user explicitly provided an issue number or issue URL, associate the commit message with that issue.
- Prefer non-closing issue references such as `Refs #123` unless the user explicitly asked to close the issue.

---

## Simple Task Rule

- A task is simple only when the goal and acceptance criteria are clear, the change is locally bounded, no research is needed, and it avoids new dependencies, database changes, IPC/API contracts, permission/security, concurrency/process, persistence protocol, and architecture changes.
- Typical simple tasks are explanations, typo/copy fixes, simple getters/setters, log additions, static style adjustments, and obvious local fixes. They do not require task-creation consent or a Trellis task directory.
- New features, unclear requirements, cross-module or cross-boundary changes, behavior/data-flow changes, high-risk changes, or uncertain classifications must use the normal Trellis task flow.

---

## Why This Exists

- Prevent stale-context edits when the repo changed since the last read.
- Keep release notes and feature inventory aligned with actual shipped behavior.
- Make commit history traceable when users point to a specific issue.
