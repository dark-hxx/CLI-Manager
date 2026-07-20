# History Session Contracts

## Scenario: SSH Remote History Workspace

### 1. Scope / Trigger

- Trigger: opening History for an SSH project, changing remote pagination/search/detail behavior, or changing offline cache state.

### 2. Contracts

- SSH projects reuse the existing history workspace and source IDs (`claude` / `codex`); they do not introduce `ssh-claude` or `ssh-codex`.
- The project supplies one Host/source/config-root/project-path context. Lists use cached catalog summaries first, then the Agent bridge; the first fetch requests 21 rows and displays 20.
- Load-more consumes cached rows first and only then advances the Agent `generation:offset` cursor. A generation change reloads from the first page instead of appending incompatible offsets.
- Remote search requires the existing three-character minimum. Online search uses the Agent index; failure falls back only to cached summary matching and marks freshness stale/error.
- Full messages, tool calls, sub-Agent records, and Diff are fetched on demand and retained only in the backend LRU. Offline detail is unavailable unless a separate explicit favorite snapshot exists.
- Remote sessions are read-only: edit/delete are rejected, and remote paths never route to local file/Git/provider commands.
- Resume first checks current SSH tabs by Host/source-instance/session identity. Otherwise it runs Agent preflight, offers only same-Host/source/config-root SSH projects, or an explicit original-remote-location option when no project matches.
- The resume command is returned by Rust after validating structured Agent args; the WebView never interpolates a session ID into shell syntax. Project startup commands are replaced, normal project environment plus canonical `CLAUDE_CONFIG_DIR`/`CODEX_HOME` are retained, and provider overrides remain disabled.
- Open/list/load-more/search/detail requests are generation-guarded. Results from a previous SSH project, filter, query, or selected session must not overwrite the current consumer, and stale `finally` handlers must not clear current loading state.

### 3. Tests Required

- Run `npx tsc --noEmit`.
- Manually switch rapidly between two SSH projects and between sessions while list/search/detail requests are in flight; only the latest context may render.
- Verify exact project resume, multiple same-Host project selection, original remote location, current-client Tab jump, active-elsewhere refusal, missing source/cwd, custom config root, and Hook-not-installed behavior.
- Disconnect after a successful sync and verify cached summaries remain visible with stale/offline state while uncached detail stays unavailable.

## Scenario: Favorite Session Snapshots

### 1. Scope / Trigger

- Trigger: changing history session favorites, session metadata storage, or behavior when original Claude/Codex history JSONL files are missing.

### 2. Signatures

- SQLite table: `session_meta`
  - `session_key TEXT PRIMARY KEY`
  - `starred INTEGER NOT NULL DEFAULT 0`
  - `alias TEXT NOT NULL DEFAULT ''`
  - `tags_json TEXT NOT NULL DEFAULT '[]'`
- SQLite table: `session_favorite_snapshots`
  - `session_key TEXT PRIMARY KEY`
  - `source TEXT NOT NULL`
  - `session_id TEXT NOT NULL`
  - `project_key TEXT NOT NULL`
  - `file_path TEXT NOT NULL`
  - `detail_json TEXT NOT NULL`
- Store action: `historyStore.updateMeta(sessionKey, { starred })`
- Backend detail command still remains the source-of-truth read path while the JSONL exists: `history_get_session`.

### 3. Contracts

- `session_meta.starred` is the favorite flag used for sorting and UI state.
- `session_favorite_snapshots.detail_json` stores a normalized `HistorySessionDetail` snapshot taken when the user favorites a session.
- Favoriting a session must save both the metadata flag and the snapshot.
- Unfavoriting a session must remove the snapshot.
- The history list should prefer live scanned JSONL sessions, then add favorite snapshots only for sessions missing from the scanned result.
- Opening a session should prefer `history_get_session`; if that fails and a favorite snapshot exists, the UI may show the snapshot as read-only historical content.

### 4. Validation & Error Matrix

- Source JSONL exists -> load via backend and ignore snapshot for freshness.
- Source JSONL missing + favorite snapshot exists -> show snapshot.
- Source JSONL missing + no snapshot -> keep existing backend error behavior.
- Snapshot JSON is malformed -> log a warning and do not show that snapshot.
- Project/source filter is active -> include only snapshots matching the same source and project filter.

### 5. Good/Base/Bad Cases

- Good: user favorites a session, deletes the original JSONL, reopens history, and can still open the saved transcript.
- Base: source JSONL still exists; live backend parsing is used and the snapshot is only a fallback.
- Bad: favorite stores only `session_meta.starred`, because deleted JSONL files make the favorite invisible.
- Bad: snapshot rows are shown without checking `session_meta.starred`, because canceled favorites would come back.

