# AI-Oriented Architecture Contracts

## 1. Scope / Trigger

All handwritten application, agent, daemon, test and build-script code. This supersedes
the former guide claiming there is no file-length limit. `scripts/architecture/baseline.json`
is now empty; do not add new exemptions. Strict mode is the zero-debt integration gate.

## 2. Commands

- `npm run check:architecture`: fail on new/growing length debt or forbidden layer imports.
- `npm run check:architecture -- --strict`: ignore migration debt and enforce final limits.
- `npm run report:architecture`: concise report of files above 1200 lines, bytes, estimated
  tokens and direct import count; reporting does not fail the build.
- `node --test scripts/architecture.test.mjs scripts/architectureRust.test.mjs`: rule boundary/regression tests.
- `node scripts/architecture.mjs --baseline-json`: read-only candidate baseline output.
  Review the diff before applying; never regenerate debt upward to silence a failure.

These commands are deliberately independent of `dev`/`build`. They reuse installed TypeScript
for import parsing; no new package or background indexer is required.

## 3. Contracts

- Hard limit: 2000 physical lines, including blanks/comments; final newline is not an extra line.
  Aim for 400–1200 lines in normal modules. Small cohesive modules need no artificial padding.
- Handwritten lines above 500 characters fail. The historical exact-hash baseline is empty;
  do not add or duplicate long lines, or minify JSX to game limits.
- Scan Git-tracked and non-ignored untracked source, omit deleted files. Explicit exclusions
  are in `EXCLUDED_PREFIXES`; generated Trellis/platform scaffolding, vendored code and Tauri
  generated schemas are not handwritten application modules. Fixtures and SQL are not blanket exclusions.
- Frontend: `app` composes `features/<domain>/{components,hooks,store,lib,types,i18n,styles,tests}`
  and `shared/{ui,hooks,lib,types,i18n,platform}`. Create only populated directories.
- `features/<domain>/api/<module>` is a narrow public source module, not a barrel. Expose a
  cohesive component/service directly when another feature needs it; this preserves the original
  module graph without facade files or eager aggregation of UI and stores. `index.ts` and `state.ts`
  are existing explicit entries; never route state consumers through a UI entry. `api` subdirectories
  are internal and cannot be imported across features.
- `shared/preferences/settingsStore.ts` owns application-wide persisted preferences consumed by
  i18n/themes and multiple features; the settings UI belongs to its feature. Shared wire types
  (for example `shared/types/remoteHandoff.ts`) must not import transport implementations.
- The retired frontend `components`, `hooks`, `stores`, `lib`, and `terminal` implementation
  directories must not be reintroduced as an import bypass from the new layers.
- Rust: keep stable `lib.rs` and thin IPC `commands`; extract domain implementation to
  `features/<domain>` and reusable runtime/storage to `infrastructure`/`shared`.
  SSH-agent and daemon crates retain their process/package boundaries.
- Rust `lib.rs` and `commands/mod.rs` declare explicit `#[path]` namespace routes to the physical
  owners. Keep these stable crate paths so helper binaries, command macros and `pub(super)`
  ancestry do not change. This is a single implementation, not forwarding wrappers. See
  [Rust directory structure](../backend/directory-structure.md).
- `shared` cannot import `features`/`app`; features cannot import `app`. Cross-feature imports
  use a narrow public entry, not internal files. Prefer explicit exports over `export *`.
  TypeScript static/type/inline-import-type/export/dynamic imports are parsed. Rust direct/grouped
  crate references resolve through explicit namespace routes to their real layer; literals and
  nested comments do not create fake dependencies. Relative Rust `super` references, aliases
  introduced by local `use`, macro-generated imports and computed imports still require compiler
  checks/review; this is not a complete module resolver. CSS imports retain cascade order.
- Preserve IPC names/arguments, serde keys, DB migrations, persisted store keys, i18n keys,
  CSS order/specificity, PTY event ordering and lifecycle. Retain explicit compatibility
  facades during migration; do not duplicate state or implementations.

## 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| 2000 physical lines | Pass |
| New 2001-line source / old file grows above baseline | Fail with path/count |
| Existing debt unchanged or smaller | Migration check passes; strict still fails |
| New/duplicated >500-character line | Fail with path/hash |
| Forbidden new-layer dependency | Fail with source/import/reason |
| Unknown CLI option / Git/read error | Nonzero exit; do not silently skip scan |

## 5. Good / Base / Bad Cases

- Good: extract language dictionaries by domain, preserve all key/value pairs and runtime entry.
- Base: old monolith is recorded once while batches steadily reduce debt.
- Bad: split into `part1`/`part2`, add broad allowlists, compress statements, introduce dynamic
  loaders or move the same giant implementation under another name.

## 6. Tests Required

Check LF/CRLF, empty/final-newline boundaries, 2000/2001, baseline growth/renames,
long-line replacement/duplication, generated-vs-handwritten scope, static/dynamic imports
and forbidden layer directions. Each extraction also needs targeted behavior tests plus
type/build or Rust compilation. Compare dictionary maps and CSS rule order before/after.
UI runtime verification is manual per `quality-guidelines.md`; agents do not launch the app.

## 7. Wrong vs Correct

Wrong: open all of `history.rs` and all specs for every history task, add a catch-all utility,
then run every expensive check repeatedly.

Correct: use the feature entry and relevant contract to locate symbols, inspect only their
dependencies, change one cohesive unit, run focused tests, and run full affected-package
checks once at the integration gate. The report's bytes/4 figure is a rough reading-cost
heuristic, not a promised tokenizer count or measured token saving.
