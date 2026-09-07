# Technical Design

## Integration boundary

Merge current `origin/master` into the contributor branch and resolve overlapping files
semantically. Preserve existing SFTP protocol 1.14 messages and introduce both Git history
and workspace-tool messages at protocol 1.15. Keep Tauri command names, request fields,
serialized response shapes, persisted keys, and events stable.

## Safety repairs

- Make schema readiness validate every required schema object and repair stale markers.
- Keep rewrite backup refs unique and reject unsafe/ambiguous repository paths.
- Gate mutating Git features on negotiated agent capabilities and require confirmations in UI.
- Repair nested interactive controls, keyboard visibility, dialog semantics, focus, and Escape.

## Target structure

Frontend uses `app`, `features/<domain>`, and `shared` layers. Rust uses thin `commands`,
`features/<domain>`, `infrastructure`, and `shared` layers. Cross-feature access is through
narrow public entry points; `shared` never imports a feature and features never import `app`.

## Architecture governance

`npm run check:architecture` scans tracked handwritten source and fails on files above 2,000
physical lines, disallowed layer dependencies, or handwritten logic lines above 500 characters.
`npm run report:architecture` emits a concise offender/token-oriented report. Explicit generated,
fixture, and SQL allowlists are reviewed and kept minimal.
