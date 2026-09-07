# Markdown file link navigation

## Goal

Make Markdown links in the file explorer's source and formatted preview reach the intended document location or external application without navigating the Tauri application page.

## Confirmed background

- User reports Ctrl + right-click does not activate links and a fragment opens `http://tauri.localhost/#-%E4%BA%A4%E6%B5%81%E8%AE%A8%E8%AE%BA`.
- File preview explicitly requests inert links: `src/components/files/FileEditorContent.tsx:112`.
- Fragment links bypass click interception: `src/components/ui/MarkdownContent.tsx:165`; heading permalink anchors also use default navigation at line 222 and subsequent heading renderers.
- Heading IDs strip leading hyphens and number the first duplicate with `-2`: `src/components/ui/MarkdownContent.tsx:204`. This does not match common repository Markdown anchors such as `#-交流讨论`.
- File source mount only saves the editor reference: `src/components/files/FileEditorPane.tsx:126`; no file-editor-specific Markdown link activation is registered.
- Existing project-bound file/directory navigation is available: `src/stores/fileExplorerStore.ts:1235`.

## Requirements and acceptance

| ID | Requirement | Acceptance |
| --- | --- | --- |
| R1 | Preview left-click and keyboard Enter activate links; Ctrl + right-click works in source and preview. Preserve ordinary right-click and source text editing. | Each activation opens exactly once; ordinary source clicks keep editing; ordinary right-click retains its menu. |
| R2 | Same-document fragments remain in the current document and pane. Source reveals the target line; preview scrolls to the target. | URL/location hash remains unchanged; Chinese, encoded fragments, Emoji headings, inline heading formatting, duplicate headings and empty `#` are covered. |
| R3 | HTTP(S) opens the system browser; mailto opens the configured mail handler. | Query parameters and remote fragments survive unchanged; unsupported executable protocols never launch. |
| R4 | File links resolve against the current document directory within the existing project boundary. | `./`, `../`, root-relative project links, spaces, Chinese and percent-encoded reserved characters resolve consistently. Outside-project and unsupported absolute paths yield explicit feedback. |
| R5 | Cross-file fragments open the target and then navigate after loading. | Preserve source/preview intent for Markdown targets; use existing image/text/unsupported-file views and directory reveal behavior; preserve unsaved buffers. |
| R6 | Link recognition covers inline links, reference links, autolinks and linked images. | Source and preview identify the same destination; text in fenced code blocks is not misidentified as Markdown syntax. Bare inline images do not gain unrelated navigation behavior. |
| R7 | Navigation remains bound to project, environment, file and request identity. | Local Windows, WSL, SSH and Worktree links retain their environment; switching project/file/pane during loading cannot scroll or activate an unrelated document; latest navigation wins. |
| R8 | Missing targets and failed opening have visible, localized feedback. | Missing file, missing fragment, remote disconnection, invalid encoding and unsupported scheme are handled in zh-CN and en-US, with zh-TW compatibility following repository conventions. |
| R9 | Shared Markdown consumers retain their external-link policies. | History, prompt library, release notes and subagent/terminal transcripts continue their existing inert/open behavior while internal anchors stay scoped to their own rendered block. |

## Scenario boundaries

- Multiple tabs, split panes, Workspans and focus mode: target the initiating file context; inactive or disposed views must not consume stale navigation.
- Minimized/tray/unfocused app: no document navigation is initiated without an activation event; late results follow R7.
- Sidebar position/collapse: no effect on relative path semantics; directory reveal uses the existing file explorer surface.
- Hook installation and CLI selection: unrelated; file navigation must not depend on hooks.
- Root-relative `/docs/a.md` means current project root. This is a proposed project-bound interpretation for review.
- Empty fragment targets document start; missing nonempty fragment reports failure rather than scrolling to an arbitrary heading.

## Out of scope

New external-project access permissions, downloading remote documents, executing raw HTML, new Markdown image rendering, browser history UI, backend protocol changes and general file explorer refactoring.

## Delivery constraints

Version: V1.3.9 (explicitly requested). Update CHANGELOG.md and docs/功能清单.md with implementation. Preserve pre-existing AGENTS.md and CLAUDE.md edits. User reviewed the plan and explicitly requested implementation.
