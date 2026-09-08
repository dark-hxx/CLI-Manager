# Refactor audit — in progress

## Scope and status

Baseline: `33916085^`. Requested commits: `33916085`, `220564b5`, `b9b00a04`,
`2d1eb7fe`, `fc92405e`, `6cf6222d`, `9488d0be`, `8cf2a86c`, `8a5325df`.
Current work commit at start: `563abf75`; worktree changes are this task's planning/audit artifacts only.
The branch has no upstream. Task creation, plan and TEMP version were confirmed by the user.

No confirmed introduced product defect has been established yet. This is NOT a completed review
or a no-bugs conclusion. Backend method documentation has not started.

## Independently reproduced evidence

- Strict architecture: 946 source files, no files above 2000 physical lines, zero violations.
- 22 targeted tests passed: architecture/Rust architecture, locale/CSS foundation,
  editor Markdown navigation and terminal runtime persistence/timers.
- `audit-module-bindings.mjs`: checked 511 frontend modules against `9488d0be`, including
  local/imported identifier names, aliases, type-only status and declaration order. Three CSS
  relocations were validated against unchanged contents; the shared RemoteHandoffAgent type
  was validated against its original definition. No unexplained import differences remain.
- `audit-rust-ownership.mjs`: 243 files compared against `8cf2a86c` with executable content,
  imports, visibility and cfg declarations retained. All 78 explicit namespace routes point to
  their original owners; all 11 resource/path edits resolve to the original or mapped target.
- Non-test files in scripts/.github/package.json/vite.config.ts were searched for retired
  frontend/backend owner paths; the selected stale-path search returned no matches.

## Backend method inventory / unresolved comparison

The new `rust-audit` utility uses syn to visit nested functions, inherent/trait impl methods,
trait declarations/defaults, foreign declarations and inline cfg/test modules. It does not
expand macros or execute application code. Tool dependencies are task-local, not product changes.

- Baseline 158 Rust files; current 267 tracked Rust files.
- Both sides contain 5930 function/method declarations.
- 5734 bodies have an exact token-body match by name and kind.
- 120 additional bodies match after removing optional call/array/struct trailing commas and
  comparing parsed string values. Tuple syntax and relative qualifiers are not stripped.
- 76 differences remain in `rust-method-differences.json`. Initial inspection finds source
  LF/CRLF representation differences, test fixture indentation, macro string formatting,
  resource relocation, catalog relative qualifiers and two deliberate literal decompositions.
  These are not automatically dismissed: compiler input normalization, complete bodies and
  exact target/literal identity still need explicit checks.
- No unexpanded Rust macro with a `fn` token was found. Embedded scripts and other backend
  languages still require a separate inventory; this does not prove their method coverage.
- Method-body matching alone does not prove identity for duplicate names, signatures,
  attributes, associated types, initialization order or caller resolution. Those are remaining
  review dimensions, not implied by the matching count.

## Prior verification limitations found

The previous Rust function-body auditor checked top-level free functions and selected test
modules; it did not independently compare every impl/trait method. It also stripped relative
`super` qualifiers and dedented test literals. Those normalization assumptions must not be
used as blanket proof that all method behavior and string contents were preserved.
The old final frontend verifier omitted import declarations; this round's binding/order check
supplements that omission. Neither limitation is itself a confirmed product bug.

## Environmental and runtime limitations

GitNexus detect_changes currently reports its LadybugDB unavailable. The previous indexing
attempt failed with access denied. No index deletion, permissions change or process termination
was performed. Source and contract inspection supplements the unavailable graph.
No desktop application, real remote services or UI e2e were launched. Windows-only automated
checks cannot establish Unix runtime behavior or manual terminal/UI correctness.

## Remaining work

- Explain remaining Rust differences and compare method signatures/attributes/owner identity.
- Independently review earlier frontend/store/controller extraction and JSX/lifecycle ordering.
- Audit constants/types/initialization and all nine commits' external consumers.
- Run final relevant package verification, publish confirmed findings and complete coverage ledger.
- Then perform the full backend method-comment task and its token-equivalence/coverage checks.
