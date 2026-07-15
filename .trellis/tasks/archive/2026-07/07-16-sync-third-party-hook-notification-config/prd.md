# sync-third-party-hook-notification-config

## Changelog Target

V1.2.8

## Goal

Include third-party Hook notification configuration in WebDAV and local export/import snapshots so users can restore notification targets on another CLI-Manager installation.

## Confirmed Facts

- Third-party Hook notification state is persisted in `.cli-manager/settings.json` as `thirdPartyHookNotificationsEnabled` and `thirdPartyHookTargets`.
- Each target includes provider, enabled state, event filters, and a provider-specific `config` object.
- Provider config may contain full webhook URLs, access tokens, signing secrets, device keys, Authorization headers, and custom HTTP body/query/header values.
- These credentials are currently plaintext in the local settings store; UI masking and log redaction are not encryption.
- WebDAV `SyncPayload.settings` already exists as a backward-compatible JSON object, but `collectLocalSyncData` currently always emits `{}` and `applySyncData` ignores it.
- Partial restore currently supports only projects, groups, and command templates. Old snapshots contain an empty or absent notification settings object.
- Existing target validation is centralized in `sanitizeThirdPartyHookTargets`, with a limit of 20 targets and unknown/invalid records filtered out.

## Proposed Requirements

- Sync only the two third-party Hook notification settings, not the entire application settings store.
- Add a dedicated partial-restore domain for third-party Hook notifications and expose it in the restore UI.
- Upload/local export always include the global enable switch and sanitized target list.
- Download/local import sanitize remote target data before writing it to the settings store and Zustand state.
- An old snapshot that omits these keys preserves the local notification configuration; an explicit empty target list clears it when the domain is selected.
- If the notification domain is not selected during partial restore, preserve all local notification settings.
- Preview/device summaries show the number of third-party Hook notification targets without exposing provider credentials.
- WebDAV password remains excluded from every snapshot.
- Sync conflict, rollback, local export/import, auto-sync, and manual partial restore must all use the same notification configuration contract.

## Confirmed Security Policy

- Complete provider credentials are included so restored targets work without re-entry.
- Webhook URLs, tokens, signing secrets, device keys, Authorization headers, and custom request values are serialized as plaintext fields inside WebDAV `sync.json` and local zip `sync.json`.
- CLI-Manager does not add application-level encryption for these fields. HTTPS protects transport only when the configured WebDAV URL uses HTTPS; HTTP sends them without transport encryption.
- The WebDAV usage notes must show this disclosure in warning-colored text. Local export notes must also warn that the zip contains plaintext credentials.

## Acceptance Criteria

- [ ] Upload and local export include complete third-party notification configuration, including working credentials.
- [ ] Download and local import restore selected notification configuration and immediately refresh the settings state used by the UI and Rust dispatcher.
- [ ] Old snapshots do not erase existing local notification configuration.
- [ ] Partial restore can include or exclude third-party Hook notifications independently.
- [ ] Invalid providers, duplicate IDs, malformed targets, and targets beyond the limit are removed through the existing sanitizer.
- [ ] Preview/list UI reports only target counts and never renders secrets.
- [ ] No WebDAV password, logs, or unrelated application settings are added to the sync payload.
- [ ] WebDAV and local-sync usage notes visibly warn, in warning-colored Chinese and English text, that notification credentials are not application-level encrypted.
- [ ] Chinese and English restore UI text are both provided, with 24-hour time formatting unchanged.
- [ ] TypeScript checks, Rust checks, relevant tests, and GitNexus change detection pass.

## Out of Scope

- Syncing all application settings.
- Encrypting WebDAV snapshot contents with a new user-managed key.
- Merging target lists record-by-record; selected restore replaces the local target list atomically.
- Changing provider delivery, Hook dispatch, or test-send behavior.

## Open Questions

- None.
