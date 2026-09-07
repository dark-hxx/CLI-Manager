# Markdown navigation design

## Root cause and evidence

The renderer/editor-to-navigation boundary has no shared document-aware link dispatch: file preview disables external links, fragment anchors use default WebView navigation, heading IDs disagree with document fragments, and the source editor has no application link handler. Repair destination classification and activation at this boundary, not by stripping `tauri.localhost` from a browser URL after navigation.

Confirmed from source: FileEditorContent.tsx:112; MarkdownContent.tsx:156-216 and heading renderers; FileEditorPane.tsx:126. The precise native behavior that launches the browser for default fragment navigation still needs a desktop reproduction; source inspection proves the absent interception, not the entire native event chain.

## Architecture

1. Add a pure Markdown navigation module for destination classification, single-pass decoding, project-relative normalization, source link ranges and deterministic heading targets/source positions.
2. Use Markdown parsing facilities already present where usable. Inspect installed APIs before selecting parsing integration; avoid regular expressions as the sole parser for reference links, nested parentheses, formatted headings and fenced code exclusions. Any new direct dependency requires explicit design review.
3. Derive heading IDs consistently from Markdown syntax, including repository-style leading hyphens after Emoji removal, duplicate suffixes starting at `-1`, and collision handling. Compute IDs per document, independent of React render invocation order. Where unambiguous, preserve old generated IDs as lookup aliases; canonical IDs win ambiguous collisions.
4. Add an optional document link callback to MarkdownContent. Intercept fragment/heading links inside that component's root and use raw `href` attributes. Never pass resolved `HTMLAnchorElement.href` to the dispatcher, since it incorporates the Tauri origin. Root-scoped target lookup prevents duplicate IDs in other panes from receiving navigation.
5. FileEditorPane owns document navigation and pending target identity; FileEditorContent wires preview and Monaco activation into it. Prefer a dedicated hook to keep loading and editor lifecycle logic out of render code.
6. Source activation resolves the pointer position against parsed link ranges in the current model. Register/dispose editor handlers on mount/model change; avoid a global Monaco opener that would affect diff editors or other consumers. Support Ctrl + right-click explicitly; preserve normal source editing and ordinary context menus. Inspect Monaco's existing Ctrl + left-click behavior to avoid competing browser activation.
7. Reuse fileExplorerStore.revealPath for project-bound files/directories, and its existing unsaved-buffer behavior. Normalize `.`/`..` before invoking it. Directory targets reveal the tree; file targets use existing preview kinds. Do not add filesystem/IPC permissions.
8. For cross-file fragments, carry target project/location, path, fragment, originating mode and a monotonically increasing request identity. Apply only once the matching file is loaded and the correct renderer/editor is ready. Invalidate on project changes, unrelated manual file selection, disposal or superseding navigation. Existing source search navigation forces source mode; do not overload it in a way that breaks preview navigation.

## Destination contract

- `#fragment`: same document; `#` means top.
- `http:`/`https:`: system browser with original URL, including query/fragment.
- `mailto:`: existing opener, with the same single-activation/error handling.
- Relative paths and project-root `/` paths: same project/environment only. Split raw fragment before decoding path so `%23` remains a filename character. Do not interpret local file query strings as web parameters without an explicit rule; reject unsupported local query syntax with feedback.
- Windows absolute paths, UNC and file URLs: resolve only if safely representable within the current project's existing root/environment; otherwise report unsupported/outside-project. Never reinterpret SSH/WSL targets as local Windows files.
- Unsupported schemes, malformed escapes and traversal outside project: explicit error, no navigation.

## Discovery list and blast radius

- [x] MarkdownContent.tsx: shared renderer, link activation and headings; expected edits.
- [x] FileEditorContent.tsx: file preview behavior and Monaco surface; expected edits.
- [x] FileEditorPane.tsx: project ownership, preview reset, editor readiness and pending navigation; expected edits.
- [x] fileExplorerStore.ts: revealPath/openFile and environment checks; reuse first, inspect race behavior before deciding whether store edits are required.
- [x] useFileEditorSearchNavigation.ts: existing line reveal and forced source behavior; preserve search contract.
- [x] monacoSetup.ts: no Markdown document navigation registration; prefer scoped file editor integration instead of global changes.
- [x] HistoryMarkdownContent, PromptLibrary, AboutSection and SubagentTranscriptView: consumers requiring renderer regressions; not authorized for unrelated policy changes.
- [x] TerminalMarkdownPreview and SessionTranscriptContent: indirectly share rendering; regression check.
- [x] i18n.ts and delivery documents: localized messages and product records.
- [x] Backend: no changes planned; project-bound existing file operations are the intended boundary.

GitNexus query returned no results and reported missing FTS indexes. context/impact could not resolve MarkdownContent and returned UNKNOWN, not LOW. Direct source/import inspection identified the consumers above. Before any symbol edits, run impact for each concrete symbol/file and use the repository's documented fallback if unavailable. Do not claim a verified call-graph risk count from this degraded index. Qualitative risk is shared-renderer regression and stale asynchronous file selection.

## Compatibility and rollback

No database migration or new external protocols. Preserve existing non-file Markdown linkBehavior defaults; scoped anchors may be repaired centrally. Keep document context optional. Rollback the navigation hook, parser and renderer integration together; no persisted data needs migration. Preserve existing dirty buffers and unrelated working-tree edits.
