# Design

TerminalStatsPanel owns the capture boundary; a dedicated screenshot button owns busy/toast state. A stats export module snapshots computed styles and canvas pixels into an inert offscreen clone, expands only the panel scroll container, and renders it with lazily imported html-to-image. Clamp output pixel budget proportionally to preserve the complete image. Native clipboard uses existing Tauri Image.new / clipboard-manager.writeImage and closes the image resource in finally. Add only write-image permission, not clipboard reading or filesystem permissions.

Reuse existing header action sizes/colors, Camera/Loader icons and localized tooltips/aria labels. Clone before asynchronous rendering so polling, tab switches and user scrolling cannot mix captured frames. Keep capture separate from statistics collection and independent of Agent/environment.

The export ratio uses 2x as the quality floor for ordinary 100%-150% display scaling and follows device density up to 3x. Existing 16,384-per-dimension and 16-million-total-pixel caps remain authoritative and proportionally reduce only oversized long captures.

Impact: TerminalStatsPanel upstream analysis LOW; graph reports no direct indexed callers. Direct callers are existing terminal panel hosts; no IPC signature or data schema changes. html-to-image README and installed Tauri API declarations verified.
