# Frontend Directory Structure

Read [AI Architecture Contracts](./ai-architecture-contracts.md) before adding modules.
Frontend implementation owners have moved; do not recreate the former layer-by-file-kind directories.

## Current Layout

```text
src/
  main.tsx                     # Stable bootstrap entry and lazy window selection
  app/                         # App composition and window-level UI
  features/<domain>/api/        # Direct public modules, no eager aggregate barrel
  features/<domain>/            # Internal components, hooks, store, lib, types, styles
  shared/preferences/          # App-wide persisted preferences, not settings UI
  shared/ui/, hooks/           # Reusable UI primitives and hooks
  shared/lib/, platform/       # Pure helpers and system/database/Monaco adapters
  shared/types/                # Shared data and wire contracts without transport imports
  shared/i18n/index.ts          # Translation runtime, no dictionary monolith
  shared/i18n/catalogs.ts       # Explicit dictionary composition
  shared/i18n/messages/         # <domain>.zh-CN.ts and <domain>.en-US.ts
  styles/components.css        # Ordered import manifest; preserve cascade
  styles/components/           # Named responsibility sections
```

## Ownership and Public Entries

`app` composes `features/<domain>` and `shared`. Add only needed feature directories:
`components`, `hooks`, `store`, `lib`, `types`, `i18n`, `styles`, `tests`.
Domains currently include agents, desktop-pet, files, git, history, projects, prompts,
providers, remote, settings, stats, sync, terminal and workspace.
Cross-feature imports use `api/<module>` or an existing explicit `index`/`state` entry.
Public modules hold cohesive implementations directly so lazy component imports do not load
unrelated state or UI. The seven old compatibility facades were removed after their callers moved.
Move one cohesive responsibility with its tests; no empty scaffolding, numbered chunks,
copying state or implementation, or large barrel exports.

## Focused Navigation

- Git translations: `src/shared/i18n/messages/git.zh-CN.ts` and `git.en-US.ts`.
- Terminal background: `src/styles/components/terminal-background.css`.
- Bounded Diff implementation: `src/features/git/components/diff/`; shared pinned hosts and dialog entries are under `features/git/api/`.
- File editor controller and Markdown navigation: `src/features/files/hooks/`; view: `features/files/components/`.
- Terminal state: `src/features/terminal/state.ts`; terminal UI: `src/features/terminal/index.ts`. Keep state callers off the UI entry to preserve lazy loading and avoid facade cycles.
- Locate the relevant domain via catalogs/import manifests; avoid reading all dictionaries/styles.
- After moving source, run `npm run check:architecture` and affected tests.
- Locale suffixes (`.zh-CN`) and `.worker` are names, not TypeScript extensions. Preserve
  extensionless imports and explicit worker `.ts` URLs independently during moves.
