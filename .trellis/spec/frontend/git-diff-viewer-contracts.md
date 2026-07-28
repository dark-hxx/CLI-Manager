# Git Diff Viewer Contracts

## Data Source Boundary

- Shared Diff rendering consumes a discriminated `snapshot | live` data source.
- A snapshot contains text only and cannot expose mutation actions at the type level.
- A live source owns its loader and may inject explicit mutation capabilities.
- Viewer components and controllers must not invoke Tauri commands, inspect SSH state, or read the global Git Store directly.
- Local, WSL, macOS/Linux desktop, and SSH differences stay behind the caller-provided transport capability.

## Target Identity

- Every load is bound to a stable target identity plus file path, file name, and status.
- When target identity changes, the controller clears the previous selection and ignores completion from the old request.
- Consumers must not reuse a live source for a different repository context without changing target identity.

## Component Responsibilities

- `DiffViewerModal.tsx`: compatibility adapter, portal, overlay, and keyboard lifecycle only.
- `diff/useGitDiffController.ts`: load state, metadata, selection, and mutation orchestration.
- `diff/GitDiffViewer.tsx`: composition only.
- `diff/GitDiffContent.tsx`: loading/error/empty/parsed/fallback rendering.
- `diff/useGitDiffParser.ts` and `diff/gitDiffParser.worker.ts`: sync/Worker parse policy, generation cancellation, and fallback state.
- `diff/GitDiffHunkList.tsx`: Hunk virtualization, measurement, scroll, and cross-Hunk focus restoration.
- `diff/GitDiffHunkBlock.tsx`: one mounted Hunk, threshold-gated tokenization, gutter events, and Hunk revert command.
- `diff/GitDiffHeader.tsx`: file-level commands and close action.
- `diff/GitDiffSelectionBar.tsx`: partial-revert status and selected-line commands.
- `diff/types.ts`: target, data-source, mutation, parse, and controller contracts.

New navigation, display options, pinned-editor hosting, accessibility, and performance work must extend these boundaries instead of rebuilding a second Diff viewer.

## Compatibility

- Git changes use a live source with explicit load and mutation actions.
- File editor Diff uses an explicit project-bound live source.
- History and terminal-stat Diff use snapshots and remain read-only.
- Unsupported text parsing falls back to the existing read-only Monaco renderer; supported file types remain unchanged.

## Review Navigation

### 1. Scope / Trigger

- `GitDiffReviewDialog` is used only for the live Git changes review flow.
- Snapshot consumers and the file editor compatibility facade do not receive file-list navigation.

### 2. Signatures

```ts
buildGitDiffReviewTargets({
  tree,
  untrackedTree,
  statusFilter,
  repositoryPath,
  repositoryRelativePath,
}): GitDiffReviewTarget[];

type GitDiffViewMode = "split" | "unified";
```

### 3. Contracts

- The review dialog owns the filtered target list and active target identity; the controller owns the active Hunk within one target.
- Target identity is repository context plus repository-relative file path. Status and line counts must not participate in identity, so refresh can retain the same target.
- Target order is the rendered tracked tree followed by the rendered untracked tree. `M` and `D` filters exclude the untracked tree, matching `GitChangesPanel`.
- `F7` and `Shift+F7` are handled by the focusable review viewer only. They must not install a global listener or affect terminals and other windows.
- Moving past a file boundary selects the adjacent target and initializes its first or last Hunk. Navigation never wraps.
- Source opening is an injected capability. The review layer passes the project-relative source path plus the active Hunk `newStart`; it never invokes Tauri or branches on local, WSL, macOS/Linux, or SSH state.
- `settingsStore.gitDiffViewMode` defaults to `split`, accepts only `split | unified`, and belongs to the `preferences` sync domain.

### 4. Validation & Error Matrix

- Persisted mode outside `split | unified` -> migrate to `split`.
- Active target removed on refresh -> retain its previous index and select the adjacent target.
- No review targets remain -> close the review dialog.
- Deleted target -> disable source opening.
- Parsed Diff has no Hunks -> keep file-level navigation available.

