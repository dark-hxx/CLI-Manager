# Markdown File Navigation Contracts

## Scope

These contracts apply to Markdown rendered inside `MarkdownContent` and to Markdown source opened by the project file editor. They do not grant access outside the active project or change terminal/history link policy.

## Signatures and ownership

```ts
resolveMarkdownHref(href: string, currentPath: string): MarkdownNavigationTarget
findMarkdownHeadingLine(content: string, fragment: string): number | null
findMarkdownLinkAtPosition(content: string, lineNumber: number, columnNumber: number): string | null

interface MarkdownContentProps {
  onLinkActivate?: (href: string) => void;
}
```

- `MarkdownContent` owns scoped same-document preview scrolling. It reads `anchor.getAttribute("href")`; resolved DOM `anchor.href` is forbidden because it prepends the Tauri origin.
- `FileEditorPane` owns destination classification, system opener calls, project file navigation, source line reveal, request identity and localized failures.
- `fileExplorerStore.revealPath` remains the authority for local/WSL/SSH/Worktree traversal and open-file reuse. Markdown navigation must not introduce direct filesystem calls or reinterpret remote paths as local paths.
- `FileEditorContent` only delivers preview activation and applies a matching pending preview fragment after the target file renders.

## Activation contract

| Surface | Gesture | Result |
| --- | --- | --- |
| Markdown preview | Left click / keyboard activation | Activate link once |
| Markdown preview | Ctrl + right click | Activate link once and suppress the link context menu |
| Markdown source | Ctrl + right click over parsed link syntax | Activate link once and suppress Monaco's context menu |
| Markdown source | Ordinary click or right click | Preserve editing and Monaco context menu |

Heading anchors query only the current `.ui-markdown` root. Duplicate heading IDs in another pane must never receive the scroll.

## Destination and validation matrix

| Input | Result |
| --- | --- |
| `#fragment` | Current rendered document or current source heading; empty fragment means document start |
| `./a.md`, `../a.md`, `/docs/a.md` | Normalize against current document or current project root, then call `revealPath` |
| `a.md#fragment` | Open file, preserve source/preview mode, then apply the fragment only to the matching request/file |
| `http:`, `https:`, `mailto:` | Open through the system opener with query and fragment unchanged |
| traversal above root, drive/UNC outside project | Localized outside-project error |
| unsupported scheme, malformed percent encoding/query | Localized invalid/unsupported error; never execute |
| missing file/directory/heading | Localized missing-target error |

Split the raw fragment before decoding the path so `%23` can remain part of a filename. Decode each part once. A late file-open completion applies only when its monotonically increasing request identity and target file still match; manual navigation invalidates it.

## Heading and source parsing

- Renderer IDs and source lookup share `createMarkdownHeadingId`.
- Remove punctuation and symbols except `_` and `-`, lowercase text, convert whitespace to hyphens, and suffix duplicates from `-1`. Removing a leading Emoji may intentionally leave the following whitespace as a leading hyphen (for example `💬 交流讨论` becomes `-交流讨论`).
- Source activation covers inline, full/collapsed/shortcut reference, linked-image, angle-bracket and GFM bare HTTP(S) links.
- Ignore inline code and fenced code, including unclosed fences and closing fences longer than their opener.

## Good, base and bad cases

- Good: `guide.md#安装` from an SSH Markdown preview opens that SSH project file, renders preview, then scrolls to `安装`.
- Base: `#-交流讨论` scrolls within the initiating preview without changing `window.location`.
- Bad: reading `HTMLAnchorElement.href` yields `http://tauri.localhost/#...` and hands an internal fragment to the system browser.
- Bad: resolving a WSL/SSH relative link with Windows path APIs crosses the environment boundary.

## Tests required

- Unit-test destination classification, encoding, traversal rejection, heading IDs/duplicates and source link range detection.
- Assert the renderer uses raw `getAttribute("href")`, root-scoped ID lookup and Ctrl-context activation.
- Assert the file editor registers scoped Monaco mouse handling and delegates file paths to `revealPath`.
- Run shared Markdown, history, terminal preview and file workspace regressions plus `npx tsc --noEmit` and `npm run build`.
- Human desktop verification is required for actual Monaco context-menu suppression, system browser launching, cross-file scrolling, multi-pane scoping and language switching.
