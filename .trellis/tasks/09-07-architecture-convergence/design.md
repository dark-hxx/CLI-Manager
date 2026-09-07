# Architecture convergence

1. Expand compressed JSX with a pinned temporary formatter (no package.json/lockfile dependency). Compare TypeScript emitted JSX semantics and literal values before/after; do not compress code or broaden exceptions.
2. Rewrite two long Rust string expressions without changing output bytes, using compiler/tests and literal comparison.
3. Complete domain ownership migration using an explicit path map and resolved import graph. Prefer narrow state/UI entries; never route state consumers through UI barrels. Preserve lazy imports, assets, workers and process entrypoints. Keep compatibility adapters only where justified.
4. Strengthen architecture rules to match actual public entries and dependencies, empty the temporary debt baseline, run the final cross-package gate.

Separate Git/editor convergence task handles the pre-existing <=300-line editor responsibility test. No Tauri UI launch. Final human checklist covers local/WSL/SSH, split/Workspan/restore, both languages and Git destructive-action confirmations.
