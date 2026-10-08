# Verification and scope review

## Maintainer review fixes — 2026-10-08

Delivery: PR #276, `kongzhuww/CLI-Manager:fix/275-skill-inventory-depth`; changelog version **V1.4.2**. Upstream master `a3247eebbc1fa04a25cd40a1b23856c76f2f73f6` was merged with both changelog sections preserved. The dedicated merge commit is `0eed48b0`.

### Root cause and affected scope

The WSL producer raised on vanished enumeration candidates and eagerly collected/sorted directories before enforcing its path budget. The fixes land in the scanner: skip stale paths, check capacity before opening/advancing iterators, reuse ordinary-file type information, and refresh directory types before recursion so cached metadata cannot conceal a replacement link.

- Checked `scan_local_bounded`, `ScanBudget`, embedded `exhausted`/`visit`, `scan_wsl` decoding, `inspect`, `extensions_skills_inventory`, `inspectSkillInventory`, `GlobalExtensionsPage` and `SkillInventoryPanel`.
- Public IPC, private `{ entries, limited }` shape, per-root depth 8 / 500-entry / 10,000-path limits, directory-link non-recursion, and 15-second / 1-MiB WSL process limits are preserved.
- Native install/uninstall, ownership/SQLite, provider settings, credentials, terminal Hooks, window focus, tray, split panes and Workspans are confirmed unrelated. Worktree `.git` files remain ordinary files.
- GitNexus index refresh completed, but symbol context/impact could not resolve inventory symbols; change detection could not bind the isolated checkout to a registered index. These are unavailable checks, not zero-impact results. Contract/symbol-reference review and scoped Git diffs supply the fallback required by the fix-triage guide. Risk: medium, confined to inventory production and its two existing UI consumers.

### Completed validation

- `cargo test --manifest-path src-tauri/Cargo.toml --locked --offline --lib extensions::inventory::tests --no-default-features --target-dir F:/github/CLI-Manager/src-tauri/target`: **11 passed** on the merged V1.4.2 checkout, including stale candidates and the last allowed Skill at the exact path budget.
- `cargo check --manifest-path src-tauri/Cargo.toml --locked --offline --no-default-features --target-dir F:/github/CLI-Manager/src-tauri/target`: passed. The existing upstream `worktree_conflicts/main_recovery.rs::inspect` dead-code warning remains; it is unrelated and was not suppressed.
- `node --test scripts/extensionsI18n.test.mjs scripts/extensionsLists.test.mjs scripts/extensionsManagementUi.test.mjs scripts/extensionsInventory.test.mjs`: **34 passed, 1 POSIX symlink test skipped**. Regressions failed before their fixes and passed afterward; the new link-type boundary uses injected metadata, not a claimed real POSIX transport test.
- `npx --no-install tsc --noEmit`, `npm run check:architecture -- --strict` (1,283 source files, zero violations), targeted `rustfmt --check --edition 2021`, and `git diff --check`: passed.
- The directory-I/O tests assert 9,999 iterator advances after the root consumes its path slot, no opening of an exhausted child directory, balanced iterator closure, and only two path-stat API calls for an ordinary-file-only root.

### Performance evidence

Windows Python, 20,000 temporary ordinary files, five scans per version, median scanner time excluding Python process startup. Compare PR head `0ae347e8` with the final embedded scanner; final scanner SHA-256: `034c8f5618a29691ea0708f484b012ec344a1afca99b50c0dd3379cca21b8715`.

| Metric | PR before review fixes | Fixed |
|---|---:|---:|
| Median scan time | 2.116 s | 0.0192 s |
| Enumerated directory entries | 20,000 | 9,999 |
| `os.stat` / `os.lstat` API calls | 30,001 | 2 |
| Examined-path counter | 10,000 | 10,000 |

This measures the embedded Python algorithm on Windows; it is not WSL transport latency or a universal filesystem benchmark. Production caches were not read or changed. Real WSL is unavailable on this host, Windows directory-symlink creation lacks privilege (error 1314), and no desktop application was launched. Existing generated Web resources and dependency/build caches were reused only to run compilation/tests in the isolated checkout.

## Original author validation — 2026-10-05

Issue: #275. Base: 3a38a2346635cd4f42ea841372f43a0920030c5e.

## Completed checks (Windows 11)

- `cargo +1.95.0 test --manifest-path src-tauri/Cargo.toml --locked --lib extensions::inventory::tests --no-default-features`: 9 passed; builds the actual CLI-Manager library, not the isolated pre-fix reproducer. Other library tests were filtered, not claimed as run.
- `node --test scripts/extensionsI18n.test.mjs scripts/extensionsLists.test.mjs scripts/extensionsManagementUi.test.mjs scripts/extensionsInventory.test.mjs`: 28 passed, 1 skipped. The new tests execute the real embedded Python scanner. POSIX symlink test is skipped on Windows.
- `npm run check:architecture -- --strict`: no violations.
- `npx --no-install tsc --noEmit`: passed.
- `npm run web:build`: passed; required to prepare the upstream Tauri resource glob for a clean checkout's Cargo tests, not part of the fix.
- `git diff --check`: passed.

## Environment prerequisites resolved

The initial offline Cargo attempt lacked an existing dependency; online locked resolution then identified sysinfo's Rust 1.95 MSRV. An explicitly approved independent Rust 1.95.0 toolchain was installed. The user's default stable Rust remains 1.94.1. Dependency versions and lockfiles were not changed. npm dependencies were installed with lifecycle scripts disabled.

The first real Cargo build lacked generated Web assets. Building the existing Web workspace resolved that prerequisite; the subsequent actual-library inventory tests all passed. No desktop app or development server was launched.

## Impact / changes detection

GitNexus MCP/CLI is unavailable; use the explicit fix-triage fallback: reviewed extensions-management contracts, symbol references, and final Git diff. Changed producer flow is `scan_local` -> bounded helper -> `inspect` -> unchanged inventory IPC; WSL private result now preserves entries and truncation status. Frontend inventory completeness/protection, DB ownership, credentials, native writes, and remote/terminal workflows are unchanged.

No new public UI strings, IPC names, package dependencies, migrations, or credential fields. Existing bilingual extension checks pass. Do not treat discovery as session activation.

## Remaining platform/manual coverage

Real WSL process transport, POSIX link tests, and manual desktop visual acceptance were not run on this Windows host. The current native link classification and non-recursion are preserved, but this is not a claim of cross-platform end-to-end acceptance. The 10,000-path budget is a deliberate bound on continuing sibling work and is exposed to maintainer review, not an unlimited traversal promise.

## Privacy and production isolation

Only the new source checkout and disposable test fixtures were modified. Production CLI-Manager, user plugin caches, Pi accounts, platform credentials, and PATH were not modified. Do not attach user screenshots or production configuration to the Issue/PR.
