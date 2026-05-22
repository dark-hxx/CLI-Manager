# Type Safety

> Type safety patterns in this project.

---

## Overview

The frontend uses TypeScript in strict mode.
Type safety comes from three layers that already exist in the codebase:

1. compiler strictness in `tsconfig.json`
2. shared business types in `src/lib/types.ts`
3. manual runtime normalization around loose Tauri/backend payloads

Current repository facts:

- `tsconfig.json` enables `strict`, `noUnusedLocals`, `noUnusedParameters`, and `noFallthroughCasesInSwitch`
- shared app entities are centralized in `src/lib/types.ts`
- local props/store interfaces stay near the code that uses them
- the project does not currently use Zod, Yup, io-ts, or another systematic runtime validation library

---

## Type Organization

### Shared business types go in `src/lib/types.ts`

Use `src/lib/types.ts` for reusable domain entities and unions that are shared across components and stores.

Examples already there:

- `Project`, `Group`, `TreeNode`
- `CommandTemplate`, `CommandHistoryEntry`
- history entities such as `HistorySessionSummary`, `HistorySessionDetail`, `HistoryStatsPayload`
- literal unions such as `HistorySource`, `HistorySourceFilter`, `PromptScope`

### Local props and helper interfaces stay close to usage

Keep file-local types local when they are only used in one place.

Examples:

- `HistoryListPaneProps` in `src/components/history/HistoryListPane.tsx`
- `SettingsTopBarProps` in `src/components/settings/SettingsTopBar.tsx`
- `ProjectStore` in `src/stores/projectStore.ts`
- `SettingsStore` and `Settings` in `src/stores/settingsStore.ts`

### Store-specific unions can live in the store

If a type is tightly coupled to one store, it does not need to be promoted immediately to `src/lib/types.ts`.

Examples from `settingsStore.ts`:

- `ThemeMode`
- `LightThemePalette`
- `DarkThemePalette`
- `SidebarDensity`
- `ViewMode`

---

## Validation

### Current reality: manual runtime normalization

The codebase does not use a schema validation library.
Instead, runtime safety is handled manually at boundaries where data is loosely typed.

### Existing patterns to copy

#### Pattern: normalize raw backend payloads

`src/stores/historyStore.ts` uses helpers such as:

- `asString(...)`
- `asNumber(...)`
- `normalizeSummary(...)`
- `normalizeDetail(...)`
- `normalizeStats(...)`

This is the clearest existing pattern for handling `invoke<unknown>` safely.

#### Pattern: migrate persisted values before trusting them

`src/stores/settingsStore.ts` uses:

- `migrateLightThemePalette(...)`
- `migrateDarkThemePalette(...)`
- `migrateTerminalThemeName(...)`

That keeps legacy persisted values from leaking directly into UI state.

#### Pattern: parse JSON behind a guarded boundary

`src/components/sidebar/index.tsx` parses `project.env_vars` with `JSON.parse(...)` inside `try/catch` before using the result.

### Guidance

- Normalize `unknown` payloads before storing them
- Prefer helper functions over scattering `as SomeType` at every call site
- Use `try/catch` around JSON parsing and other untrusted persisted data

---

## Common Patterns

### Literal unions instead of free-form strings

Examples:

- `HistorySource = "claude" | "codex"`
- `PromptScope = "global" | "project" | "session"`
- `ViewMode = "standard" | "compact"`

### `Record` for keyed maps

Examples:

- `KeyboardShortcutMap = Record<ShortcutAction, string>` in `settingsStore.ts`
- `SessionMetaMap = Record<string, SessionMeta>` in `historyStore.ts`
- `projectHealth: Record<string, boolean>` in `projectStore.ts`

### Generic key-safe updates

`settingsStore.ts` uses:

```ts
update: <K extends keyof Settings>(key: K, value: Settings[K]) => Promise<void>
```

This is a good pattern for store APIs that update one known key at a time.

### `as const` for stable option lists

`src/lib/types.ts` uses `as const` for `SHELL_OPTIONS`, keeping values narrow and reusable.

### Narrowing runtime errors

Components often narrow caught errors before rendering messages, for example in `SyncSettingsPage.tsx`:

```ts
const message = error instanceof Error ? error.message : String(error);
```

---

## Forbidden Patterns

### Do not introduce `any` as the default escape hatch

This project is already configured for strict TypeScript. New code should not weaken that baseline.

### Do not trust `invoke(...)` payloads blindly

Bad pattern:

```ts
const rows = await invoke<MyType[]>("some_command");
set({ rows });
```

Preferred pattern in this repository:

- receive `unknown` or loosely typed payloads at the boundary
- normalize them with helper functions
- write normalized data into the store

### Do not spread type assertions everywhere when one normalizer would do

The repository still has some existing assertions around loose boundaries. Treat those as current debt, not a pattern to multiply.
Prefer one guarded normalizer over many `as X` casts at call sites.

### Do not create a schema-library dependency for one tiny boundary check

There is no current repo-wide validation library. Match the existing manual approach unless the project intentionally adopts a new standard.

### Do not duplicate shared business types in component files

If the type is already a domain entity used across stores/components, put it in `src/lib/types.ts` or reuse the existing definition.