### 5. Good / Base / Bad Cases

- Good: an SSH nested-repository target keeps Git paths repository-relative while source reveal receives the project-relative prefixed path.
- Base: a one-file, one-Hunk review disables both navigation boundary buttons.
- Bad: using `status` in target identity remounts the viewer during refresh and loses navigation position.
- Bad: registering `F7` on `window` steals the shortcut from terminals outside the review dialog.

### 6. Tests Required

- Unit-test tracked/untracked order, `M`/`D` filtering, repository identity, refresh reconciliation, Hunk/file transitions, boundaries, and zero-Hunk fallback.
- Assert settings default, persisted-value validation, and preference-sync classification.
- Run the shared Viewer architecture test and the SSH Git regression test.

### 7. Wrong vs Correct

```ts
// Wrong: environment and global state leak into the shared viewer.
window.addEventListener("keydown", handleF7);
invoke("git_get_file_diff", { projectPath, filePath });

// Correct: the host injects transport and source-reveal capabilities.
<GitDiffReviewDialog loadDiff={gitStore.loadFileDiff} onOpenSource={revealSource} />
```

## Diff Generation Options

### 1. Scope / Trigger

- Applies to live Git review and pinned-editor Diff loading for local, WSL, macOS/Linux, and SSH repositories.
- Snapshot consumers remain unchanged and do not expose generation controls.

### 2. Signatures

```ts
type GitDiffWhitespaceMode = "exact" | "ignore-eol" | "ignore-all";
type GitDiffContextLines = 3 | 10 | 20;

interface GitDiffOptions {
  whitespace: GitDiffWhitespaceMode;
  contextLines: GitDiffContextLines;
}

GitTransport.getFileDiff(
  repoId: string,
  path: string,
  status: string,
  options?: GitDiffOptions,
): Promise<GitTransportResult<GitFileDiffPayload>>;
```

### 3. Contracts

- The default is `exact` plus 3 context lines. Omitting `options` preserves the legacy request and result.
- `settingsStore.gitDiffWhitespaceMode` and `settingsStore.gitDiffContextLines` belong to the `preferences` sync domain; invalid persisted values migrate to the defaults.
- Desktop local uses libgit2 `ignore_whitespace_eol`, `ignore_whitespace`, and `context_lines`. WSL and SSH CLI use `--ignore-space-at-eol`, `--ignore-all-space`, and `--unified=N`.
- A non-`exact` payload always returns `canRevertHunks=false`. The controller must also guard its Hunk and line mutation callbacks; hiding buttons alone is insufficient.
- SSH sends explicit `exact+3` through legacy `gitDiff` without an `options` field. Non-default values use `gitDiffWithOptions` and require `gitDiffOptions` capability.

### 4. Validation & Error Matrix

| Condition | Behavior |
|---|---|
| Missing options | Normalize to `exact+3` |
| Persisted whitespace/context outside the fixed enums | Migrate to `exact+3` |
| Rust request contains unsupported context lines or unknown fields | Reject at the command/Agent boundary |
| Non-exact Diff | Return `canRevertHunks=false`; keep whole-file discard available |
| SSH Agent lacks `gitDiffOptions` | Show localized upgrade guidance; do not write the request frame |
| Non-UTF-8, binary, untracked, or conflict target | Preserve the existing read-only/safe fallback |

### 5. Good / Base / Bad Cases

- Good: changing from 3 to 20 context lines reloads the same stable target without changing repository identity.
- Base: an old SSH Agent receives only legacy `gitDiff` for `exact+3` and continues working.
- Bad: send `{ options: { whitespace: "exact", contextLines: 3 } }` with legacy `gitDiff`; published Agents reject the unknown field.
- Bad: allow `revertHunk` to execute only because the method is callable after the UI button was hidden.

### 6. Tests Required

- Run real Git fixtures for all whitespace modes and 3/10/20 context lines on Desktop native and POSIX Agent CLI paths.
- Assert invalid context rejection, non-exact `canRevertHunks=false`, settings migration/sync, and controller mutation guards.
- Assert the daemon rejects a missing capability before request serialization and that explicit default SSH options produce a field-compatible legacy payload.

