import { Terminal, type IBufferLine, type IDisposable, type ITheme } from "@xterm/xterm";
import { isLightTerminalTheme } from "../../../shared/lib/terminalThemes";
import { getTerminalCellWidth } from "./terminalCellWidth";

export type TerminalSubsystemDisposable = IDisposable;

export interface TextDiagnosticSummary {
  length: number;
  hasNonAscii: boolean;
  fingerprint: string;
}

export interface CodexImeDebugState {
  compositionEndAt: number;
  compositionEndSummary: TextDiagnosticSummary | null;
  lastNearCompositionFingerprint: string | null;
  lastNearCompositionAt: number;
}

export const summarizeTextForDiagnostics = (value: string): TextDiagnosticSummary => {
  let hash = 0;
  let hasNonAscii = false;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    hash = Math.imul(31, hash) + code;
    if (code > 0x7f) hasNonAscii = true;
  }
  return {
    length: value.length,
    hasNonAscii,
    fingerprint: (hash >>> 0).toString(36),
  };
};

export const disposeTerminalSubsystem = (disposables: TerminalSubsystemDisposable[]) => {
  for (let index = disposables.length - 1; index >= 0; index -= 1) {
    disposables[index].dispose();
  }
  disposables.length = 0;
};

export const lineHasVisibleTextAfterColumn = (line: IBufferLine, column: number, cols: number) => {
  const width = Math.min(cols, line.length);
  for (let index = Math.max(0, column); index < width; index += 1) {
    if (line.getCell(index)?.getChars().trim()) return true;
  }
  return false;
};

export const canShowSuggestionAtCurrentInputEnd = (terminal: Terminal, input: string) => {
  const inputCellWidth = getTerminalCellWidth(input);
  if (inputCellWidth <= 0) return false;

  const buffer = terminal.buffer.active;
  if (buffer.cursorX < inputCellWidth) return false;

  const line = buffer.getLine(buffer.baseY + buffer.cursorY);
  if (!line) return false;

  if (lineHasVisibleTextAfterColumn(line, buffer.cursorX, terminal.cols)) return false;

  const beforeCursor = line.translateToString(false, 0, Math.min(buffer.cursorX, line.length));
  return beforeCursor.endsWith(input);
};

export const withVisibleSelectionTheme = (theme: ITheme, searchActive = false): ITheme => {
  if (searchActive) {
    return {
      ...theme,
      selectionBackground: "rgba(0, 0, 0, 0)",
      selectionInactiveBackground: "rgba(0, 0, 0, 0)",
    };
  }
  const isLight = isLightTerminalTheme(theme);
  return {
    ...theme,
    selectionBackground: isLight ? "rgba(37, 99, 235, 0.28)" : "rgba(56, 189, 248, 0.52)",
    selectionInactiveBackground: isLight ? "rgba(37, 99, 235, 0.18)" : "rgba(56, 189, 248, 0.34)",
  };
};

export const serializeBufferPlainText = (terminal: Terminal) => {
  const buffer = terminal.buffer.active;
  const lines: string[] = [];
  for (let row = 0; row < buffer.length; row += 1) {
    const line = buffer.getLine(row);
    if (!line) continue;
    const text = line.translateToString(true);
    if (line.isWrapped && lines.length > 0) {
      lines[lines.length - 1] += text;
    } else {
      lines.push(text);
    }
  }
  return lines.join("\n").replace(/[\s\n]+$/u, "");
};
