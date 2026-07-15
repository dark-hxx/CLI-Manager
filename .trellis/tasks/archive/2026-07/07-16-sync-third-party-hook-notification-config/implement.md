# Implementation Plan

1. Run GitNexus impact analysis for sync collection/application, settings store, sanitizer, and Sync settings UI symbols.
2. Extend `syncStore.ts` with the notification restore domain, payload collection, backward-compatible parsing, sanitized persistence, rollback, and target-count summaries.
3. Extend `SyncSettingsPage.tsx` with the restore checkbox, count display, updated import/scope text, and warning-colored plaintext credential disclosures in Chinese and English.
4. Update V1.2.8 changelog, feature inventory, and WebDAV sync contract.
5. Run TypeScript checking, Rust contract checks as applicable, formatting/diff checks, secret-leak review, and GitNexus `detect-changes`.
6. Review the design against cloud upload/download, auto-sync, conflict resolution, local export/import, partial restore, old snapshots, malformed data, and rollback.
7. Revert GitNexus-generated `AGENTS.md`/`CLAUDE.md` changes, fetch and merge the latest remote `master`, rerun checks, commit work, archive/record the Trellis task, and push `master`.

## Expected Files

- `src/stores/syncStore.ts`
- `src/components/settings/pages/SyncSettingsPage.tsx`
- `src/lib/i18n.ts`
- `CHANGELOG.md`
- `docs/功能清单.md`
- `.trellis/spec/backend/webdav-sync-contracts.md`
- Current Trellis task artifacts

## Validation

- `npx tsc --noEmit`
- `cargo check --locked --manifest-path src-tauri/Cargo.toml` when the final merged tree changes or validates the shared payload contract
- `git diff --check`
- GitNexus impact and staged `detect-changes`
- Manual UI verification in Chinese and English, including warning color and 24-hour timestamps
