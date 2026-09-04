# Quality Guidelines

> Code quality standards for frontend development.

---

## Overview

<!--
Document your project's quality standards here.

Questions to answer:
- What patterns are forbidden?
- What linting rules do you enforce?
- What are your testing requirements?
- What code review standards apply?
-->

(To be filled by the team)

---

## Forbidden Patterns

### Don't allocate per item in hot UI scans

**Problem**:
```typescript
for (const message of messages) {
  if (message.content.toLowerCase().includes(query)) {
    // match
  }
}
```

**Why it's bad**: large terminal/history content can make per-message full-string copies dominate CPU and memory.

**Instead**:
```typescript
const matcher = new RegExp(escapeRegExp(query), "i");
for (const message of messages) {
  if (matcher.test(message.content)) {
    // match
  }
}
```

---

## Required Patterns

### Gate diagnostic console output behind Debug Mode

**What**: WebView-side diagnostic `console.log`, `console.info`, and `console.warn` output must go through `src/lib/debugConsole.ts`, not direct `console.*` calls.

**Why**: normal users should not get noisy console diagnostics; Debug Mode is the explicit switch for frontend console diagnostics. Keep real error reporting paths such as `console.error` separate unless the task explicitly changes error reporting.

**Correct**:
```typescript
debugConsoleWarn("[oom-diagnostics:webview]", payload);
```

**Wrong**:
```typescript
console.warn("[oom-diagnostics:webview]", payload);
```

### Bound buffers for hidden terminal output

**What**: when terminal output is buffered while a tab is hidden, keep a fixed-size latest suffix instead of an unbounded list.

**Why**: inactive terminal sessions can receive large output bursts while hidden; unbounded buffering makes memory grow with output volume.

**Example**:
```typescript
if (text.length >= maxBufferBytes) {
  buffer = [text.slice(-maxBufferBytes)];
} else {
  buffer.push(text);
  trimOldestUntilWithinLimit();
}
```

### Keep transient search state inside heavy popovers

**What**: If a toolbar, sidebar, or panel renders a large tree/list, search input state for a small popover inside it must live in the popover component, not in the parent panel. Cap large popover result sections and ask the user to narrow the search.

**Why**: Updating parent-level search state rerenders the entire panel on every keystroke. In Git changes, that can repaint the full changed-file tree while the user is only filtering branches.

**Correct**:
```tsx
function BranchMenu({ branches }: { branches: Branch[] }) {
  const [query, setQuery] = useState("");
  const matcher = useMemo(() => makeMatcher(query), [query]);
  const visible = useMemo(
    () => branches.filter((branch) => matcher.test(branch.name)).slice(0, 80),
    [branches, matcher],
  );

  return <input value={query} onChange={(event) => setQuery(event.target.value)} />;
}
```

**Wrong**:
```tsx
function GitChangesPanel() {
  const [branchQuery, setBranchQuery] = useState("");

  return (
    <>
      <LargeChangedFileTree />
      <BranchMenu query={branchQuery} onQueryChange={setBranchQuery} />
    </>
  );
}
```

### Reserve complete line boxes in fixed-size canvas cards

**What**: Fixed-size canvas or diagram nodes that use a vertical flex layout must reserve enough height for every visible line, gap, and padding at the supported font metrics. Do not rely on flex shrinking to make text fit.

**Why**: `overflow: hidden` combined with a fixed node height lets flex items shrink below their line box. Titles then appear vertically sliced even though horizontal truncation is correct. Layout constants and rendered typography must be reviewed together whenever node content or scaling changes.

**Required check**: Verify the header, title, maximum summary line count, metadata row, gaps, and vertical padding fit without flex shrink at every supported canvas zoom level.

### Preserve the workspace background at shell boundaries

When `WorkspaceBackground` is active (`data-workspace-background="true"`), normal workspace-level shells must use `background: transparent !important` so the single shared image remains visible through utility classes, Mantine defaults, and component surface rules. Settings and History are intentional opaque-page exceptions; Statistics remains an image-capable page. Do not use a high-opacity `color-mix` as a shell fallback for a page intended to expose the image: in the light theme it is visually opaque and hides the background.

Keep readability surfaces on cards, fields, menus, dialogs, and other interactive content. Any settings/statistics page must carry the active marker through `useWorkspaceBackground`; image or opaque selectors must be scoped to that marker so `fillWorkspace=false` retains terminal-only behavior. Add a static regression assertion for each new shell boundary.

### Convention: File and Git path copy menus share one formatter

**What**: File explorer and Git change tree context menus must expose absolute-path copy as the primary action and put AI-path and project-relative formats under the shared `PathCopyMenu` component. Absolute paths use the active local project root or SSH `remote_path`; nested Git repositories use the active repository root.

**Why**: The same relative file path can be displayed by the file tree, search results, or Git tree. Duplicating path joining in each menu causes local/SSH and nested-repository paths to diverge.

**Correct**:

```tsx
<PathCopyMenu project={project} relativePath={entry.path} kind={entry.kind} />
```

**Wrong**:

```tsx
<ContextMenuItem onSelect={() => navigator.clipboard.writeText(project.path + entry.path)}>
  Copy path
</ContextMenuItem>
```

**Contracts**:

- Relative paths use `/` internally and the root is represented as `.`.
- AI paths continue through `formatAiPathBlock`; directory trailing-slash behavior remains unchanged.
- Absolute path copy uses `project.path` for local/WSL projects and `project.remote_path` for SSH projects.

### Convention: Path format choices replace the parent menu in place

**What**: Selecting `Copy path as` must switch the existing context-menu content to a two-item format menu. Do not use a Radix `ContextMenuSub` for this interaction, because the default submenu keeps the parent menu visible beside the child.

**Why**: The file-panel requirement is a single replacement menu, not a persistent parent/child menu pair. A Portal can solve clipping but cannot change that interaction model.

**Correct**:

```tsx
<ContextMenuItem
  onSelect={(event) => {
    event.preventDefault();
    setShowFormats(true);
  }}
>
  <Copy /> <span>Copy path as</span> <ChevronRight />
</ContextMenuItem>
```

The replacement keeps `context-menu file-explorer-menu`, removes the old sibling items from layout, and focuses its first item after the branch swap. AI and relative choices use distinct existing semantic icons.

**Wrong**:

```tsx
<ContextMenuSub>
  <ContextMenuSubTrigger>复制路径为</ContextMenuSubTrigger>
  <ContextMenuSubContent>...</ContextMenuSubContent>
</ContextMenuSub>
```
- Clipboard success and failure messages must use i18n keys in both supported UI languages.
- Radix submenus must render through `ContextMenuPrimitive.Portal`; custom sidebar menu containers may have `overflow-x-hidden` and must not clip nested menus.

---

## Testing Requirements

### Manual runtime UI verification

AI agents must not start CLI-Manager services or the Tauri desktop app to verify runtime UI behavior. For frontend or terminal visual changes, run static/build checks where relevant, then list the exact manual verification items for a human to check.

**Why**: this project cannot be reliably verified by AI at runtime; manual desktop/UI inspection is the source of truth.

**Required manual checks for terminal UI changes**:
- Normal terminal layout has no unintended one-sided padding or outer gaps.
- Fullscreen terminal layout still fills the available window.
- Terminal background image mode still shows transparency, blur, darken, fit, and position correctly.

---

## Code Review Checklist

<!-- What reviewers should check -->

(To be filled by the team)
