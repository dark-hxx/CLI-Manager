# Frontend Directory Structure

Read [AI Architecture Contracts](./ai-architecture-contracts.md) before adding modules.
Migration is incremental; do not assume legacy directories have already moved.

## Current Layout

```text
src/
  App.tsx, main.tsx             # Current app composition/entry
  components/, hooks/, stores/  # Existing domain implementations; migration pending
  lib/i18n.ts                   # Stable translation runtime, no dictionary monolith
  shared/i18n/catalogs.ts       # Explicit dictionary composition
  shared/i18n/messages/         # <domain>.zh-CN.ts and <domain>.en-US.ts
  styles/components.css        # Ordered import manifest; preserve cascade
  styles/components/           # Named responsibility sections
```

## Target and Migration

`app` composes `features/<domain>` and `shared`. Add only needed feature directories:
`components`, `hooks`, `store`, `lib`, `types`, `i18n`, `styles`, `tests`.
Keep public entries narrow and retain explicit compatibility facades until callers move.
Move one cohesive responsibility with its tests; no empty scaffolding, numbered chunks,
copying state or implementation, or large barrel exports.

## Focused Navigation

- Git translations: `src/shared/i18n/messages/git.zh-CN.ts` and `git.en-US.ts`.
- Terminal background: `src/styles/components/terminal-background.css`.
- Existing bounded Diff modules: `src/components/git/diff/`.
- Locate the relevant domain via catalogs/import manifests; avoid reading all dictionaries/styles.
- After moving source, run `npm run check:architecture` and affected tests.