### 6. Tests Required

- Run `npx tsc --noEmit` after frontend store/type changes.
- Run `cd src-tauri && cargo check` after adding or changing migrations.
- Manual desktop check:
  - Favorite one Claude or Codex history session.
  - Confirm it remains listed after the original history JSONL is moved away.
  - Open it and verify the saved transcript appears.
  - Cancel favorite and verify the snapshot item disappears.

### 7. Wrong vs Correct

#### Wrong

```typescript
await db.execute("UPDATE session_meta SET starred = 1 WHERE session_key = $1", [sessionKey]);
```

#### Correct

```typescript
await updateMeta(sessionKey, { starred: true });
// updateMeta writes session_meta and session_favorite_snapshots together.
```

## Scenario: External History Project Sync Prompt

### 1. Scope / Trigger

- Trigger: changing how Claude/Codex history projects are detected, prompted, or materialized into the maintained project list.

### 2. Signatures

- Store action: `externalSessionSyncStore.openInitialDialog()`
- Store action: `externalSessionSyncStore.openManualDialog()`
- Store action: `externalSessionSyncStore.syncProjectCandidates(keys: string[])`
- History refresh caller: `HistoryWorkspace.handleRefreshSessions()`

### 3. Contracts

- Startup detection is only for empty maintained-project installs. `openInitialDialog()` must load project state first and return without scanning when `projectStore.projects.length > 0`.
- Manual detection is user-triggered from the history session list refresh action. It must still run when maintained projects exist.
- Manual detection should prompt only for history candidates whose project path/source is not already represented by a maintained project.
- No-candidate manual scans should use a toast and keep the sync dialog closed.
- Candidate and dialog copy must use `useI18n()` / `translateCurrent()` in `zh-CN`, `zh-TW`, and `en-US`.

### 4. Validation & Error Matrix

- Startup + projects exist -> mark initial prompt handled, no scan, no dialog.
- Startup + no projects + candidates exist -> show initial sync dialog with all candidates selected.
- Startup + no projects + no candidates -> mark initial prompt handled, no dialog.
- Manual refresh + missing project candidates exist -> refresh history list, then show manual sync dialog.
- Manual refresh + no missing project candidates -> refresh history list, show no-candidates toast, keep dialog closed.
- Scan failure -> clear scanning state and show scan-failed toast for manual scans; log warning for startup scans.

### 5. Good/Base/Bad Cases

- Good: a user with an existing project list clicks history refresh and only sees a sync prompt when history contains a new, unmaintained project.
- Base: a fresh install with no projects still gets the first-run detection prompt.
- Bad: startup scans every launch even though the user already maintains projects.
- Bad: history refresh opens an empty sync dialog when there are no missing projects.

### 6. Tests Required

- Run `npx tsc --noEmit` after frontend store/component changes.
- Manually verify the history refresh button reloads sessions and opens the sync dialog only when missing projects exist.
- Manually verify Settings -> General language switching updates the sync dialog, tooltips/aria labels where visible, and toasts across `zh-CN`, `zh-TW`, and `en-US`.

### 7. Wrong vs Correct

#### Wrong

```typescript
void useExternalSessionSyncStore.getState().openInitialDialog();
```

#### Correct

```typescript
await ensureProjectStoreLoaded("startup");
if (useProjectStore.getState().projects.length > 0) {
  set({ initialSyncPromptHandled: true, scanningProjects: false, projectCandidates: [] });
  await persistCurrentState(get());
  return;
}
```

## Scenario: Resume History Session With Project CLI Arguments

### 1. Scope / Trigger

- Trigger: changing the history detail/list resume action, project matching, or resume command construction.

### 2. Signatures

- Project candidates: `findHistoryProjects(session, projects): Project[]`.
- Command builder: `appendResumeCliArgs(baseCommand, source, project): string`.
- Terminal creation keeps the existing `terminalStore.createSession(...)` contract.

### 3. Contracts

- Both the detail action and list context-menu action must enter the same resume flow.
- Match maintained projects by history `cwd` first, then by `project_key`, and require the project's CLI type to match the history source.
- One candidate resumes directly; multiple candidates require explicit selection; cancel creates no terminal.
- The selected project supplies `cli_args`, provider overrides, environment variables, shell, and Worktree overrides.
- Zero matching candidates must show all maintained projects plus a localized `Use New Window` option instead of stopping with an error.
- `Use New Window` creates an unscoped internal terminal with the resolved history working directory as PTY `cwd`, then runs the bare resume command without project CLI arguments.
- If no working directory can be resolved, stop with a localized error and create no terminal.

