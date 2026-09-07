import type { IBufferCell, IBufferLine, Terminal } from "@xterm/xterm";
import { isXtermCellDarkBlockBackground } from "./terminalColor";
import {
  TUI_BORDER_PREFIX_PATTERN,
  TUI_COMPOSER_PROMPT_PATTERN,
} from "./terminalTui";

const XTERM_BG_COLOR_MASK = 0x03ffffff;
const XTERM_COLOR_MODE_RGB = 0x03000000;
const XTERM_INVERSE_FLAG = 0x04000000;
const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
const CLAUDE_LIGHT_SLASH_MENU_SELECTED_BG = 0xe7eefc;
const TUI_COMPOSER_PRELUDE_ROWS = 1;
const TUI_COMPOSER_CONTINUATION_ROWS = 4;
const SLASH_COMMAND_MENU_LINE_PATTERN = /^\/[a-z0-9][a-z0-9:_-]*(?:\s|$)/i;
// A single dark cell can be a TUI block cursor; a painted block always spans several.
const DARK_BLOCK_MIN_CELLS = 4;
const CODEX_TUI_VIEWPORT_PATTERN = /(?:openai\s+codex|\/model\s+to\s+change)/i;
const GROK_TUI_VIEWPORT_PATTERN = /grok\s+build/i;
const OTHER_AI_TUI_VIEWPORT_PATTERN = /(?:claude\s+code|yolo\s+mode)/i;

type MutableXtermCell = IBufferCell & {
  fg: number;
  bg: number;
};

interface MutableXtermLine {
  length: number;
  loadCell(index: number, cell: MutableXtermCell): MutableXtermCell;
  setCell(index: number, cell: MutableXtermCell): void;
}

type XtermBufferLineApiView = IBufferLine & {
  _line?: MutableXtermLine;
};

export interface TerminalTuiDisplayOptions {
  shouldNormalize: boolean;
  isTransparent: boolean;
  isLightTheme: boolean;
  isTuiSession: boolean;
  isCodexSession: boolean;
  isClaudeSession: boolean;
  /**
   * Erase dark backgrounds a dark-theme CLI paints on a light terminal, wherever they
   * land in the visible viewport. Independent of the TUI viewport-signature latch.
   */
  shouldEraseDarkBlocks?: boolean;
  terminalTextColor?: string;
  tuiUserColor?: string;
  tuiAssistantColor?: string;
}

function parseXtermRgbColor(value: string | undefined): number | null {
  if (!value || !HEX_COLOR_PATTERN.test(value)) return null;
  const rgb = Number.parseInt(value.slice(1), 16);
  return XTERM_COLOR_MODE_RGB | rgb;
}

export function hasCodexTuiViewport(terminal: Terminal): boolean {
  const buffer = terminal.buffer.active;
  for (let row = 0; row < terminal.rows; row += 1) {
    const line = buffer.getLine(buffer.viewportY + row);
    if (line && CODEX_TUI_VIEWPORT_PATTERN.test(line.translateToString(true))) return true;
  }
  return false;
}

export function hasGrokTuiViewport(terminal: Terminal): boolean {
  const buffer = terminal.buffer.active;
  for (let row = 0; row < terminal.rows; row += 1) {
    const line = buffer.getLine(buffer.viewportY + row);
    if (line && GROK_TUI_VIEWPORT_PATTERN.test(line.translateToString(true))) return true;
  }
  return false;
}

export function hasKnownAiTuiViewport(terminal: Terminal): boolean {
  const buffer = terminal.buffer.active;
  for (let row = 0; row < terminal.rows; row += 1) {
    const line = buffer.getLine(buffer.viewportY + row);
    if (!line) continue;
    const text = line.translateToString(true);
    if (CODEX_TUI_VIEWPORT_PATTERN.test(text) || OTHER_AI_TUI_VIEWPORT_PATTERN.test(text)) return true;
  }
  return false;
}

