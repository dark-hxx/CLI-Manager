# Verification Evidence

## Automated Checks

| Check | Result |
|---|---|
| `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check` | Passed |
| Focused `live_server` Rust tests | 8 passed, 0 failed, 2.35 s execution under a 60 s hard timeout |
| Project-local `tsc --noEmit` | Passed |
| `npm run build` | Passed; 6,850 modules transformed |
| `cargo check --manifest-path src-tauri/Cargo.toml` | Passed |
| `npm run tauri:build:local` | Passed; optimized Windows release and installer bundles built successfully |
| `git diff --check` | Passed |

The initial test-profile dependency build was explicitly separated with `cargo test --no-run`; only test execution used the mandated 60-second timeout.

## Behavioral Coverage

- Unicode and space URL encoding; nested `index.html`; traversal, encoded traversal, backslash, missing entry, and non-HTML rejection.
- HTML reload injection before mixed-case `</body>` and append behavior without a body close tag.
- Generated-directory watcher filtering and a real file change advancing the reload version.
- Real `127.0.0.1` listener, static HTML response, invalid Host `403`, method `405`, empty HEAD body, same-root port reuse, explicit stop, and listener refusal after stop.
- Frontend eligibility covers ordinary tree, filename search, and content search HTML entries; root menu exposes stop only for a running local session.

## Contribution Boundary

- No generated executable, installer, signing material, local deployment path, or rollback artifact is included in the contribution diff.
- Release packaging was used only as a verification step; upstream release publication remains owned by the maintainers.
