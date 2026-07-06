# command template sidebar redesign

## Goal

Redesign the terminal sidebar command template popover to match the generated mockup: denser, searchable, filterable, and action-oriented while keeping the existing template data model.

## Changelog Target

[TEMP]

## Requirements

* Keep the existing popover entry point in the terminal action sidebar.
* Redesign the popover header with a command icon, title, visible template count, and compact create toggle.
* Add local search across template name, command, and description.
* Add local scope filters for all, global, project, and session templates.
* Render template rows with icon, name, scope badge, command/description preview, and quick actions.
* Preserve one-click run behavior for active terminal sessions.
* Add edit support inside the same compact form used for creation.
* Use existing `templateStore`; do not change database schema or add dependencies.
* Keep all user-facing text in `src/lib/i18n.ts` for `zh-CN` and `en-US`.

## Acceptance Criteria

* [ ] The command template popover visually follows the generated dark compact mockup.
* [ ] Search filters visible templates by name, command, or description.
* [ ] Scope filters can switch between all/global/project/session.
* [ ] Run, edit, and delete actions are available from each template row.
* [ ] Creating and editing persistent templates still update SQLite-backed templates.
* [ ] Creating and editing session templates still update in-memory session templates.
* [ ] No unrelated data model, backend, or settings changes are introduced.
* [ ] `npx tsc --noEmit` passes or any pre-existing failure is reported.

## Definition of Done

* Implementation matches existing component/store patterns.
* i18n entries are complete in both supported languages.
* User-visible change is recorded in `CHANGELOG.md` under `[TEMP]`.
* GitNexus change detection is run before final summary.

## Technical Approach

Use local component state in `CommandTemplatePanel` for `searchQuery`, `scopeFilter`, and `editingTemplateId`. Reuse the existing create form for edit mode. Persistent templates call `updateTemplate`; session templates call `updateSessionTemplate`. Styling stays scoped to `#command-template-panel` and existing theme variables.

## Decision (ADR-lite)

**Context**: The generated mockup is a compact tool panel, not a settings page rewrite.

**Decision**: Implement the redesign in the existing popover component and store APIs only.

**Consequences**: Low blast radius and no migration risk. The settings page remains unchanged.

## Out of Scope

* New database fields or sorting persistence.
* Full settings page redesign.
* Runtime desktop verification by the agent.

## Technical Notes

* Main component: `src/components/CommandTemplatePanel.tsx`.
* i18n source: `src/lib/i18n.ts`.
* Scoped panel styling: `src/styles/components.css`.
* Existing store already exposes `updateTemplate` and `updateSessionTemplate`.
* GitNexus impact analysis for `CommandTemplatePanel`: LOW, no indexed upstream callers/processes.
