export interface TerminalViewportRefresher {
  rows: number;
  refresh(start: number, end: number): void;
}

export interface TerminalRenderRange {
  start: number;
  end: number;
}

export function refreshTerminalViewport(
  terminal: TerminalViewportRefresher | null | undefined,
): boolean {
  if (!terminal || terminal.rows <= 0) return false;
  terminal.refresh(0, terminal.rows - 1);
  return true;
}

export function didRenderFullTerminalViewport(
  range: TerminalRenderRange,
  rows: number,
): boolean {
  return rows > 0 && range.start <= 0 && range.end >= rows - 1;
}
