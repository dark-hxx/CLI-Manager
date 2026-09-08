# Tauri User File Security Checklist

> **Purpose**: Stop and verify boundary defenses whenever a Tauri command accepts a user-supplied path or the WebView is granted access to local files.

---

## The Problem

User-supplied paths and broad asset/fs scopes are the two most common ways a desktop app gets a file-system escape vulnerability. The blast radius is the whole user account, not just the app.

This project has a real defense pattern (see `src-tauri/src/features/terminal/background.rs`) — copy it.

---

## Before You Add a Command That Accepts a Path

### Step 1 — Decide whether the path is opaque or user-controlled

| Origin | Treat As |
|--------|----------|
| Returned by `tauri-plugin-dialog` (`open()`) | **User-controlled, untrusted** |
| Stored in `settings.json` originally from `open()` | **Stale + untrusted** (file may have moved) |
| Composed from `appLocalDataDir() + <static>` | **Trusted by construction** |
| Anything mixed (user-supplied fragment glued onto a root) | **Untrusted — validate the fragment** |

An opaque identifier is still a path when code later calls `base.join(id)`. If it must name exactly
one child directory, require exactly one `std::path::Component::Normal` in addition to the domain
allowlist. Explicitly test `.`, `..`, and whitespace-trimmed variants; a character allowlist that
permits `.` does not make those special components safe.
For the executable desktop-pet contract and error matrix, see
[`desktop-pet-file-safety-contracts.md`](../backend/desktop-pet-file-safety-contracts.md).

### Step 2 — Layer the defense (BOTH layers required, not either-or)

**Layer A — Path-string validation (cheap, before I/O)**

A relative path coming from the frontend (e.g. `relativePath: String`) must reject:

- `..` anywhere (parent escape)
- `\\` backslash (Windows separator — force forward slashes only)
- Leading `/` (absolute path)
- Paths not beginning with the expected prefix (e.g. `backgrounds/`)

Extract a pure helper so it can be unit-tested without `AppHandle`:

```rust
pub(crate) fn validate_relative_path(p: &str) -> Result<(), &'static str> {
    if p.contains("..") { return Err("path_escape"); }
    if p.contains('\\') { return Err("backslash_separator"); }
    if p.starts_with('/') { return Err("absolute_path"); }
    if !p.starts_with("backgrounds/") { return Err("outside_scope"); }
    Ok(())
}
```

**Layer B — Canonicalization check (after path joining, before file ops)**

```rust
let abs = base.join(&rel);
let canon_dir = base.canonicalize().map_err(stringify)?;
let canon_abs = abs.canonicalize().map_err(stringify)?;
if !canon_abs.starts_with(&canon_dir) {
    return Err("path_escape_after_canonicalize".into());
}
```

This catches symlinks and `~` expansion that string-level validation misses.

### Step 3 — Lock the `assetProtocol.scope` to the narrowest variable

```jsonc
"assetProtocol": {
  "enable": true,
  "scope": { "allow": ["$APPLOCALDATA/backgrounds/**"], "deny": [] }
}
```

**Forbidden scope roots** (too broad — the user account becomes one big filesystem to the WebView):

- ❌ `$HOME/**`
- ❌ `$DESKTOP/**`, `$DOCUMENT/**`, `$DOWNLOAD/**`
- ❌ `$RESOURCE/**` unless you ship read-only assets there
- ❌ `**` (everything)

**Allowed scope roots** (sized to the feature):

- ✅ `$APPLOCALDATA/<feature>/**` for app-managed files
- ✅ `$APPCACHE/<feature>/**` for ephemeral files

---

## Capability File Posture

`capabilities/default.json` should use `fs:default` ONLY when:

- All actual file I/O happens inside Rust commands you wrote (`#[tauri::command]`)
- The frontend imports nothing from `@tauri-apps/plugin-fs` (grep to verify)

If the frontend needs JS-side fs calls, switch to per-permission grants (`fs:allow-read-text-file`, etc.) + a `fs:scope` block — never broaden to `fs:allow-read-file` blanket.

---

## Tests Required for Each Path-Accepting Command

1. **String-validation unit tests** for the pure helper:
   - Accepts `backgrounds/abc.jpg`
   - Rejects `backgrounds/../etc/passwd`
   - Rejects `backgrounds\\abc.jpg`
   - Rejects `/etc/passwd`
   - Rejects `other-dir/abc.jpg`
2. **Canonicalization test** with a symlink (use `tempfile::TempDir` + `std::os::unix::fs::symlink` / Windows junction equivalent).
3. **Idempotency test** if the command writes (same input → same output, no overwrite of unrelated files).
4. **Format/extension validation** (allowlist; never use a denylist).

---

## Checklist Before Reviewing the PR

- [ ] String validation helper exists and is **pure** (no `AppHandle`)
- [ ] Canonicalize-after-join check exists for paths used in file I/O
- [ ] `assetProtocol.scope.allow` lists a single bounded path; no `$HOME`/`$RESOURCE` unless justified
- [ ] `capabilities/default.json` uses the narrowest fs permission set; `fs:default` only if frontend has zero `@tauri-apps/plugin-fs` imports
- [ ] Unit tests cover both `..`, backslash, leading slash, outside-prefix
- [ ] Extension/format validation is an **allowlist** (e.g. `&["jpg","jpeg","png","gif"]`), not a denylist
- [ ] Error messages returned to the frontend are stable strings (`"unsupported_format"`, `"file_too_large"`, `"path_escape"`) so the UI can branch deterministically

---

## Real-World Reference

`src-tauri/src/features/terminal/background.rs` implements all of the above:

- `validate_extension` (allowlist for `jpg/jpeg/png/gif`)
- `validate_relative_path` (rejects `..`, `\`, leading `/`, outside `backgrounds/`)
- `compute_filename` (content-addressed sha256-derived stem — idempotent)
- Canonicalize check inside `save_background_image` (`canon_abs.starts_with(canon_dir)`)
- `tauri.conf.json` scope locked to `$APPLOCALDATA/backgrounds/**`

When adding a new file-handling Tauri command, mirror this layout.