export function hasTuiComposerPromptViewport(terminal: Terminal): boolean {
  const buffer = terminal.buffer.active;
  for (let row = 0; row < terminal.rows; row += 1) {
    const line = buffer.getLine(buffer.viewportY + row);
    if (!line) continue;
    const text = line.translateToString(true).trimStart().replace(TUI_BORDER_PREFIX_PATTERN, "");
    if (/^[\u203a\u276f\u00bb\u2023]\s?/u.test(text)) return true;
  }
  return false;
}

export function normalizeTerminalTuiComposerBackground(
  terminal: Terminal,
  {
    shouldNormalize,
    isTransparent,
    isLightTheme,
    isTuiSession,
    isCodexSession,
    isClaudeSession,
    shouldEraseDarkBlocks = false,
    terminalTextColor,
    tuiUserColor,
    tuiAssistantColor,
  }: TerminalTuiDisplayOptions,
) {
  const buffer = terminal.buffer.active;
  const probeCell = buffer.getNullCell() as MutableXtermCell;
  const minRow = 0;
  const configuredTuiUserColor = parseXtermRgbColor(tuiUserColor);
  const configuredTuiAssistantColor = parseXtermRgbColor(tuiAssistantColor);
  const normalTerminalColor = !isTuiSession ? parseXtermRgbColor(terminalTextColor) : null;
  const hasConfiguredTuiColors = configuredTuiUserColor !== null || configuredTuiAssistantColor !== null;
  const useBroadViewportNormalization = isTransparent || (isCodexSession && isLightTheme);
  const useClaudeLightPatchNormalization = !useBroadViewportNormalization && isClaudeSession && isLightTheme;
  const useDarkBlockErase = !useBroadViewportNormalization && shouldEraseDarkBlocks;
  const paletteTheme = useDarkBlockErase ? terminal.options.theme : undefined;
  const getViewportLine = (row: number) => buffer.getLine(buffer.viewportY + row);
  const getBufferLine = (row: number) => buffer.getLine(row);
  const normalizePromptText = (line: IBufferLine) => (
    line.translateToString(true).trimStart().replace(TUI_BORDER_PREFIX_PATTERN, "")
  );
  const isTuiPromptLine = (line: IBufferLine) => TUI_COMPOSER_PROMPT_PATTERN.test(normalizePromptText(line));
  const hasKnownAiTuiSignature = () => {
    return hasKnownAiTuiViewport(terminal);
  };
  const getLineBackgroundState = (line: IBufferLine) => {
    const limit = Math.min(terminal.cols, line.length);
    let hasExplicitBackground = false;
    let inverseCells = 0;
    let hasInverse = false;
    let darkBlockCells = 0;
    for (let x = 0; x < limit; x += 1) {
      const cell = line.getCell(x, probeCell);
      if (!cell) continue;
      if (cell.getBgColorMode() !== 0) hasExplicitBackground = true;
      if (useDarkBlockErase && isXtermCellDarkBlockBackground(probeCell.bg, paletteTheme)) {
        darkBlockCells += 1;
      }
      if (cell.isInverse() !== 0) {
        hasInverse = true;
        inverseCells += 1;
      }
    }
    return {
      hasExplicitBackground,
      hasInverse,
      darkBlockCells,
      hasWideInverse: inverseCells >= Math.max(4, Math.floor(terminal.cols * 0.25)),
    };
  };
  const isPatchLikeLine = (line: IBufferLine) => {
    const text = line.translateToString(true).trim();
    return /^(?:\d+\s+)?(?:[+-](?![+-]{2,})|@@|diff --git |index |--- |\+\+\+ |\*\*\* (?:Begin|End) Patch|\*\*\* (?:Update|Add|Delete) File:|\x60{3}(?:diff|patch)?\s*$)/.test(text);
  };
  const clearLineBackground = (line: IBufferLine, clearInverse: boolean, clearForeground = false) => {
    const mutableLine = (line as XtermBufferLineApiView)._line;
    if (!mutableLine) return false;
    const limit = Math.min(terminal.cols, mutableLine.length);
    let changed = false;
    for (let x = 0; x < limit; x += 1) {
      mutableLine.loadCell(x, probeCell);
      const nextBg = probeCell.bg & ~XTERM_BG_COLOR_MASK;
      const fgWithoutColor = clearForeground ? probeCell.fg & ~XTERM_BG_COLOR_MASK : probeCell.fg;
      const nextFg = clearInverse ? fgWithoutColor & ~XTERM_INVERSE_FLAG : fgWithoutColor;
      if (nextBg === probeCell.bg && nextFg === probeCell.fg) continue;
      probeCell.bg = nextBg;
      probeCell.fg = nextFg;
      mutableLine.setCell(x, probeCell);
      changed = true;
    }
    return changed;
  };

  // Clears only the cells a dark-theme CLI painted dark, so light highlights, colored
  // badges, and an isolated inverse software cursor survive on a light terminal.
  const clearDarkBlockCells = (line: IBufferLine, clearInverse: boolean) => {
    const mutableLine = (line as XtermBufferLineApiView)._line;
    if (!mutableLine) return false;
    const limit = Math.min(terminal.cols, mutableLine.length);
    let changed = false;
    for (let x = 0; x < limit; x += 1) {
      mutableLine.loadCell(x, probeCell);
      const nextBg = isXtermCellDarkBlockBackground(probeCell.bg, paletteTheme)
        ? probeCell.bg & ~XTERM_BG_COLOR_MASK
        : probeCell.bg;
      const nextFg = clearInverse ? probeCell.fg & ~XTERM_INVERSE_FLAG : probeCell.fg;
      if (nextBg === probeCell.bg && nextFg === probeCell.fg) continue;
      probeCell.bg = nextBg;
      probeCell.fg = nextFg;
      mutableLine.setCell(x, probeCell);
      changed = true;
    }
    return changed;
  };

  const setLineForeground = (line: IBufferLine, color: number) => {
    const mutableLine = (line as XtermBufferLineApiView)._line;
    if (!mutableLine) return false;
    const limit = Math.min(terminal.cols, mutableLine.length);
    let changed = false;
    for (let x = 0; x < limit; x += 1) {
      mutableLine.loadCell(x, probeCell);
      if (probeCell.getWidth() === 0) continue;
      const nextFg = (probeCell.fg & ~XTERM_BG_COLOR_MASK) | color;
      if (nextFg === probeCell.fg) continue;
      probeCell.fg = nextFg;
      mutableLine.setCell(x, probeCell);
      changed = true;
    }
    return changed;
  };

  let firstChangedRow = terminal.rows;
  let lastChangedRow = -1;
  const markChangedRow = (row: number) => {
    firstChangedRow = Math.min(firstChangedRow, row);
    lastChangedRow = Math.max(lastChangedRow, row);
  };
  const isSlashCommandPromptLine = (line: IBufferLine) => {
    const text = normalizePromptText(line);
    return TUI_COMPOSER_PROMPT_PATTERN.test(text) && /^[\u203a\u276f\u00bb\u2023>]\s*\/\S*$/u.test(text);
  };
  const getSlashCommandMenuLineState = (line: IBufferLine) => {
    const text = line.translateToString(true);
    const trimmed = text.trimStart();
    const commandMatch = SLASH_COMMAND_MENU_LINE_PATTERN.exec(trimmed);
    if (!commandMatch) return null;

    const leadingSpaces = text.length - trimmed.length;
    const commandEnd = leadingSpaces + commandMatch[0].trimEnd().length;
    const limit = Math.min(terminal.cols, line.length, text.length);
    let visibleDescriptionCells = 0;
    let highlightedDescriptionCells = 0;
    for (let x = commandEnd; x < limit; x += 1) {
      const cell = line.getCell(x, probeCell);
      if (!cell || cell.getWidth() === 0 || cell.getChars().trim() === "") continue;
      visibleDescriptionCells += 1;
      if ((cell.getFgColorMode() !== 0 || cell.isBold() !== 0) && cell.isDim() === 0) {
        highlightedDescriptionCells += 1;
      }
    }
    return {
      selectedByForeground: highlightedDescriptionCells >= Math.max(
        6,
        Math.floor(visibleDescriptionCells * 0.35),
      ),
    };
  };
  const syncOwnedSlashMenuBackground = (line: IBufferLine, selected: boolean) => {
    const mutableLine = (line as XtermBufferLineApiView)._line;
    if (!mutableLine) return false;
    const limit = Math.min(terminal.cols, mutableLine.length);
    let changed = false;
    for (let x = 0; x < limit; x += 1) {
      mutableLine.loadCell(x, probeCell);
      const hasOwnedBackground = probeCell.isBgRGB()
        && probeCell.getBgColor() === CLAUDE_LIGHT_SLASH_MENU_SELECTED_BG;
      const nextBg = selected
        ? (probeCell.bg & ~XTERM_BG_COLOR_MASK) | XTERM_COLOR_MODE_RGB | CLAUDE_LIGHT_SLASH_MENU_SELECTED_BG
        : hasOwnedBackground
          ? probeCell.bg & ~XTERM_BG_COLOR_MASK
          : probeCell.bg;
      if (nextBg === probeCell.bg) continue;
      probeCell.bg = nextBg;
      mutableLine.setCell(x, probeCell);
      changed = true;
    }
    return changed;
  };
  const syncClaudeLightSlashMenuHighlights = () => {
    let promptRow = -1;
    const commandRows: Array<{ row: number; line: IBufferLine; selectedByForeground: boolean }> = [];
    for (let row = minRow; row < terminal.rows; row += 1) {
      const line = getViewportLine(row);
      if (line && isSlashCommandPromptLine(line)) promptRow = row;
    }
    if (promptRow >= 0) {
      for (let row = promptRow + 1; row < terminal.rows; row += 1) {
        const line = getViewportLine(row);
        if (!line) continue;
        const state = getSlashCommandMenuLineState(line);
        if (!state) continue;
        commandRows.push({ row, line, selectedByForeground: state.selectedByForeground });
      }
    }
    const foregroundSelectedRow = commandRows.find((item) => item.selectedByForeground)?.row;
    const selectedRow = foregroundSelectedRow ?? commandRows[0]?.row ?? -1;
    for (let row = minRow; row < terminal.rows; row += 1) {
      const line = getViewportLine(row);
      if (!line) continue;
      if (!syncOwnedSlashMenuBackground(line, row === selectedRow)) continue;
      markChangedRow(row);
    }
  };

  const eraseDarkBlockBackgrounds = () => {
    for (let row = minRow; row < terminal.rows; row += 1) {
      const line = getViewportLine(row);
      if (!line) continue;
      const backgroundState = getLineBackgroundState(line);
      const hasDarkBlock = backgroundState.darkBlockCells >= DARK_BLOCK_MIN_CELLS;
      if (!hasDarkBlock && !backgroundState.hasWideInverse) continue;
      if (!clearDarkBlockCells(line, backgroundState.hasWideInverse)) continue;
      markChangedRow(row);
    }
  };

  const needsTuiDetection = shouldNormalize || hasConfiguredTuiColors;
  const detectedTuiSession = isTuiSession || (needsTuiDetection && hasKnownAiTuiSignature());
  const userColor = detectedTuiSession ? configuredTuiUserColor : null;
  const assistantColor = detectedTuiSession ? configuredTuiAssistantColor : null;
  if (!shouldNormalize && userColor === null && assistantColor === null && normalTerminalColor === null) return;
  const userRows = new Set<number>();
  if (detectedTuiSession && (userColor !== null || assistantColor !== null)) {
    for (let row = minRow; row < terminal.rows; row += 1) {
      const absoluteRow = buffer.viewportY + row;
      let promptRow = absoluteRow;
      while (promptRow >= minRow) {
        const line = getBufferLine(promptRow);
        if (!line) break;
        if (isTuiPromptLine(line)) {
          for (let userRow = promptRow; userRow <= absoluteRow; userRow += 1) userRows.add(userRow);
          break;
        }
        if (!line.isWrapped) break;
        promptRow -= 1;
      }
    }
  }

  if (detectedTuiSession && userColor !== null) {
    for (let row = minRow; row < terminal.rows; row += 1) {
      const absoluteRow = buffer.viewportY + row;
      if (!userRows.has(absoluteRow)) continue;
      const line = getViewportLine(row);
      if (line && setLineForeground(line, userColor)) markChangedRow(row);
    }
  }

  if (detectedTuiSession && assistantColor !== null) {
    for (let row = minRow; row < terminal.rows; row += 1) {
      if (userRows.has(buffer.viewportY + row)) continue;
      const line = getViewportLine(row);
      if (line && setLineForeground(line, assistantColor)) markChangedRow(row);
    }
  }

  if (!detectedTuiSession && normalTerminalColor !== null) {
    const cursorRow = buffer.baseY + buffer.cursorY;
    for (let row = cursorRow; row >= minRow; row -= 1) {
      const line = getBufferLine(row);
      if (!line) break;
      if (row !== cursorRow && !line.isWrapped) break;
      const viewportRow = row - buffer.viewportY;
      if (viewportRow >= minRow && viewportRow < terminal.rows && setLineForeground(line, normalTerminalColor)) {
        markChangedRow(viewportRow);
      }
    }
  }

  if (!shouldNormalize) {
    if (lastChangedRow >= firstChangedRow) terminal.refresh(firstChangedRow, lastChangedRow);
    return;
  }

  if (useBroadViewportNormalization && detectedTuiSession) {
    for (let row = minRow; row < terminal.rows; row += 1) {
      const line = getViewportLine(row);
      if (!line) continue;
      const backgroundState = getLineBackgroundState(line);
      if (!backgroundState.hasExplicitBackground && !backgroundState.hasInverse) continue;
      if (!clearLineBackground(line, backgroundState.hasWideInverse)) continue;
      markChangedRow(row);
    }
    if (lastChangedRow >= firstChangedRow) {
      terminal.refresh(firstChangedRow, lastChangedRow);
    }
    return;
  }

  if (useClaudeLightPatchNormalization) {
    for (let row = minRow; row < terminal.rows; row += 1) {
      const line = getViewportLine(row);
      if (!line || !isPatchLikeLine(line)) continue;
      const backgroundState = getLineBackgroundState(line);
      if (!backgroundState.hasExplicitBackground && !backgroundState.hasInverse) continue;
      if (!clearLineBackground(line, backgroundState.hasInverse, assistantColor === null)) continue;
      markChangedRow(row);
    }
    syncClaudeLightSlashMenuHighlights();
    if (useDarkBlockErase) eraseDarkBlockBackgrounds();
    if (lastChangedRow >= firstChangedRow) {
      terminal.refresh(firstChangedRow, lastChangedRow);
    }
    return;
  }

  if (useDarkBlockErase) {
    eraseDarkBlockBackgrounds();
    if (lastChangedRow >= firstChangedRow) {
      terminal.refresh(firstChangedRow, lastChangedRow);
    }
    return;
  }

  for (let promptRow = terminal.rows - 1; promptRow >= minRow; promptRow -= 1) {
    const promptLine = getViewportLine(promptRow);
    if (!promptLine || !isTuiPromptLine(promptLine)) continue;
    const startRow = Math.max(minRow, promptRow - TUI_COMPOSER_PRELUDE_ROWS);
    const maxRow = Math.min(terminal.rows - 1, promptRow + TUI_COMPOSER_CONTINUATION_ROWS);
    for (let row = startRow; row <= maxRow; row += 1) {
      const line = getViewportLine(row);
      if (!line) break;
      const backgroundState = getLineBackgroundState(line);
      if (row < promptRow) {
        if (!backgroundState.hasExplicitBackground && !backgroundState.hasWideInverse) continue;
        if (!clearLineBackground(line, backgroundState.hasWideInverse)) continue;
        markChangedRow(row);
        continue;
      }
      if (
        row > promptRow
        && !line.isWrapped
        && !backgroundState.hasExplicitBackground
        && !backgroundState.hasWideInverse
      ) {
        break;
      }
      if (!backgroundState.hasExplicitBackground && !backgroundState.hasWideInverse) continue;
      if (!clearLineBackground(line, backgroundState.hasWideInverse)) continue;
      markChangedRow(row);
    }
  }

  if (lastChangedRow >= firstChangedRow) {
    terminal.refresh(firstChangedRow, lastChangedRow);
  }
}
