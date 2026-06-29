# Fix terminal dark theme image background black boxes

## Goal

Fix issue #68: when the terminal is in dark mode and a terminal background image is enabled, Claude Code / Codex CLI output can render many opaque black background blocks. The same flows should remain readable while preserving the configured background image.

## Requirements

- Fix the built-in terminal dark-theme + background-image black-box rendering problem.
- Keep the existing light-theme background-image behavior working; it was already fixed separately.
- Keep the fix scoped to xterm rendering/background handling. Do not change Codex/Claude provider switching, startup command generation, backend PTY logic, or project metadata.
- Reuse existing terminal transparency and TUI composer normalization patterns where possible.
- Avoid broad ANSI stream rewriting. If correcting visual state, do it after xterm has parsed output, via the existing buffer-cell normalization path.
- Do not add dependencies.
- Do not overwrite unrelated current working-tree changes.

## Acceptance Criteria

- [ ] In dark app theme + terminal theme following app + background image enabled, Claude/Codex TUI rows do not show opaque black boxes over the background image.
- [ ] Codex hooks/trust approval screens do not show opaque black strips on known action rows such as review options and `Press enter to confirm...`.
- [ ] In dark terminal independent mode + any dark terminal preset + background image enabled, the same black-box issue is reduced/removed.
- [ ] In light terminal mode + background image enabled, existing behavior remains normal.
- [ ] With no terminal background image, normal terminal/TUI backgrounds are unchanged.
- [ ] The change is limited to terminal rendering files and Trellis task artifacts.
- [ ] `npx tsc --noEmit` passes, or failures are reported clearly if unrelated to this task.

## Definition of Done

- Requirements and investigation are recorded in this PRD and `research/issue-68-terminal-background.md`.
- Implementation follows frontend terminal guidelines.
- Static/type checks are run where feasible.
- Manual verification items are listed because this project requires human runtime UI verification for terminal visual changes.
- No git commit unless explicitly requested.

## Technical Approach

Use the existing `normalizeTuiComposerBackground()` logic in `src/components/XTermTerminal.tsx`, but change its enablement gate from "light terminal background" to "terminal background image transparency is active". This keeps the already narrow prompt-row scan and explicit-background/wide-inverse cleanup, while covering the dark-theme background-image case from issue #68.

Also clear known Claude/Codex-style action/approval rows, such as hooks review menus and `Press enter to confirm...`, when those rows contain explicit background or wide inverse attributes. This is still not a global ANSI background cleanup.

Do not clear cell backgrounds globally. The cleanup must stay scoped to Claude/Codex-like TUI composer rows through the existing prompt-signature detection and small prelude/continuation range.

Do not disable WebGL as the primary fix. xterm/WebGL/transparent-background artifacts are a known risk area, but switching the renderer for all dark background-image users is a broader performance/rendering change. Keep that as a fallback only if manual verification shows the targeted cell cleanup is insufficient.

## Decision (ADR-lite)

**Context**: The light-theme fix already clears bad xterm cell background/inverse attributes for Claude/Codex composer rows. Issue #68 confirms the remaining bug appears only when a background image is active under dark terminal themes.

**Decision**: Extend the existing xterm buffer-cell cleanup to background-image mode regardless of terminal brightness, while keeping the cleanup limited to detected TUI composer rows. Do not add provider/startup-command workarounds, do not rewrite raw ANSI streams, and do not change renderer selection in the first pass.

**Consequences**: This is a small, targeted rendering fix. It may make intentional TUI background fields around composer rows transparent, but that is acceptable for the reported background-image mode and avoids breaking normal no-image terminal rendering. If dark-theme artifacts remain after this fix, the next fallback to evaluate is disabling WebGL only when a background image is active.

## Out of Scope

- Changing Codex/Claude provider switching.
- Changing `projectStartupCommand.ts`.
- Adding new terminal background settings.
- Redesigning terminal theme presets.
- Backend/Rust changes.
- Fixing arbitrary ANSI-colored blocks outside Claude/Codex-like TUI composer rows.

## Technical Notes

- Issue #68: https://github.com/dark-hxx/CLI-Manager/issues/68
- Related archived PRD requested by user: `.trellis/tasks/archive/2026-06/06-26-codex-project-provider-switching/prd.md`
- Existing light-background behavior: `.trellis/tasks/archive/2026-06/06-28-fix-light-terminal-background-contrast/prd.md`
- Relevant code: `src/components/XTermTerminal.tsx`, `src/lib/terminalThemes.ts`
- Relevant spec: `.trellis/spec/frontend/component-guidelines.md`, `.trellis/spec/frontend/quality-guidelines.md`
- Web/xterm review: `research/xterm-transparent-ansi-cells.md`
- Current GitNexus index is stale (`npx gitnexus status` reports indexed commit `1213655`, current commit `e68e06e`). Refresh before impact analysis if implementation proceeds.