### 4. Validation & Error Matrix

- Invalid session ID or unsupported source -> localized error, no terminal.
- Zero compatible project candidates -> show all projects plus `Use New Window`; cancel -> no terminal.
- `Use New Window` + valid history working directory -> create an unscoped terminal in that directory, then run the resume command.
- `Use New Window` + missing history working directory -> localized error, no terminal.
- One compatible candidate -> create the terminal with its launch configuration.
- Multiple compatible candidates -> show the searchable grouped picker; cancel -> no terminal.
- Worktree match -> use the owning project configuration plus Worktree path/provider overrides.

### 5. Good/Base/Bad Cases

- Good: two Claude project records match one history directory; the user selects one and its `cli_args` appear after `claude --resume <id>`.
- Base: one Codex project matches exactly and resumes without an extra prompt.
- Bad: project lookup uses `find()` and silently chooses the first duplicate.
- Bad: zero matching projects immediately produce an error without offering a manual project choice.
- Bad: `Use New Window` starts in the application default directory and only then tries to recover the intended cwd.

### 6. Tests Required

- Run `npx tsc --noEmit`.
- Manually verify detail and context-menu resume for Claude/Codex, one/multiple/no candidates, picker cancel, Local/WSL/Bash, and main project/Worktree.
- Switch between `zh-CN`, `zh-TW`, and `en-US` and verify picker, aria labels, and errors.

### 7. Wrong vs Correct

#### Wrong

```typescript
const project = projects.find(matchesHistoryProject);
const command = appendResumeCliArgs(baseCommand, source, project);
```

#### Correct

```typescript
const candidates = findHistoryProjects(session, projects);
if (candidates.length === 0) return openProjectPicker(projects, { allowNewWindow: true });
if (candidates.length > 1) return openProjectPicker(candidates);
return resumeWithProject(session, candidates[0]);
```

## Scenario: History File Change Records

### 1. Scope / Trigger

- Trigger: changing history JSONL file-operation parsing, the history Changes view, or history Diff rendering.

### 2. Signatures

- Backend detail field: `HistorySessionDetail.file_changes: HistoryFileChangeSummary[]`.
- File operation location: `message_index`, `operation_group_index`, and `timestamp` on `HistoryFileChangeOperation`.
- Shared renderer: `GitDiffViewer({ diffText, filePath, fileName, status })` with no discard callback for history.

### 3. Contracts

- The session JSONL is the source of truth; do not infer historical content from the current workspace file.
- Decode escaped Codex apply-patch text before extracting paths and line counts.
- Changes view rows use `getMaterialFileIcon()` like the file explorer.
- Changes view rows show Added/Modified/Deleted semantic tags; additions use success color and deletions use danger color.
- Left click opens a read-only `GitDiffViewer`; right click jumps to `message_index` when present.
- Convert Apply Patch blocks to standard unified diff before rendering so the viewer keeps split mode.
- History must not pass `onRequestDiscard`, so file/hunk/line revert actions stay disabled.

### 4. Validation & Error Matrix

- Structured operations exist -> prefer `file_changes` over message-text fallback.
- Missing `message_index` -> keep the change visible and disable the jump menu item.
- Apply Patch input -> synthesize unified headers and hunk ranges, then render through split mode.
- Unsupported patch after normalization -> `GitDiffViewer` falls back to the read-only Monaco diff editor.
- No parsed changes -> show the history empty state.

### 5. Good/Base/Bad Cases

- Good: escaped Codex patch shows the real file icon/path and opens the shared read-only Diff viewer.
- Base: a legacy message-only unified diff remains available through the worker fallback.
- Bad: reading the current workspace file to fabricate an old baseline.
- Bad: maintaining a second history-only Diff renderer with different highlighting behavior.

### 6. Tests Required

- Rust regression: Claude tool input and escaped Codex apply-patch input produce paths, groups, additions, and deletions.
- Frontend: run `npx tsc --noEmit` after changing row props, context menus, or shared Diff viewer props.
- Manual: verify left-click Diff, right-click conversation jump, disabled jump without message index, and file icons in both languages.

### 7. Wrong vs Correct

#### Wrong

```tsx
<FileCode2 />
<HistoryOnlyDiff patch={operation.patch} />
```

#### Correct

```tsx
<img src={getMaterialFileIcon(fileName)} alt="" />
<GitDiffViewer filePath={path} fileName={fileName} status={status} diffText={patch} />
```
