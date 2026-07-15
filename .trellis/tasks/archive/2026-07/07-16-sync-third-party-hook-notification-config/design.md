# Design

## Scope

Extend the existing `SyncPayload.settings` object with only the third-party Hook notification configuration. Do not synchronize the rest of `settings.json`.

## Data Contract

```ts
settings: {
  thirdPartyHookNotificationsEnabled: boolean;
  thirdPartyHookTargets: ThirdPartyHookTarget[];
}
```

- `thirdPartyHookTargets` includes the complete provider `config`, including webhook URLs, tokens, secrets, headers, query values, and bodies.
- `SYNC_DATA_VERSION` remains `1` because the existing `settings` object is the extension point and old readers already deserialize it as an opaque JSON object.
- A new restore domain, `third_party_hook_notifications`, controls whether these two keys are applied.

## Upload And Export

`collectLocalSyncData` reads the already-loaded `useSettingsStore` state, sanitizes the target list with `sanitizeThirdPartyHookTargets`, and adds the global enable switch plus target list to the payload. Cloud upload, preview, conflict resolution, auto-upload, and local zip export all reuse this collector.

## Download And Import

`applySyncData` handles cloud download, conflict resolution, and local zip import.

- If the notification domain is not selected, preserve local notification settings.
- If an old snapshot contains neither notification key, preserve local notification settings even when all domains are selected.
- If a key is present, apply it. An explicit empty list clears targets.
- Sanitize remote targets before persistence.
- Persist through the existing settings-store `update` method so both `.cli-manager/settings.json` and Zustand state update immediately; the Rust dispatcher reads the same file for later Hook jobs.
- Back up both notification settings and restore them if the overall apply path fails.

## Preview And UI

- Extend snapshot summaries with a notification-target count only; never display credentials.
- Add the notification domain to the partial restore checkbox list and select it by default.
- Update local-import confirmation copy to include notification configuration.
- Add a warning-colored disclosure to WebDAV notes: CLI-Manager serializes notification credentials in plaintext without application-level encryption; HTTP has no transport encryption and HTTPS only protects transport.
- Add a warning-colored disclosure to local export notes: the zip contains plaintext notification credentials.

## Security Boundary

- WebDAV password remains in the OS credential store and never enters the snapshot.
- Notification credentials intentionally enter the snapshot as plaintext by explicit product decision.
- No secrets are added to preview summaries, logs, toast descriptions, or conflict metadata.
- Existing WebDAV body-size and HTTP error handling remain unchanged.

## Compatibility

- Old snapshots with `settings: {}` preserve local notification configuration.
- New snapshots remain readable by the Rust backend because `settings` is `serde_json::Value`.
- The maximum restored target count remains 20 and invalid/unknown targets are filtered by the existing sanitizer.

## Rollback

Remove the two settings fields from collection/application and remove the restore-domain/UI additions. Existing remote snapshots remain valid because the backend treats settings as opaque JSON.
