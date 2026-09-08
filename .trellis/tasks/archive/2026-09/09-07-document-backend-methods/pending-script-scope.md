# Pending non-Rust and embedded backend scope

## Evidence and status

This is a candidate-scope ledger, not a complete function inventory or a coverage claim.
The existing 5930-method Rust audit does not enumerate executable functions inside string
literals, JavaScript resources, shell installers or build orchestration scripts. These must
be reviewed before the annotation task can be completed. Product code is unchanged by this ledger.

Read-only discovery used `rg --files scripts src-tauri` with language filters, resource listings,
`include_str!`/`include_bytes!` call sites, package.json and targeted embedded-function searches.
The search was deliberately not treated as syntax-aware proof of completeness.

## Confirmed candidates

| Source | Evidence / responsibility | Remaining work |
| --- | --- | --- |
| `src-tauri/resources/opencode/cli-manager-hook.js` | Loaded by `features/hooks/opencode.rs` through include_str; named helpers and runtime Hook implementation | Read full file, enumerate named/assigned/anonymous callable definitions, review comments, verify JS executable equivalence and Hook tests |
| `src-tauri/src/features/hooks/settings/pi.rs` | Contains generated TypeScript definitions including nonEmpty, postHookEvent, titleFor, readSessionId and default extension function | Review generated source separately from Rust methods; preserve format-string escaping and test generated output |
| `scripts/install-ssh-agent.sh` | Agent lifecycle installer with shell functions, manifest/key configuration and argument dispatch | Enumerate shell functions and embedded programs, read full implementation, annotate without invoking install/uninstall or network writes |
| `scripts/package-portable.ps1` | Release packager with explicit version/source/output parameters | Review callable definitions versus top-level workflow; do not run packaging as a syntax check |
| `scripts/prepare-bundle-binaries.mjs` | macOS universal helper bundling via lipo | Review top-level workflow and callbacks; no named function in the inspected opening section is not proof of whole-file zero coverage |
| `scripts/tauri-cli.mjs`, `scripts/dev-server.mjs` | package.json tauri/dev entry points | Classify backend build orchestration and enumerate relevant methods; avoid launching dev services |
| `scripts/architecture.mjs`, `scripts/architecture/core.mjs`, `scripts/architecture/rust.mjs` | Build quality gate | Inventory project-owned functions if included in backend/build tooling scope; preserve gate behavior |

## Coverage rules for the next pass

- Scan all tracked source roots, not only the examples above; check generated command strings,
  shell/PowerShell/Python snippets, templates, workflow-embedded programs and helper entry points.
- Distinguish production backend code, backend tests/build tools, frontend-only tests, third-party
  assets and generated artifacts. Record the reason for exclusions instead of silently dropping files.
- Existing `.test.mjs` filenames alone do not establish frontend-only scope. Examples such as
  SSH Agent release, daemon transport and proxy tests need source-based classification.
- For embedded programs, ordinary Rust comment insertion leaves string tokens unchanged; adding
  comments *inside* a generated script changes those Rust string tokens. Validate host-template
  changes and generated-language executable equivalence separately rather than weakening the
  Rust comment-only verifier globally.
- Preserve useful comments and add meaningful Chinese explanations only after reading implementation.
  Do not claim exhaustive coverage from keyword counts or automatic name-to-comment generation.
- Compilation or static parsing does not authorize executing installers, credential helpers,
  Git mutations, daemon lifecycle commands or live network probes.

## Next concrete steps

Additional confirmed embedded definitions (host strings unchanged by Rust batches):

- infrastructure/pty/manager.rs: PowerShell global:prompt and global:PSConsoleHostReadLine;
  Bash __cli_manager_prompt in the generated integration rcfile.
- features/remote/cc_connect/project_commands.rs: PowerShell Decode-Base64Utf8 in the
  project-switch script template.
- features/hooks/settings/pi.rs: TypeScript nonEmpty, postHookEvent, titleFor, readSessionId,
  default extension callback, three pi.on callbacks and the timeout callback.

1. Finish a tracked-file candidate manifest and inspect each candidate fully.
2. Inventory callable definitions with language-aware tooling or independent cross-checks.
3. Add per-file coverage and verification evidence to progress.md only after completion.
4. Keep the global inventory checklist open until all languages and explicit exclusions are audited.