### 7. Wrong vs Correct

```ts
// Wrong: legacy Agent rejects the unknown options field.
request("gitDiff", { repoPath, relativePath, status, options });

// Correct: preserve the legacy wire shape; negotiate only new behavior.
const legacy = isDefaultGitDiffOptions(options);
request(
  legacy ? "gitDiff" : "gitDiffWithOptions",
  legacy ? { repoPath, relativePath, status } : { repoPath, relativePath, status, options },
);
```

## Pinned Editor Workspace

### 1. Scope / Trigger

- Applies when a live Git review target is pinned into the existing `file-editor` surface.
- Snapshot consumers remain read-only and never create pinned tabs.

### 2. Signatures

```ts
acquireGitTransportLease(project: Project): Promise<GitTransportLease>;
createGitDiffTabId(contextKey: string, repositoryId: string, filePath: string): string;
```

### 3. Contracts

- Pinned tabs live in `gitDiffWorkspaceStore`, keyed by project id, environment, host, and normalized project path; repository id plus repository-relative file path identifies one tab.
- The workspace stores serializable identity only. It must not store a `Project`, `GitTransport`, callback, or request promise.
- `FileEditorPane` composes `GitDiffEditorHost`; it must not own Git IPC, Transport creation, Diff loading, or revert mutations.
- The Git panel and pinned host acquire reference-counted leases. A pinned mutation uses its own lease and only calls `gitStore.refreshIfContext(contextKey)` as a context-guarded notification.
- Background pinned refresh updates only the pinned target. It must not duplicate the Git panel polling request.
- Local Windows drive identities are case-insensitive; POSIX and WSL path segments preserve case. Local and WSL environments never share a lease key.

### 4. Validation & Error Matrix

| Condition | Behavior |
|---|---|
| Same project/repository/file is pinned again | Update metadata and activate the existing tab |
| Same file path exists in another nested repository | Open a distinct tab |
| Active change disappears after refresh | Close that pinned tab and select an adjacent tab |
| Project/host/remote path/Agent installation changes | Release the old lease and ignore its late results |
| Pinned Transport acquisition fails | Show a localized error state; never fall back from SSH to local Git |
| Revert confirmation remains open while another tab is selected | Keep the message and mutation bound to the originally requested tab |

### 5. Good / Base / Bad Cases

- Good: closing the Git panel leaves the pinned SSH Diff operational because the pinned host still owns a lease.
- Base: closing the last consumer releases `history_remote_close`; local and WSL disposal is a no-op.
- Bad: storing the current global `gitStore.transport` in a pinned tab or using it for a write after project switching.
- Bad: lowercasing a POSIX project path and merging `/Work/Repo` with `/work/repo`.

### 6. Tests Required

- Unit-test concurrent acquire, idempotent release, final-consumer disposal, and acquire-during-release ordering.
- Unit-test Windows root normalization, POSIX/WSL case sensitivity, project path isolation, root/nested repository identity, and duplicate-tab activation.
- Assert `FileEditorPane` has no Git IPC/mutation ownership and all pinned-editor responsibility modules remain at most 300 lines.
- Run the shared Viewer navigation, settings, architecture, and SSH root-repository regressions.

### 7. Wrong vs Correct

```ts
// Wrong: a pinned write follows whichever panel context is current now.
await useGitStore.getState().discardFile(tab.filePath, tab.status);

// Correct: the pinned host writes through its own leased capability.
await lease.transport.discardFile(tab.repositoryId, tab.filePath, tab.status);
await useGitStore.getState().refreshIfContext(lease.contextKey);
```

## Interaction And Accessibility

### 1. Scope / Trigger

- Applies to selectable insert/delete gutters in the shared live Diff viewer and to the modal Dialog host.
- Snapshot Diff remains read-only; pinned Diff uses the same selection semantics without adding a second Dialog.

### 2. Signatures

