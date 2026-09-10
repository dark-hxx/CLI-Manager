type DesktopViewport = { visible: () => boolean; restore: () => void };

// Register before asynchronous PTY subscription; hidden parsers do not own size.
const viewports = new Map<string, Map<symbol, DesktopViewport>>();

export function registerDesktopViewport(sessionId: string, viewport: DesktopViewport): () => void {
  const entries = viewports.get(sessionId) ?? new Map<symbol, DesktopViewport>();
  const token = Symbol(sessionId);
  entries.set(token, viewport);
  viewports.set(sessionId, entries);
  return () => {
    entries.delete(token);
    if (!entries.size && viewports.get(sessionId) === entries) viewports.delete(sessionId);
  };
}

export function hasVisibleDesktopViewport(sessionId: string): boolean {
  return [...(viewports.get(sessionId)?.values() ?? [])].some((viewport) => viewport.visible());
}

export function restoreDesktopViewportSize(sessionId: string): void {
  const viewport = [...(viewports.get(sessionId)?.values() ?? [])].find((entry) => entry.visible());
  viewport?.restore();
}
