import type { IBufferCell, Terminal } from "@xterm/xterm";
import type { TerminalBinaryFrame } from "../transport/PtyHostSocket";

const PI_DIAGNOSTIC_MARKER = "PI177-";
const DIAGNOSTIC_TAIL_LIMIT = 64;
const DIAGNOSTIC_PREVIEW_RADIUS = 48;
const DIAGNOSTIC_LINE_PREVIEW_LIMIT = 120;
const ANSI_FOREGROUND_188_PATTERN = /\x1b\[38;5;188m/g;
const ANSI_BACKGROUND_59_PATTERN = /\x1b\[48;5;59m/g;
const SYNC_BEGIN_PATTERN = /\x1b\[\?2026h/g;
const SYNC_END_PATTERN = /\x1b\[\?2026l/g;

type DiagnosticPayload = Record<string, unknown>;
type DiagnosticEmitter = (message: string, payload: DiagnosticPayload) => void;

interface TextSummaryState {
  tail: string;
}

export interface PiTerminalDiagnostics {
  setActive(active: boolean): void;
  onFrame(frame: TerminalBinaryFrame, rawText: string, normalizedText: string): void;
  onWriteCommitted(terminal: Terminal, writtenText: string): void;
  reset(): void;
}

function countMatches(text: string, pattern: RegExp): number {
  pattern.lastIndex = 0;
  let count = 0;
  while (pattern.exec(text) !== null) count += 1;
  return count;
}

const sanitizePreview = (text: string): string => text
  .replace(/\x1b/g, "<ESC>")
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "�")
  .replace(/\r/g, "<CR>")
  .replace(/\n/g, "<LF>");

function markerPreview(text: string): string | null {
  const markerIndex = text.indexOf(PI_DIAGNOSTIC_MARKER);
  if (markerIndex < 0) return null;
  const start = Math.max(0, markerIndex - DIAGNOSTIC_PREVIEW_RADIUS);
  const end = Math.min(text.length, markerIndex + PI_DIAGNOSTIC_MARKER.length + DIAGNOSTIC_PREVIEW_RADIUS);
  return sanitizePreview(text.slice(start, end));
}

function summarizeText(text: string, state: TextSummaryState) {
  const combined = `${state.tail}${text}`;
  const summary = {
    length: text.length,
    markerHits: countMatches(combined, /PI177-/g),
    markerPreview: markerPreview(combined),
    foreground188: countMatches(combined, ANSI_FOREGROUND_188_PATTERN),
    background59: countMatches(combined, ANSI_BACKGROUND_59_PATTERN),
    syncBegin: countMatches(combined, SYNC_BEGIN_PATTERN),
    syncEnd: countMatches(combined, SYNC_END_PATTERN),
  };
  state.tail = combined.slice(-DIAGNOSTIC_TAIL_LIMIT);
  return summary;
}

const cellSummary = (cell: IBufferCell) => ({
  chars: cell.getChars(),
  width: cell.getWidth(),
  fg: cell.getFgColor(),
  fgMode: cell.getFgColorMode(),
  bg: cell.getBgColor(),
  bgMode: cell.getBgColorMode(),
  inverse: cell.isInverse() !== 0,
  dim: cell.isDim() !== 0,
  bold: cell.isBold() !== 0,
});

function summarizeBuffer(terminal: Terminal) {
  const buffer = terminal.buffer.active;
  const probeCell = buffer.getNullCell();
  let markerLine = -1;
  let markerColumn = -1;
  let markerLineText = "";
  for (let row = 0; row < buffer.length; row += 1) {
    const line = buffer.getLine(row);
    if (!line) continue;
    const text = line.translateToString(true);
    const column = text.indexOf(PI_DIAGNOSTIC_MARKER);
    if (column < 0) continue;
    markerLine = row;
    markerColumn = column;
    markerLineText = text;
    break;
  }

  const markerCells: DiagnosticPayload[] = [];
  if (markerLine >= 0) {
    const line = buffer.getLine(markerLine);
    if (line) {
      const end = Math.min(line.length, markerColumn + PI_DIAGNOSTIC_MARKER.length);
      for (let column = markerColumn; column < end; column += 1) {
        const cell = line.getCell(column, probeCell);
        if (cell) markerCells.push(cellSummary(cell));
      }
    }
  }

  let foreground188 = 0;
  let background59 = 0;
  let visibleBackground59 = 0;
  for (let viewportRow = 0; viewportRow < terminal.rows; viewportRow += 1) {
    const line = buffer.getLine(buffer.viewportY + viewportRow);
    if (!line) continue;
    const limit = Math.min(terminal.cols, line.length);
    for (let column = 0; column < limit; column += 1) {
      const cell = line.getCell(column, probeCell);
      if (!cell) continue;
      if (cell.getFgColor() === 188) foreground188 += 1;
      if (cell.getBgColor() !== 59) continue;
      background59 += 1;
      if (cell.getChars().trim() !== "") visibleBackground59 += 1;
    }
  }

  const previewStart = Math.max(0, markerColumn - DIAGNOSTIC_PREVIEW_RADIUS);
  return {
    markerFound: markerLine >= 0,
    markerLine,
    markerColumn,
    markerPreview: markerLine >= 0
      ? sanitizePreview(markerLineText.slice(previewStart, previewStart + DIAGNOSTIC_LINE_PREVIEW_LIMIT))
      : null,
    markerCells,
    viewportY: buffer.viewportY,
    baseY: buffer.baseY,
    cursorX: buffer.cursorX,
    cursorY: buffer.cursorY,
    foreground188,
    background59,
    visibleBackground59,
  };
}

export function createPiTerminalDiagnostics(
  sessionId: string,
  emit: DiagnosticEmitter,
  enabled: boolean,
): PiTerminalDiagnostics {
  let active = false;
  const rawState: TextSummaryState = { tail: "" };
  const normalizedState: TextSummaryState = { tail: "" };
  const writtenState: TextSummaryState = { tail: "" };

  return {
    setActive(nextActive) {
      active = active || (enabled && nextActive);
    },
    onFrame(frame, rawText, normalizedText) {
      if (!active) return;
      emit("[pi177] terminal frame", {
        sessionId,
        kind: frame.kind,
        sequence: frame.sequence,
        cols: frame.cols,
        rows: frame.rows,
        raw: summarizeText(rawText, rawState),
        normalized: summarizeText(normalizedText, normalizedState),
      });
    },
    onWriteCommitted(terminal, writtenText) {
      if (!active) return;
      emit("[pi177] xterm write committed", {
        sessionId,
        written: summarizeText(writtenText, writtenState),
        buffer: summarizeBuffer(terminal),
      });
    },
    reset() {
      rawState.tail = "";
      normalizedState.tail = "";
      writtenState.tail = "";
    },
  };
}