```ts
interface GitDiffSelectionState {
  selectedKeys: ReadonlySet<string>;
  anchors: Partial<Record<"old" | "new" | "unified", GitDiffSelectionAnchor>>;
}

applyGitDiffSelection(state, { target, order, scope, extend }): GitDiffSelectionState;
findAdjacentGitDiffChange(order, currentKey, side, direction): GitDiffSelectableChange | null;
```

### 3. Contracts

- Selection order comes from parsed Hunk changes, never DOM row numbers. Normal lines are absent from the selectable order.
- Split mode owns independent old/new anchors. Unified mode owns one anchor and resets to the current line when Shift selection crosses sides.
- Click and Enter/Space toggle one insert/delete. Shift+click and Shift+Arrow extend across the same side's visible change order.
- A Diff content, target, generation-option, or view-mode identity change clears selection and anchors.
- `canRevertLines` gates pointer handlers, keyboard handlers, focusable gutters, and Controller mutation execution.
- Selected state uses background, inset border, a visible check mark, `aria-pressed`, and a polite live count. Insert/delete keep visible `+`/`-` markers.
- Modal hosts use the shared Radix Dialog primitive for modal semantics, focus trapping, top-layer Escape, and focus restoration. IME-composing Escape is ignored.
- Dialog accessible names contain the active file name. Opening focuses the first enabled toolbar/header command.

### 4. Validation & Error Matrix

| Condition | Behavior |
|---|---|
| Normal line gutter | Not focusable or selectable |
| Shift range contains normal/opposite-side lines | Select only same-side insert/delete entries |
| Split side has no anchor | Select current line and establish only that side's anchor |
| Unified Shift target changes side | Clear the previous range and select the target only |
| Non-UTF-8, non-exact, untracked, or backend-disabled payload | No interactive gutter; partial mutation remains guarded |
| Escape while IME is composing | Keep the Dialog open |
| Nested confirmation Dialog is open | Only Radix's top dismissable layer handles Escape |

### 5. Tests Required

- Unit-test toggle, split anchors, unified cross-side reset, same-side range filtering, and keyboard adjacency.
- Assert the Dialog has Radix autofocus/restore hooks and no `window` key listener.
- Assert focusable gutters expose marker, check, and pressed semantics; selection count uses `aria-live`.
- Run shared Viewer architecture, navigation, generation-option, settings, and pinned-editor regressions.

## Large Diff Performance And Limits

### 1. Scope / Trigger

- Applies to shared text Diff rendering for snapshot and live sources on Windows, Linux, macOS, WSL, and SSH.
- It changes parsing and rendering policy only. Binary, image, office, archive, audio, and video Diff support must not be added here; the supported file types and existing read-only fallbacks remain unchanged.

### 2. Signatures

```ts
interface GitFileDiffPayload {
  content: string;
  canRevertHunks: boolean;
  byteLength: number;
  lineCount: number;
}

normalizeGitDiffPayload(payload: {
  content: string;
  canRevertHunks: boolean;
  byteLength?: number;
  lineCount?: number;
}): GitFileDiffPayload;
```

### 3. Contracts

- Diff content at or below 64 KiB parses synchronously; larger accepted content parses in `gitDiffParser.worker.ts`.
- Each Worker request carries a generation. Cleanup invalidates the generation and terminates the Worker; success or fallback also terminates it immediately and settles only once.
- Worker failure falls back to main-thread parsing with syntax highlighting disabled. Only parsing failure enters the existing read-only Monaco raw-patch fallback.
- Syntax highlighting is enabled only at or below both 256 KiB and 5000 lines. Mounted Hunk blocks tokenize independently; unmounted Hunks create neither tokens nor row DOM.
- `GitDiffHunkList` virtualizes by Hunk with dynamic measurement. Keyboard navigation may scroll an unmounted target Hunk first, but it must restore focus only if the pending file identity still matches.
- Local and SSH transports normalize payload metadata at their boundary. Missing metadata from an older Agent is derived with UTF-8 byte length and Rust `str::lines()` semantics.
- Content above 768 KiB or 20000 lines is rejected with `git_diff_too_large`; it is never truncated and never exposes Hunk/line revert actions.

