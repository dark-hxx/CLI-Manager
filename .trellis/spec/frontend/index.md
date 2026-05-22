# Frontend Development Guidelines

> Working conventions for the React + Tauri frontend in this repository.

---

## Overview

These guides describe the frontend as it exists today:

- React function components in `src/components/`
- Global app state with Zustand stores in `src/stores/`
- Shared business types in `src/lib/types.ts`
- Styling built from Tailwind utilities plus centralized `ui-*` classes in `src/App.css`
- Quality gate centered on `npm run build` (`tsc && vite build`), plus manual interaction and accessibility checks

This package does not use a separate `pages/` directory, React Query, SWR, Zod, or a formal frontend test suite.
Document the current reality and extend existing patterns instead of importing a new architecture.

---

## Guidelines Index

| Guide | Description | Status |
|-------|-------------|--------|
| [Directory Structure](./directory-structure.md) | Module organization and file layout | Documented |
| [Component Guidelines](./component-guidelines.md) | Component patterns, props, composition | Documented |
| [Hook Guidelines](./hook-guidelines.md) | Custom hooks, data fetching patterns | Documented |
| [State Management](./state-management.md) | Local state, global state, async data flow | Documented |
| [Quality Guidelines](./quality-guidelines.md) | Build gate, review expectations, forbidden patterns | Documented |
| [Type Safety](./type-safety.md) | Type organization, runtime normalization, TS rules | Documented |

---

## How to Use These Guides

1. Start from the guide that matches the layer you are touching.
2. Reuse existing structures before adding a new folder, helper, hook, or primitive.
3. Prefer examples from the current codebase over generic React advice.
4. Treat `src/App.css`, `src/stores/`, and `src/lib/types.ts` as shared foundations, not ad hoc dumping grounds.

---

## Key Reference Files

- `src/App.tsx` - app shell composition and startup effects
- `src/App.css` - semantic tokens and shared `ui-*` styling primitives
- `src/components/sidebar/index.tsx` - feature shell composition and local-vs-global state boundary
- `src/stores/historyStore.ts` - largest async Zustand store, normalization, caching
- `src/lib/types.ts` - shared frontend business types

---

**Language**: All frontend guideline files in this directory are written in English on purpose.
