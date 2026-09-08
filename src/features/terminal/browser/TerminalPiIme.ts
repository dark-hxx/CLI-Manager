import type { Terminal } from "@xterm/xterm";
import { TUI_HORIZONTAL_RULE_PATTERN } from "../lib/terminalTui";
import type { TerminalImeAnchor } from "../lib/terminalImeAnchor";

const PI_RULE_EDGE_PATTERN = /^[─━═╌╍┄┅┈┉╴╶]{2,}.*[─━═╌╍┄┅┈┉╴╶]{2,}$/u;

interface PiEditorRegion {
  top: number;
  bottom: number;
}

function clamp(value: number, upperBound: number): number {
  return Math.min(Math.max(0, value), Math.max(0, upperBound));
}

function isPiRule(text: string): boolean {
  const trimmed = text.trim();
  return Boolean(trimmed)
    && (TUI_HORIZONTAL_RULE_PATTERN.test(trimmed) || PI_RULE_EDGE_PATTERN.test(trimmed));
}

function findPiEditorRegions(terminal: Terminal): PiEditorRegion[] {
  const buffer = terminal.buffer.active;
  const ruleRows: number[] = [];

  for (let row = 0; row < terminal.rows; row += 1) {
    const text = buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? "";
    if (isPiRule(text)) ruleRows.push(row);
  }

  const regions: PiEditorRegion[] = [];
  for (let index = 1; index < ruleRows.length; index += 1) {
    const top = ruleRows[index - 1];
    const bottom = ruleRows[index];
    if (bottom > top + 1) regions.push({ top, bottom });
  }
  return regions;
}

function findInverseAnchor(terminal: Terminal, region: PiEditorRegion): TerminalImeAnchor | null {
  const buffer = terminal.buffer.active;
  for (let row = region.bottom - 1; row > region.top; row -= 1) {
    const line = buffer.getLine(buffer.viewportY + row);
    if (!line) continue;
    for (let x = 0; x < Math.min(terminal.cols, line.length); x += 1) {
      if (line.getCell(x)?.isInverse()) return { x, y: row };
    }
  }
  return null;
}

function containsRow(region: PiEditorRegion, row: number): boolean {
  return row > region.top && row < region.bottom;
}

export function resolvePiImeCompositionAnchor(
  terminal: Terminal,
  fallbackAnchor: TerminalImeAnchor,
): TerminalImeAnchor {
  const buffer = terminal.buffer.active;
  const cursor = {
    x: clamp(buffer.cursorX, terminal.cols - 1),
    y: clamp(buffer.cursorY, terminal.rows - 1),
  };
  const regions = findPiEditorRegions(terminal);
  for (let index = regions.length - 1; index >= 0; index -= 1) {
    const region = regions[index];
    const inverseAnchor = findInverseAnchor(terminal, region);
    if (inverseAnchor) return inverseAnchor;
    if (containsRow(region, cursor.y)) return cursor;
  }
  return fallbackAnchor;
}

export function resolvePiImeTextareaAnchor(
  terminal: Terminal,
  anchor: TerminalImeAnchor,
): TerminalImeAnchor {
  const region = findPiEditorRegions(terminal).find((candidate) => containsRow(candidate, anchor.y));
  return region ? { x: anchor.x, y: region.bottom } : anchor;
}