### 4. Validation & Error Matrix

| Condition | Behavior |
|---|---|
| `byteLength <= 64 KiB` | Parse synchronously |
| `byteLength > 64 KiB` within hard limits | Parse in Worker; toolbar and close remain responsive |
| `byteLength > 256 KiB` or `lineCount > 5000` | Render insert/delete/Hunk styles without syntax tokens |
| Worker construction, execution, or response failure | Terminate once; parse on main thread without highlighting |
| Target/content changes while Worker or virtual focus is pending | Ignore old result and old focus request |
| `byteLength > 768 KiB` or `lineCount > 20000` | Localized `git.diff.tooLarge`; no partial-revert entry |
| Parser rejects otherwise accepted text | Read-only Monaco raw-patch fallback |

### 5. Good / Base / Bad Cases

- Good: an accepted 300 KiB SSH Diff parses in a Worker and renders virtualized plain Hunks without syntax highlighting.
- Base: a 20 KiB snapshot parses synchronously and keeps the existing read-only behavior.
- Good: Agent `0.1.4` omits metadata; the transport derives it before the shared Viewer receives the payload.
- Bad: tokenize all Hunks before virtualization, keep a completed Worker alive, or let an old Worker overwrite a newly selected file.
- Bad: truncate an oversized patch and leave revert controls enabled; a truncated patch is not a valid mutation source.

### 6. Tests Required

- Assert inclusive boundaries for 64 KiB, 256 KiB, 5000 lines, 768 KiB, and 20000 lines.
- Assert UTF-8 byte and Rust line-count compatibility for legacy payloads, including legacy payloads above both hard limits.
- Assert generation invalidation, settle-time Worker termination, fallback highlight disablement, Hunk virtualization, dynamic measurement, and cross-Hunk keyboard focus.
- Run shared architecture, navigation, generation-option, accessibility, local Transport, SSH Transport, Desktop Rust, and Agent Rust regressions plus the production frontend build.

### 7. Wrong vs Correct

```ts
// Wrong: parse and tokenize the entire accepted patch during render.
const file = parseDiff(content)[0];
const tokens = tokenize(file.hunks, { highlight: true, refractor, language });

// Correct: parse large content off-thread and tokenize only mounted Hunks under the threshold.
const parsed = useGitDiffParser(content, byteLength);
const syntaxHighlight = !parsed.workerFallback && shouldHighlightGitDiff(metadata);
```

## Theme, Wrapping, And Open Host Preferences

### 1. Scope / Trigger

- Live Git review dialogs and pinned editor Diff use the active terminal theme even when the application and terminal tones differ.
- Snapshot consumers keep their existing application-theme behavior unless they explicitly request terminal theming.

### 2. Signatures

```ts
type GitDiffOpenMode = "dialog" | "editor";

interface GitDiffViewerProps {
  useTerminalTheme?: boolean;
  wrapLines?: boolean;
  onWrapLinesChange?: (wrapLines: boolean) => void;
}

useGitDiffOpenWorkflow(options): {
  openPreferredDiff(filePath: string): boolean;
  openSourcePath(sourcePath: string, status: string, lineNumber?: number): Promise<boolean>;
  pinDiff(target: GitDiffReviewTarget): Promise<boolean>;
  sourcePathForFile(filePath: string): string;
};
```

### 3. Contracts

