# Realtime statistics screenshot

Add a compact screenshot icon next to refresh in the live statistics header. One click copies a single full-height image of the current panel (all enabled cards, including below the scroll viewport) to the native desktop clipboard. Preserve current card order, theme, language and width. Show busy/success/failure feedback in zh-CN/en-US.

User approved this new task in the current worktree and TEMP changelog. Preserve earlier diagnostics/resume work. No disk-save dialog or server upload.

Acceptance: full-height capture at top/middle/bottom scroll positions; SVG/canvas charts and icons retained; native image clipboard; no live layout/scroll changes; duplicate clicks blocked; temporary DOM and native image resources cleaned up on failure; works for embedded and standalone panels, local/WSL/SSH sessions and empty panels. Hidden cards and closed detail dialogs remain excluded.