- `settingsStore.gitDiffOpenMode` defaults to `dialog`; `gitDiffWrapLines` defaults to `true`. Both validate persisted input and belong to the `preferences` sync domain.
- Application Diff tokens are scoped to `data-git-diff-theme="application"`. Terminal roots provide complete surface, text, semantic, interaction, selection, and syntax tokens; global application light selectors must not override them.
- Wrapped mode uses fixed-layout tables and `pre-wrap`. Unwrapped Split mode uses fixed gutter tracks plus equal `minmax(0, 1fr)` code tracks, while code cells use `white-space: pre` and one `GitDiffContent` horizontal scrollbar writes the same `scrollLeft` to both sides.
- The Split center remains fixed during horizontal scrolling. Newly virtualized Hunk cells receive the current offset, and container or line-width changes recalculate the shared scroll range.
- Hunk containers have no decorative border, radius, shadow, or overflow clipping. Changing wrap or view mode remeasures virtual Hunk heights.
- Pinning from the review dialog persists `editor` only after the tab opens successfully. The pinned Pin control toggles the future default back to `dialog` without closing the current tab.
- Source reveal and Pin close the review dialog only after success. Failures keep it open and use the existing localized toast.
- Open-host preference changes only UI routing. Repository identity, Transport leases, mutation capabilities, file support, and snapshot read-only behavior remain unchanged.

### 4. Validation & Error Matrix

| Condition | Behavior |
|---|---|
| Missing or invalid `gitDiffOpenMode` | Migrate to `dialog` |
| Missing or non-boolean `gitDiffWrapLines` | Migrate to `true` |
| Application and terminal tones differ | Resolve all live Diff tokens from the terminal palette |
| `wrapLines=false` with an overlong line | Preserve one line, keep Split columns equal, and expose the content-owned synchronized scrollbar |
| Pin cannot open the target tab | Keep `gitDiffOpenMode` unchanged, keep the dialog open, and show the localized error toast |
| Source reveal returns `false` or throws | Keep the dialog open and show the localized error toast |
| Preferred editor mode cannot resolve the selected change | Return `false` so the caller can retain the dialog fallback |
| Deleted target requests source reveal | Return `false`; source action remains disabled |

### 5. Good / Base / Bad Cases

- Good: the application is light and the terminal is dark; the dialog surface, controls, syntax colors, focus rings, and native control scheme all remain dark-terminal themed.
- Good: after a successful Pin, selecting another changed file reuses the pinned-editor workspace; toggling Pin there restores future dialog routing without closing the active tab.
- Base: existing persisted settings omit both new keys and retain the legacy dialog plus wrapped-line behavior.
- Bad: persist `editor` before tab creation finishes; a failed Pin would silently change future routing.
- Bad: make the Diff table `max-content`; intrinsic line width moves the Split center and gives each side a different effective viewport.
- Bad: give each Hunk or side its own visible scrollbar; virtualized Hunks drift to different horizontal offsets.

### 6. Tests Required

- Assert settings defaults, validation, and sync classification.
- Assert terminal/application selector isolation, toolbar interaction states, fixed nowrap Split tracks, synchronized virtual-cell offsets, Hunk remeasurement, and absence of the old framed container classes.
- Assert pin/open routing and success-gated dialog close behavior.
- Run the architecture limit test and assert each Diff responsibility module remains at most 300 lines with no environment-specific branching in the shared viewer.

### 7. Wrong vs Correct

```ts
// Wrong: change the preference before the asynchronous host operation succeeds.
await updateSetting("gitDiffOpenMode", "editor");
await openPinnedDiff(target);

// Correct: success gates both persistence and dialog closure.
const opened = await openPinnedTarget(target, true);
if (opened) onClose();
```

```css
/* Wrong: the application theme overrides terminal-themed descendants. */
[data-theme="light"] .diff-viewer-container { --diff-bg: #ffffff; }

/* Correct: application tokens apply only to application-themed roots. */
[data-git-diff-theme="application"][data-theme-mode="light"] .diff-viewer-container {
  --diff-bg: #ffffff;
}
```

## Verification

Run:

```bash
npx tsc --noEmit
node --test scripts/gitDiffViewerArchitecture.test.mjs scripts/gitStoreRemote.test.mjs
node --test scripts/gitDiffReviewNavigation.test.mjs scripts/gitDiffSettings.test.mjs
node --test scripts/gitTransportLease.test.mjs scripts/gitDiffWorkspace.test.mjs scripts/gitDiffEditorPin.test.mjs
node --test scripts/gitDiffGenerationOptions.test.mjs
node --test scripts/gitDiffInteractionA11y.test.mjs
node --test scripts/gitDiffLargePerformance.test.mjs
```
