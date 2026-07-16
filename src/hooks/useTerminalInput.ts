import {
  useRef,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import type { IBufferLine, Terminal } from "@xterm/xterm";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { toast } from "sonner";
import { TERMINAL_FILE_PATH_MIME } from "../lib/aiPathFormatter";
import {
  arrayBufferToBase64,
  createClipboardImageFileName,
  getClipboardImageFile,
  hasDataTransferType,
} from "../lib/terminalClipboardImage";
import {
  endTerminalFileDrag,
  getTerminalFileDropZoneIdAtPoint,
  getTerminalFileDragText,
  registerTerminalDropZone,
  updateTerminalFileDragPointFromEvent,
} from "../lib/terminalFileDrag";
import {
  TERMINAL_INPUT_SUGGESTION_AI_MODEL,
  TERMINAL_INPUT_SUGGESTION_BUILTIN_PROMPT,
  getLocalTerminalInputSuggestions,
  getTerminalInputSuggestionAiResult,
  getTerminalPathInputSuggestions,
  mergeTerminalInputSuggestions,
  resolveSubmittedDirectoryChange,
  type TerminalInputSuggestion,
  type TerminalInputSuggestionContext,
} from "../lib/terminalInputSuggestions";
import { resolveManualDirectCodexEnterData } from "../lib/codexManualInput";
import { getTerminalCellWidth, resolveCursorIndexFromCellOffset } from "../lib/terminalCellWidth";
import { trimTerminalPasteBoundaryLineBreaks } from "../lib/terminalKeyboard";
import { attachTerminalIme } from "../lib/terminalIme";
import {
  clampTextCursorIndex,
  getTextCursorLength,
  insertTextAtCursor,
  removeTextAtCursor,
  removeTextBeforeCursor,
  repeatControlSequence,
  sliceTextByCursor,
} from "../lib/terminalTextEditing";
import { TUI_BORDER_CHAR_PATTERN, TUI_COMPOSER_PROMPT_PATTERN } from "../lib/terminalTui";
import { logError } from "../lib/logger";
import { defaultShellForOs } from "../lib/shell";
import type { OsPlatform } from "../lib/shell";
import { formatShellPathList, joinLocalPath, normalizeShellForKnownOs } from "../lib/terminalShellPath";
import type { CommandHistoryEntry, CommandTemplate, TerminalSession } from "../lib/types";
import { useCommandHistoryStore } from "../stores/commandHistoryStore";
import { useProjectStore } from "../stores/projectStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useTemplateStore } from "../stores/templateStore";
import { useTerminalStore } from "../stores/terminalStore";

const SUGGESTION_CONTEXT_CACHE_TTL_MS = 2_000;
const SUGGESTION_LOCAL_DEBOUNCE_MS = 80;
const SUGGESTION_AI_DEBOUNCE_MS = 400;
const IME_CROSS_SOURCE_DUPLICATE_WINDOW_MS = 80;

export interface TerminalSuggestionGhostState {
  suffix: string;
  left: number;
  top: number;
  height: number;
  maxWidth: number;
}

interface TerminalCellSize {
  width: number;
  height: number;
}

interface UseTerminalInputOptions {
  sessionId: string;
  wrapperRef: RefObject<HTMLDivElement | null>;
  containerRef: RefObject<HTMLDivElement | null>;
  isActiveRef: RefObject<boolean>;
  isVisibleRef: RefObject<boolean>;
  fontSize: number;
  canShowSuggestionAtCurrentInputEnd: (terminal: Terminal, input: string) => boolean;
  getTerminalRenderedCellSize: (terminal: Terminal, container: HTMLElement, fallbackFontSize: number) => TerminalCellSize;
  setSuggestionGhost: Dispatch<SetStateAction<TerminalSuggestionGhostState | null>>;
  getOsPlatformForPathQuoting: () => Promise<Parameters<typeof normalizeShellForKnownOs>[1]>;
  cleanupExpiredAttachmentsOnce: (rootPath: string | null | undefined) => void;
}

interface SuggestionContextCache {
  loadedAt: number;
  projectId: string | null;
  history: CommandHistoryEntry[];
  templates: CommandTemplate[];
}

interface TerminalInputSelectionOptions {
  markAttentionInputHandled: () => void;
  reportPtyWriteError: (stage: string, err: unknown) => void;
}

export type TerminalInputSource = "onData" | "nativeTextInput";

interface TerminalInputForwardingOptions {
  selection: TerminalInputSelectionController;
  osPlatformRef: RefObject<OsPlatform>;
  markAttentionInputHandled: () => void;
  reportPtyWriteError: (stage: string, err: unknown) => void;
  updateSessionCwdIfChanged: (cwd: string | null) => void;
  onInputForwarded: (data: string) => void;
}

export interface TerminalInputForwardingController {
  dispose: () => void;
  forwardTerminalInput: (data: string, source: TerminalInputSource) => void;
}

interface TerminalInputImeOptions {
  forwarding: TerminalInputForwardingController;
  osPlatformRef: RefObject<OsPlatform>;
  scheduleFit: (force?: boolean) => void;
  onCompositionCommitted: (textareaValue: string) => void;
}

export interface TerminalInputSelectionController {
  dispose: () => void;
  clearInputSelectionState: () => void;
  clearSelectedInputSnapshot: () => void;
  clearKeyboardInputSelection: () => void;
  selectCurrentInputText: () => boolean;
  extendKeyboardInputSelection: (direction: -1 | 1) => void;
  collapseKeyboardInputSelection: (direction: -1 | 1) => boolean;
  removeSelectedInputText: () => boolean;
  consumeSelectedInputForReplacement: (data: string) => string | null;
}

export interface UseTerminalInputResult {
  isComposingRef: RefObject<boolean>;
  attachInputForwarding: (
    terminal: Terminal,
    options: TerminalInputForwardingOptions,
  ) => TerminalInputForwardingController;
  attachIme: (terminal: Terminal, options: TerminalInputImeOptions) => () => void;
  clearSuggestion: () => void;
  cancelAiSuggestionRefresh: () => void;
  scheduleSuggestionRefresh: () => void;
  updateSuggestionGhostPosition: () => void;
  acceptSuggestion: () => boolean;
  onCommandSubmitted: (command: string) => void;
  attachPasteAndDrop: (terminal: Terminal) => () => void;
  pasteText: (terminal: Terminal, text: string) => void;
  attachSelection: (
    terminal: Terminal,
    options: TerminalInputSelectionOptions,
  ) => TerminalInputSelectionController;
}

export function useTerminalInput({
  sessionId,
  wrapperRef,
  containerRef,
  isActiveRef,
  isVisibleRef,
  fontSize,
  canShowSuggestionAtCurrentInputEnd,
  getTerminalRenderedCellSize,
  setSuggestionGhost,
  getOsPlatformForPathQuoting,
  cleanupExpiredAttachmentsOnce,
}: UseTerminalInputOptions): UseTerminalInputResult {
  const inputBufferRef = useRef("");
  const inputCursorIndexRef = useRef(0);
  // Input owns this ref. Display reads it only to suppress fit during composition.
  const isComposingRef = useRef(false);
  const suggestionRef = useRef<TerminalInputSuggestion | null>(null);
  const suggestionRequestIdRef = useRef(0);
  const suggestionRefreshTimerIdRef = useRef<number | null>(null);
  const aiSuggestionTimerIdRef = useRef<number | null>(null);
  const aiSuggestionInFlightRef = useRef(false);
  const aiSuggestionQueuedRef = useRef(false);
  const pendingAiSuggestionContextRef = useRef<TerminalInputSuggestionContext | null>(null);
  const pendingAiSuggestionRequestIdRef = useRef(0);
  const suggestionDisposedRef = useRef(false);
  const attachmentGenerationRef = useRef(0);
  const suggestionTemplatesLoadedRef = useRef(false);
  const lastSubmittedCommandRef = useRef<string | null>(null);
  const suggestionContextCacheRef = useRef<SuggestionContextCache | null>(null);
  const clearSuggestionRef = useRef<() => void>(() => {});
  const cancelAiSuggestionRefreshRef = useRef<() => void>(() => {});
  const scheduleSuggestionRefreshRef = useRef<() => void>(() => {});
  const updateSuggestionGhostPositionRef = useRef<() => void>(() => {});
  const acceptSuggestionRef = useRef<() => boolean>(() => false);
  const getInput = () => inputBufferRef.current;

  const resetSuggestionState = () => {
    const generation = attachmentGenerationRef.current + 1;
    attachmentGenerationRef.current = generation;
    if (suggestionRefreshTimerIdRef.current !== null) {
      window.clearTimeout(suggestionRefreshTimerIdRef.current);
    }
    if (aiSuggestionTimerIdRef.current !== null) {
      window.clearTimeout(aiSuggestionTimerIdRef.current);
    }
    suggestionRef.current = null;
    suggestionRequestIdRef.current = 0;
    suggestionRefreshTimerIdRef.current = null;
    aiSuggestionTimerIdRef.current = null;
    aiSuggestionInFlightRef.current = false;
    aiSuggestionQueuedRef.current = false;
    pendingAiSuggestionContextRef.current = null;
    pendingAiSuggestionRequestIdRef.current = 0;
    suggestionDisposedRef.current = false;
    suggestionTemplatesLoadedRef.current = false;
    lastSubmittedCommandRef.current = null;
    suggestionContextCacheRef.current = null;
    setSuggestionGhost(null);
    return generation;
  };

  const updateInputBufferFromTerminalData = (
    data: string,
    updateSessionCwdIfChanged: (cwd: string | null) => void,
  ) => {
    if (data === "\r") {
      const command = inputBufferRef.current;
      if (command.trim()) {
        const submittedCwd = useTerminalStore.getState().sessions.find((item) => item.id === sessionId)?.cwd ?? null;
        void resolveSubmittedDirectoryChange(command, submittedCwd)
          .then((cwd) => updateSessionCwdIfChanged(cwd))
          .catch(() => {});
        useTerminalStore.getState().handleShellRuntimeEvent({
          sessionId,
          event: "command_started",
          origin: "input",
        });
      }
      inputBufferRef.current = "";
      inputCursorIndexRef.current = 0;
      cancelAiSuggestionRefreshRef.current();
      clearSuggestionRef.current();
      return;
    }

    if (data === "\x7f" || data === "\b") {
      const next = removeTextBeforeCursor(inputBufferRef.current, inputCursorIndexRef.current);
      inputBufferRef.current = next.text;
      inputCursorIndexRef.current = next.cursorIndex;
      scheduleSuggestionRefreshRef.current();
      return;
    }

    if (data.length === 1 && data.charCodeAt(0) >= 32) {
      const cursorIndex = clampTextCursorIndex(inputBufferRef.current, inputCursorIndexRef.current);
      inputBufferRef.current = insertTextAtCursor(inputBufferRef.current, cursorIndex, data);
      inputCursorIndexRef.current = cursorIndex + getTextCursorLength(data);
      scheduleSuggestionRefreshRef.current();
      return;
    }

    if (data.length > 1) {
      const pastedText = data.replace(/^\x1b\[200~/, "").replace(/\x1b\[201~$/, "");
      if (!pastedText.startsWith("\x1b")) {
        const normalizedPaste = pastedText.replace(/\r\n?/g, "\n");
        const cursorIndex = clampTextCursorIndex(inputBufferRef.current, inputCursorIndexRef.current);
        inputBufferRef.current = insertTextAtCursor(inputBufferRef.current, cursorIndex, normalizedPaste);
        inputCursorIndexRef.current = cursorIndex + getTextCursorLength(normalizedPaste);
        scheduleSuggestionRefreshRef.current();
        return;
      }
      if (data === "\x1b[D" || data === "\x1bOD") {
        inputCursorIndexRef.current = clampTextCursorIndex(inputBufferRef.current, inputCursorIndexRef.current - 1);
        cancelAiSuggestionRefreshRef.current();
        clearSuggestionRef.current();
        return;
      }
      if (data === "\x1b[C" || data === "\x1bOC") {
        inputCursorIndexRef.current = clampTextCursorIndex(inputBufferRef.current, inputCursorIndexRef.current + 1);
        cancelAiSuggestionRefreshRef.current();
        clearSuggestionRef.current();
        return;
      }
      if (data === "\x1b[3~") {
        const next = removeTextAtCursor(inputBufferRef.current, inputCursorIndexRef.current);
        inputBufferRef.current = next.text;
        inputCursorIndexRef.current = next.cursorIndex;
        scheduleSuggestionRefreshRef.current();
        return;
      }
    }

    cancelAiSuggestionRefreshRef.current();
    clearSuggestionRef.current();
  };

  const attachSelection = (
    terminal: Terminal,
    {
      markAttentionInputHandled,
      reportPtyWriteError,
    }: TerminalInputSelectionOptions,
  ): TerminalInputSelectionController => {
    let selectedInputSnapshot: string | null = null;
    let keyboardInputSelection: {
      anchorIndex: number;
      focusIndex: number;
      inputStartCellIndex: number;
    } | null = null;

    const clearSelectedInputSnapshot = () => {
      selectedInputSnapshot = null;
    };
    const clearKeyboardInputSelection = () => {
      keyboardInputSelection = null;
    };
    const clearInputSelectionState = () => {
      clearKeyboardInputSelection();
      clearSelectedInputSnapshot();
    };
    const clearSuggestion = () => clearSuggestionRef.current();
    const cancelAiSuggestionRefresh = () => cancelAiSuggestionRefreshRef.current();

    // Ctrl+U only deletes before the cursor, so move to the tracked input end first.
    const buildKillCurrentInputSequence = () => {
      const currentInput = inputBufferRef.current;
      const currentCursorIndex = clampTextCursorIndex(currentInput, inputCursorIndexRef.current);
      const moveToEnd = repeatControlSequence(
        "\x1b[C",
        getTextCursorLength(currentInput) - currentCursorIndex,
      );
      return moveToEnd + "\x15";
    };

    const rewriteCurrentInput = (
      nextInput: string,
      stage: string,
      cursorIndex: number = getTextCursorLength(nextInput),
    ) => {
      const killCurrentInput = buildKillCurrentInputSequence();
      const nextCursorIndex = clampTextCursorIndex(nextInput, cursorIndex);
      const cursorRestore = repeatControlSequence(
        "\x1b[D",
        getTextCursorLength(nextInput) - nextCursorIndex,
      );
      inputBufferRef.current = nextInput;
      inputCursorIndexRef.current = nextCursorIndex;
      terminal.clearSelection();
      clearInputSelectionState();
      markAttentionInputHandled();
      clearSuggestion();
      cancelAiSuggestionRefresh();
      invoke("pty_write", { sessionId, data: killCurrentInput + nextInput + cursorRestore })
        .catch((err) => reportPtyWriteError(stage, err));
    };

    const isReplaceableInputData = (data: string) => {
      if (!data || data === "\r" || data === "\x7f" || data === "\b") return false;
      if (data.startsWith("\x1b") && !data.startsWith("\x1b[200~")) return false;
      return true;
    };

    const consumeSelectedInputForReplacement = (data: string) => {
      if (
        !selectedInputSnapshot
        || selectedInputSnapshot !== inputBufferRef.current
        || !terminal.hasSelection()
        || !isReplaceableInputData(data)
      ) {
        return null;
      }

      const killCurrentInput = buildKillCurrentInputSequence();
      inputBufferRef.current = "";
      inputCursorIndexRef.current = 0;
      clearSelectedInputSnapshot();
      terminal.clearSelection();
      return killCurrentInput;
    };

    const resolveVisibleInputSelection = () => {
      const buffer = terminal.buffer.active;
      const rowText = (row: number) => {
        const line = buffer.getLine(buffer.viewportY + row);
        return line ? line.translateToString(true) : null;
      };
      const rowIsHorizontalRule = (row: number) => {
        const text = rowText(row);
        if (text === null) return false;
        const trimmed = text.trim();
        return trimmed.length > 0 && /^[─━═╌╍┄┅┈┉╴╶]+$/u.test(trimmed);
      };
      const findPromptContentStartColumn = (line: IBufferLine) => {
        const limit = Math.min(terminal.cols, line.length);
        for (let x = 0; x < limit; x += 1) {
          const cell = line.getCell(x);
          const chars = cell?.getChars() ?? "";
          if (!cell || !chars.trim() || TUI_BORDER_CHAR_PATTERN.test(chars)) continue;
          if (!TUI_COMPOSER_PROMPT_PATTERN.test(chars)) return null;
          let start = x + Math.max(1, cell.getWidth());
          while (start < limit) {
            const nextCell = line.getCell(start);
            const nextChars = nextCell?.getChars() ?? "";
            if (nextChars !== " ") break;
            start += Math.max(1, nextCell?.getWidth() ?? 1);
          }
          return start;
        }
        return null;
      };
      const getContentEndColumn = (line: IBufferLine, minColumn: number) => {
        const limit = Math.min(terminal.cols, line.length);
        for (let x = limit - 1; x >= minColumn; x -= 1) {
          const cell = line.getCell(x);
          const chars = cell?.getChars() ?? "";
          if (!cell || cell.getWidth() === 0 || !chars.trim() || TUI_BORDER_CHAR_PATTERN.test(chars)) continue;
          return Math.min(terminal.cols, x + Math.max(1, cell.getWidth()));
        }
        return minColumn;
      };

      for (let row = terminal.rows - 1; row >= 0; row -= 1) {
        const line = buffer.getLine(buffer.viewportY + row);
        if (!line) continue;
        const startColumn = findPromptContentStartColumn(line);
        if (startColumn === null) continue;

        let endRow = row;
        let endColumn = getContentEndColumn(line, startColumn);
        for (let nextRow = row + 1; nextRow < terminal.rows; nextRow += 1) {
          const nextLine = buffer.getLine(buffer.viewportY + nextRow);
          if (!nextLine || rowIsHorizontalRule(nextRow) || !nextLine.isWrapped) break;
          const nextEndColumn = getContentEndColumn(nextLine, 0);
          if (nextEndColumn <= 0) break;
          endRow = nextRow;
          endColumn = nextEndColumn;
        }

        const startCellIndex = ((buffer.viewportY + row) * terminal.cols) + startColumn;
        const endCellIndex = ((buffer.viewportY + endRow) * terminal.cols) + endColumn;
        const length = endCellIndex - startCellIndex;
        if (length <= 0) return null;
        return { startColumn, startRow: buffer.viewportY + row, length };
      }

      return null;
    };

    const selectCurrentInputText = () => {
      const currentInput = inputBufferRef.current;
      clearKeyboardInputSelection();
      selectedInputSnapshot = currentInput || null;
      terminal.clearSelection();
      if (!currentInput) {
        terminal.focus();
        return true;
      }

      const inputCellWidth = getTerminalCellWidth(currentInput);
      if (inputCellWidth <= 0) {
        terminal.focus();
        return true;
      }

      const visibleSelection = resolveVisibleInputSelection();
      if (visibleSelection) {
        terminal.select(visibleSelection.startColumn, visibleSelection.startRow, visibleSelection.length);
        terminal.focus();
        return true;
      }

      const buffer = terminal.buffer.active;
      const cursorCellIndex = ((buffer.baseY + buffer.cursorY) * terminal.cols) + buffer.cursorX;
      const cursorPrefixWidth = getTerminalCellWidth(
        sliceTextByCursor(currentInput, 0, inputCursorIndexRef.current),
      );
      const startCellIndex = Math.max(0, cursorCellIndex - cursorPrefixWidth);
      terminal.select(startCellIndex % terminal.cols, Math.floor(startCellIndex / terminal.cols), inputCellWidth);
      terminal.focus();
      return true;
    };

    const renderKeyboardInputSelection = (
      currentInput: string,
      selection: NonNullable<typeof keyboardInputSelection>,
    ) => {
      const startIndex = Math.min(selection.anchorIndex, selection.focusIndex);
      const endIndex = Math.max(selection.anchorIndex, selection.focusIndex);
      if (startIndex === endIndex) {
        terminal.clearSelection();
        return;
      }

      const startCellIndex = selection.inputStartCellIndex
        + getTerminalCellWidth(sliceTextByCursor(currentInput, 0, startIndex));
      const selectionCellWidth = getTerminalCellWidth(sliceTextByCursor(currentInput, startIndex, endIndex));
      terminal.select(
        startCellIndex % terminal.cols,
        Math.floor(startCellIndex / terminal.cols),
        selectionCellWidth,
      );
    };

    const extendKeyboardInputSelection = (direction: -1 | 1) => {
      const currentInput = inputBufferRef.current;
      const currentCursorIndex = clampTextCursorIndex(currentInput, inputCursorIndexRef.current);
      const targetCursorIndex = clampTextCursorIndex(currentInput, currentCursorIndex + direction);
      if (!currentInput || targetCursorIndex === currentCursorIndex) {
        terminal.focus();
        return;
      }

      const selection = keyboardInputSelection ?? (() => {
        const buffer = terminal.buffer.active;
        const cursorCellIndex = ((buffer.baseY + buffer.cursorY) * terminal.cols) + buffer.cursorX;
        const cursorPrefixWidth = getTerminalCellWidth(sliceTextByCursor(currentInput, 0, currentCursorIndex));
        return {
          anchorIndex: currentCursorIndex,
          focusIndex: currentCursorIndex,
          inputStartCellIndex: Math.max(0, cursorCellIndex - cursorPrefixWidth),
        };
      })();

      const nextSelection = { ...selection, focusIndex: targetCursorIndex };
      keyboardInputSelection = nextSelection;
      clearSelectedInputSnapshot();
      inputCursorIndexRef.current = targetCursorIndex;
      renderKeyboardInputSelection(currentInput, nextSelection);
      clearSuggestion();
      cancelAiSuggestionRefresh();
      markAttentionInputHandled();
      invoke("pty_write", { sessionId, data: direction < 0 ? "\x1b[D" : "\x1b[C" })
        .catch((err) => reportPtyWriteError("keyboard_selection", err));
      terminal.focus();
    };

    const collapseKeyboardInputSelection = (direction: -1 | 1) => {
      if (!keyboardInputSelection) return false;
      const startIndex = Math.min(keyboardInputSelection.anchorIndex, keyboardInputSelection.focusIndex);
      const endIndex = Math.max(keyboardInputSelection.anchorIndex, keyboardInputSelection.focusIndex);
      if (startIndex === endIndex) {
        clearKeyboardInputSelection();
        return false;
      }

      const currentCursorIndex = clampTextCursorIndex(inputBufferRef.current, inputCursorIndexRef.current);
      const targetCursorIndex = direction < 0 ? startIndex : endIndex;
      const delta = targetCursorIndex - currentCursorIndex;
      const data = delta > 0
        ? repeatControlSequence("\x1b[C", delta)
        : repeatControlSequence("\x1b[D", -delta);
      clearInputSelectionState();
      inputCursorIndexRef.current = targetCursorIndex;
      terminal.clearSelection();
      clearSuggestion();
      cancelAiSuggestionRefresh();
      markAttentionInputHandled();
      if (data) {
        invoke("pty_write", { sessionId, data })
          .catch((err) => reportPtyWriteError("keyboard_selection_collapse", err));
      }
      terminal.focus();
      return true;
    };

    const removeSelectedInputText = () => {
      const selectedText = terminal.getSelection();
      const currentInput = inputBufferRef.current;
      const findSelectedTextRange = (preferredStartIndex?: number) => {
        if (!selectedText || !currentInput) return null;
        const candidates = [
          selectedText,
          selectedText.replace(/\r\n?/g, "\n"),
          selectedText.replace(/\r\n?|\n/g, ""),
        ].filter((text, index, list) => Boolean(text) && list.indexOf(text) === index);
        const inputChars = Array.from(currentInput);

        for (const candidate of candidates) {
          const candidateChars = Array.from(candidate);
          if (!candidateChars.length || candidateChars.length > inputChars.length) continue;

          const ranges: Array<{ startIndex: number; endIndex: number }> = [];
          for (let index = 0; index <= inputChars.length - candidateChars.length; index += 1) {
            const matched = candidateChars.every((char, offset) => inputChars[index + offset] === char);
            if (matched) {
              ranges.push({ startIndex: index, endIndex: index + candidateChars.length });
            }
          }

          if (ranges.length === 1 || (ranges.length && preferredStartIndex !== undefined)) {
            return ranges.reduce((best, range) => (
              Math.abs(range.startIndex - (preferredStartIndex ?? range.startIndex))
              < Math.abs(best.startIndex - (preferredStartIndex ?? best.startIndex))
                ? range
                : best
            ));
          }
        }

        return null;
      };
      const deleteInputRange = (startIndex: number, endIndex: number, stage: string) => {
        if (startIndex >= endIndex) return false;
        const nextInput = sliceTextByCursor(currentInput, 0, startIndex)
          + sliceTextByCursor(currentInput, endIndex);
        rewriteCurrentInput(nextInput, stage, startIndex);
        return true;
      };

      if (keyboardInputSelection && terminal.hasSelection()) {
        const startIndex = Math.min(keyboardInputSelection.anchorIndex, keyboardInputSelection.focusIndex);
        const endIndex = Math.max(keyboardInputSelection.anchorIndex, keyboardInputSelection.focusIndex);
        if (deleteInputRange(startIndex, endIndex, "keyboard_selection_delete")) return true;
      }
      clearKeyboardInputSelection();

      if (terminal.hasSelection() && currentInput) {
        const selectionPosition = terminal.getSelectionPosition();
        const visibleSelection = resolveVisibleInputSelection();
        if (selectionPosition && visibleSelection) {
          const inputStartCellIndex = (visibleSelection.startRow * terminal.cols) + visibleSelection.startColumn;
          const inputEndCellIndex = inputStartCellIndex + visibleSelection.length;
          const selectionStartCellIndex = (selectionPosition.start.y * terminal.cols) + selectionPosition.start.x;
          const selectionEndCellIndex = (selectionPosition.end.y * terminal.cols) + selectionPosition.end.x;
          const selectedStartCellIndex = Math.max(
            inputStartCellIndex,
            Math.min(selectionStartCellIndex, selectionEndCellIndex),
          );
          const selectedEndCellIndex = Math.min(
            inputEndCellIndex,
            Math.max(selectionStartCellIndex, selectionEndCellIndex),
          );

          if (selectedEndCellIndex > selectedStartCellIndex) {
            const startIndex = resolveCursorIndexFromCellOffset(
              currentInput,
              selectedStartCellIndex - inputStartCellIndex,
            );
            const endIndex = resolveCursorIndexFromCellOffset(
              currentInput,
              selectedEndCellIndex - inputStartCellIndex,
            );
            const textRange = findSelectedTextRange(startIndex);
            if (textRange && deleteInputRange(textRange.startIndex, textRange.endIndex, "selection_delete_text")) {
              return true;
            }
            if (deleteInputRange(startIndex, endIndex, "selection_delete")) return true;
          }
        }

        const textRange = findSelectedTextRange();
        if (textRange && deleteInputRange(textRange.startIndex, textRange.endIndex, "selection_delete_text")) {
          return true;
        }
      }

      if (!selectedText && selectedInputSnapshot === currentInput && currentInput) {
        rewriteCurrentInput("", "selection_delete_all");
        return true;
      }

      if (!selectedText || !currentInput) {
        clearSelectedInputSnapshot();
        return false;
      }

      if (selectedInputSnapshot === currentInput) {
        rewriteCurrentInput("", "selection_delete_all");
        return true;
      }

      const textRange = findSelectedTextRange();
      if (!textRange) return false;
      return deleteInputRange(textRange.startIndex, textRange.endIndex, "selection_delete_text");
    };

    const contextMenuTarget = containerRef.current;
    const clearKeyboardInputSelectionOnMouseDown = (event: MouseEvent) => {
      if (event.button !== 0) return;
      clearInputSelectionState();
    };
    contextMenuTarget?.addEventListener("mousedown", clearKeyboardInputSelectionOnMouseDown);



    return {
      dispose: () => {
        contextMenuTarget?.removeEventListener("mousedown", clearKeyboardInputSelectionOnMouseDown);
        clearInputSelectionState();
      },
      clearInputSelectionState,
      clearSelectedInputSnapshot,
      clearKeyboardInputSelection,
      selectCurrentInputText,
      extendKeyboardInputSelection,
      collapseKeyboardInputSelection,
      removeSelectedInputText,
      consumeSelectedInputForReplacement,
    };
  };

  const attachInputForwarding = (
    terminal: Terminal,
    {
      selection,
      osPlatformRef,
      markAttentionInputHandled,
      reportPtyWriteError,
      updateSessionCwdIfChanged,
      onInputForwarded,
    }: TerminalInputForwardingOptions,
  ): TerminalInputForwardingController => {
    let lastForwardedTerminalInput: { data: string; source: TerminalInputSource; at: number } | null = null;
    const isImeDuplicateCandidate = (data: string) => {
      if (!data || data === "\r" || data === "\x7f" || data === "\b" || data.startsWith("\x1b")) return false;
      const normalized = data.replace(/\r\n?/g, "\n");
      return Boolean(normalized.trim()) && /[^\x00-\x7f]/.test(normalized);
    };
    const shouldDropCrossSourceImeDuplicate = (data: string, source: TerminalInputSource, now: number) => {
      if (!isImeDuplicateCandidate(data) || !lastForwardedTerminalInput) return false;
      const deltaMs = now - lastForwardedTerminalInput.at;
      return (
        lastForwardedTerminalInput.source !== source
        && lastForwardedTerminalInput.data === data
        && deltaMs >= 0
        && deltaMs <= IME_CROSS_SOURCE_DUPLICATE_WINDOW_MS
      );
    };
    const forwardTerminalInput = (data: string, source: TerminalInputSource) => {
      const now = performance.now();
      if (shouldDropCrossSourceImeDuplicate(data, source, now)) return;

      markAttentionInputHandled();
      const replacingSelectedInput = selection.consumeSelectedInputForReplacement(data);
      if (!replacingSelectedInput) {
        selection.clearSelectedInputSnapshot();
      }
      selection.clearKeyboardInputSelection();
      const inputBufferBefore = getInput();
      const manualDirectCodexOverride = resolveManualDirectCodexEnterData({
        data,
        inputBuffer: inputBufferBefore,
        os: osPlatformRef.current,
      });
      const ptyData = manualDirectCodexOverride ?? data;
      lastForwardedTerminalInput = { data, source, at: now };
      invoke("pty_write", {
        sessionId,
        data: replacingSelectedInput ? replacingSelectedInput + ptyData : ptyData,
      }).catch((err) => reportPtyWriteError(source, err));
      onInputForwarded(data);
      updateInputBufferFromTerminalData(data, updateSessionCwdIfChanged);
    };

    const detachInputSuggestions = attachSuggestions(terminal, (data) => {
      forwardTerminalInput(data, "onData");
    });
    const onDataDisposable = terminal.onData((data) => {
      forwardTerminalInput(data, "onData");
    });

    return {
      dispose: () => {
        detachInputSuggestions();
        onDataDisposable.dispose();
      },
      forwardTerminalInput,
    };
  };

  const attachIme = (
    terminal: Terminal,
    {
      forwarding,
      osPlatformRef,
      scheduleFit,
      onCompositionCommitted,
    }: TerminalInputImeOptions,
  ) => {
    const container = containerRef.current;
    if (!container) return () => {};
    return attachTerminalIme({
      terminal,
      container,
      isActiveRef,
      isComposingRef,
      osPlatformRef,
      fontSize,
      getTerminalRenderedCellSize,
      forwardNativeInput: (data) => forwarding.forwardTerminalInput(data, "nativeTextInput"),
      clearSuggestion: () => clearSuggestionRef.current(),
      updateSuggestionPosition: () => updateSuggestionGhostPositionRef.current(),
      scheduleFit,
      onCompositionCommitted,
    });
  };

  const attachSuggestions = (terminal: Terminal, forwardSuggestionInput: (data: string) => void) => {
    // Input contract: session-scoped suggestion state must reset before every attach.
    const attachmentGeneration = resetSuggestionState();
    const isCurrentAttachment = () => (
      attachmentGenerationRef.current === attachmentGeneration && !suggestionDisposedRef.current
    );

    const clearSuggestion = () => {
      suggestionRef.current = null;
      setSuggestionGhost(null);
    };

    const cancelAiSuggestionRefresh = () => {
      if (aiSuggestionTimerIdRef.current !== null) {
        window.clearTimeout(aiSuggestionTimerIdRef.current);
        aiSuggestionTimerIdRef.current = null;
      }
      pendingAiSuggestionContextRef.current = null;
      aiSuggestionQueuedRef.current = false;
    };

    const updateSuggestionGhostPosition = () => {
      const suggestion = suggestionRef.current;
      if (
        !suggestion
        || !isCurrentAttachment()
        || !isActiveRef.current
        || !isVisibleRef.current
        || isComposingRef.current
      ) {
        clearSuggestion();
        return;
      }
      const input = getInput();
      if (!canShowSuggestionAtCurrentInputEnd(terminal, input)) {
        clearSuggestion();
        return;
      }
      const wrapper = wrapperRef.current;
      const container = containerRef.current;
      if (!wrapper || !container) {
        clearSuggestion();
        return;
      }

      const screen = container.querySelector(".xterm-screen") as HTMLElement | null;
      const wrapperRect = wrapper.getBoundingClientRect();
      const screenRect = (screen ?? container).getBoundingClientRect();
      const fallbackFontSize = typeof terminal.options.fontSize === "number" ? terminal.options.fontSize : fontSize;
      const cell = getTerminalRenderedCellSize(terminal, container, fallbackFontSize);
      const buffer = terminal.buffer.active;
      const left = screenRect.left - wrapperRect.left + Math.max(0, buffer.cursorX) * cell.width;
      const top = screenRect.top - wrapperRect.top + Math.max(0, buffer.cursorY) * cell.height;
      const maxWidth = Math.max(0, wrapperRect.right - wrapperRect.left - left - 8);
      if (maxWidth < cell.width || top < 0 || top > wrapperRect.height) {
        clearSuggestion();
        return;
      }

      const nextGhost = {
        suffix: suggestion.suffix,
        left,
        top,
        height: Math.max(1, cell.height),
        maxWidth,
      };
      setSuggestionGhost((current) => {
        if (
          current
          && current.suffix === nextGhost.suffix
          && current.left === nextGhost.left
          && current.top === nextGhost.top
          && current.height === nextGhost.height
          && current.maxWidth === nextGhost.maxWidth
        ) {
          return current;
        }
        return nextGhost;
      });
    };

    const loadSuggestionContext = async (projectId: string | null) => {
      const now = Date.now();
      const cached = suggestionContextCacheRef.current;
      if (cached && cached.projectId === projectId && now - cached.loadedAt <= SUGGESTION_CONTEXT_CACHE_TTL_MS) {
        return cached;
      }

      const templateStore = useTemplateStore.getState();
      if (!suggestionTemplatesLoadedRef.current && templateStore.templates.length === 0) {
        suggestionTemplatesLoadedRef.current = true;
        await templateStore.fetchTemplates().catch(() => {});
      }
        const [history, templates] = await Promise.all([
          useCommandHistoryStore.getState().getRecent(null, 120),
          Promise.resolve(useTemplateStore.getState().getForContext(projectId, sessionId)),
        ]);
      const context = {
        loadedAt: Date.now(),
          projectId,
          history,
        templates,
      };
      suggestionContextCacheRef.current = context;
      return context;
    };

    const buildSuggestionContext = (
      input: string,
      session: TerminalSession | undefined,
      history: CommandHistoryEntry[],
      templates: CommandTemplate[],
    ): TerminalInputSuggestionContext => {
      const settings = useSettingsStore.getState();
      return {
        input,
        projectId: session?.projectId ?? null,
        cwd: session?.cwd ?? null,
        shell: session?.shell ?? null,
          sessionId,
          previousCommand: lastSubmittedCommandRef.current,
          history,
        templates,
        provider: settings.terminalInputSuggestionProvider,
        model: TERMINAL_INPUT_SUGGESTION_AI_MODEL,
        debugLogging: settings.debugMode,
        aiConfig: {
          enabled: settings.terminalInputSuggestionLlmEnabled,
          baseUrl: settings.terminalInputSuggestionBaseUrl,
          apiKey: settings.terminalInputSuggestionApiKey,
          model: settings.terminalInputSuggestionModel,
          prompt: settings.terminalInputSuggestionUseBuiltinPrompt
            ? TERMINAL_INPUT_SUGGESTION_BUILTIN_PROMPT
            : settings.terminalInputSuggestionCustomPrompt,
        },
      };
    };

    const hasUsableAiConfig = (context: TerminalInputSuggestionContext) => Boolean(
      context.aiConfig?.enabled
      && context.aiConfig.baseUrl.trim()
      && context.aiConfig.apiKey.trim()
      && context.aiConfig.model.trim()
      && context.aiConfig.prompt.trim(),
    );

    const runPendingAiSuggestion = async (): Promise<void> => {
      if (aiSuggestionInFlightRef.current) {
        aiSuggestionQueuedRef.current = true;
        return;
      }
      const context = pendingAiSuggestionContextRef.current;
      const requestId = pendingAiSuggestionRequestIdRef.current;
      if (!context) return;
      pendingAiSuggestionContextRef.current = null;
      aiSuggestionQueuedRef.current = false;
      aiSuggestionInFlightRef.current = true;
      const result = await getTerminalInputSuggestionAiResult(context);
      aiSuggestionInFlightRef.current = false;
      if (result.aiAttempt) {
        useSettingsStore.getState().recordTerminalInputSuggestionUsage(result.aiAttempt);
      }
      if (
        isCurrentAttachment()
        && requestId === suggestionRequestIdRef.current
        && useSettingsStore.getState().terminalInputSuggestionsEnabled
        && context.input === getInput()
        && result.suggestions.length > 0
      ) {
        suggestionRef.current = result.suggestions[0];
        updateSuggestionGhostPosition();
      }
      if (aiSuggestionQueuedRef.current && pendingAiSuggestionContextRef.current) {
        void runPendingAiSuggestion();
      }
    };

    const scheduleAiSuggestionRefresh = (context: TerminalInputSuggestionContext, requestId: number) => {
      if (!hasUsableAiConfig(context)) {
        cancelAiSuggestionRefresh();
        return;
      }
      pendingAiSuggestionContextRef.current = context;
      pendingAiSuggestionRequestIdRef.current = requestId;
      if (aiSuggestionTimerIdRef.current !== null) {
        window.clearTimeout(aiSuggestionTimerIdRef.current);
      }
      aiSuggestionTimerIdRef.current = window.setTimeout(() => {
        aiSuggestionTimerIdRef.current = null;
        void runPendingAiSuggestion();
      }, SUGGESTION_AI_DEBOUNCE_MS);
    };

    const refreshSuggestionGhost = async () => {
      const requestId = ++suggestionRequestIdRef.current;
      const settings = useSettingsStore.getState();
      const input = getInput();
      if (
        !isCurrentAttachment()
        || !settings.terminalInputSuggestionsEnabled
        || !input
        || input.includes("\n")
        || input.includes("\r")
        || isComposingRef.current
      ) {
        cancelAiSuggestionRefresh();
        clearSuggestion();
        return;
      }

      const session = useTerminalStore.getState().sessions.find((item) => item.id === sessionId);
      const projectId = session?.projectId ?? null;
      const { history, templates } = await loadSuggestionContext(projectId);
      if (!isCurrentAttachment() || requestId !== suggestionRequestIdRef.current || input !== getInput()) return;
      if (!useSettingsStore.getState().terminalInputSuggestionsEnabled) {
        cancelAiSuggestionRefresh();
        clearSuggestion();
        return;
      }

      const context = buildSuggestionContext(input, session, history, templates);
      const localSuggestions = getLocalTerminalInputSuggestions(context, { limit: 1 });
      suggestionRef.current = localSuggestions[0] ?? null;
      updateSuggestionGhostPosition();
      scheduleAiSuggestionRefresh(context, requestId);

      void getTerminalPathInputSuggestions(context, { limit: 1 })
        .then((pathSuggestions) => {
          if (
            !isCurrentAttachment()
            || requestId !== suggestionRequestIdRef.current
            || input !== getInput()
            || !useSettingsStore.getState().terminalInputSuggestionsEnabled
            || suggestionRef.current?.source === "ai"
          ) {
            return;
          }
          suggestionRef.current = mergeTerminalInputSuggestions(
            [...localSuggestions, ...pathSuggestions],
            { limit: 1 },
          )[0] ?? null;
          updateSuggestionGhostPosition();
        })
        .catch(() => {});
    };

    const scheduleSuggestionRefresh = () => {
      if (suggestionRefreshTimerIdRef.current !== null) {
        window.clearTimeout(suggestionRefreshTimerIdRef.current);
      }
      suggestionRefreshTimerIdRef.current = window.setTimeout(() => {
        suggestionRefreshTimerIdRef.current = null;
        void refreshSuggestionGhost();
      }, SUGGESTION_LOCAL_DEBOUNCE_MS);
    };

    const acceptSuggestion = () => {
      const suggestion = suggestionRef.current;
      const settings = useSettingsStore.getState();
      if (!settings.terminalInputSuggestionsEnabled || !suggestion?.suffix) return false;
      clearSuggestion();
      forwardSuggestionInput(suggestion.suffix);
      settings.recordTerminalInputSuggestionUsage({ accepted: true });
      return true;
    };

    clearSuggestionRef.current = clearSuggestion;
    cancelAiSuggestionRefreshRef.current = cancelAiSuggestionRefresh;
    scheduleSuggestionRefreshRef.current = scheduleSuggestionRefresh;
    updateSuggestionGhostPositionRef.current = updateSuggestionGhostPosition;
    acceptSuggestionRef.current = acceptSuggestion;

    return () => {
      if (attachmentGenerationRef.current !== attachmentGeneration) return;
      suggestionDisposedRef.current = true;
      if (suggestionRefreshTimerIdRef.current !== null) {
        window.clearTimeout(suggestionRefreshTimerIdRef.current);
        suggestionRefreshTimerIdRef.current = null;
      }
      cancelAiSuggestionRefresh();
      clearSuggestion();
      clearSuggestionRef.current = () => {};
      cancelAiSuggestionRefreshRef.current = () => {};
      scheduleSuggestionRefreshRef.current = () => {};
      updateSuggestionGhostPositionRef.current = () => {};
      acceptSuggestionRef.current = () => false;
    };
  };

  const attachPasteAndDrop = (terminal: Terminal) => {
    const pasteTarget = containerRef.current;
    if (!pasteTarget) return () => {};

    const pasteIntoTerminal = (text: string) => pasteText(terminal, text);
    const pasteListenerOptions = { capture: true } as const;
    const isPointInsidePasteTarget = (x: number, y: number) => {
      const rect = pasteTarget.getBoundingClientRect();
      return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    };
    const hasTerminalFileDragData = (dataTransfer: DataTransfer | null) => (
      Boolean(getTerminalFileDragText()) || hasDataTransferType(dataTransfer, TERMINAL_FILE_PATH_MIME)
    );
    const unregisterTerminalDropZone = registerTerminalDropZone({
      id: sessionId,
      getRect: () => (isVisibleRef.current ? pasteTarget.getBoundingClientRect() : null),
      paste: pasteIntoTerminal,
      focus: () => terminal.focus(),
    });
    const getShellForPathQuoting = async () => {
      const os = await getOsPlatformForPathQuoting();
      const session = useTerminalStore.getState().sessions.find((item) => item.id === sessionId);
      const sessionShell = normalizeShellForKnownOs(session?.shell, os);
      if (sessionShell) return sessionShell;
      const defaultShell = normalizeShellForKnownOs(useSettingsStore.getState().defaultShell, os);
      return defaultShell ?? defaultShellForOs(os);
    };
    const getCurrentDropContext = () => {
      const session = useTerminalStore.getState().sessions.find((item) => item.id === sessionId);
      const project = session?.projectId
        ? useProjectStore.getState().projects.find((item) => item.id === session.projectId)
        : null;
      return { session, project };
    };
    const savePastedImageForTerminal = async (
      file: File,
      context: ReturnType<typeof getCurrentDropContext>,
    ): Promise<string | null> => {
      const { session, project } = context;
      const attachRootPath = project?.path || session?.cwd || null;
      if (!attachRootPath) return null;

      try {
        const fileName = createClipboardImageFileName(file);
        const dataBase64 = arrayBufferToBase64(await file.arrayBuffer());
        const attachedRelativePath = await invoke<string>("file_attach_data", {
          rootPath: attachRootPath,
          fileName,
          dataBase64,
        });
        cleanupExpiredAttachmentsOnce(attachRootPath);
        return joinLocalPath(attachRootPath, attachedRelativePath);
      } catch (err) {
        logError("Failed to attach pasted terminal image", { sessionId, err });
        toast.error("截图粘贴失败", { description: String(err) });
        return null;
      }
    };

    const onPaste = (event: ClipboardEvent) => {
      const imageFile = getClipboardImageFile(event.clipboardData);
      const context = getCurrentDropContext();
      if (imageFile) {
        event.preventDefault();
        event.stopPropagation();
        void savePastedImageForTerminal(imageFile, context).then(async (path) => {
          if (!path) return;
          pasteIntoTerminal(formatShellPathList([path], await getShellForPathQuoting()));
          terminal.focus();
        });
        return;
      }

      const text = event.clipboardData?.getData("text/plain");
      if (text === undefined) return;
      event.preventDefault();
      event.stopPropagation();
      pasteIntoTerminal(text);
    };
    pasteTarget.addEventListener("paste", onPaste, pasteListenerOptions);

    const onDragOver = (event: DragEvent) => {
      const isActiveTerminalFileDrag = Boolean(getTerminalFileDragText());
      if (isActiveTerminalFileDrag) updateTerminalFileDragPointFromEvent(event);
      if (!isPointInsidePasteTarget(event.clientX, event.clientY) || !hasTerminalFileDragData(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    };
    const onDrop = (event: DragEvent) => {
      if (!isPointInsidePasteTarget(event.clientX, event.clientY) || !hasTerminalFileDragData(event.dataTransfer)) return;
      const text = getTerminalFileDragText()
        || event.dataTransfer?.getData(TERMINAL_FILE_PATH_MIME)
        || event.dataTransfer?.getData("text/plain")
        || "";
      event.preventDefault();
      event.stopPropagation();
      if (!text) return;
      pasteIntoTerminal(text);
      endTerminalFileDrag();
      terminal.focus();
    };
    window.addEventListener("dragover", onDragOver, true);
    window.addEventListener("drop", onDrop, true);

    let fileDropCancelled = false;
    let unlistenFileDrop: (() => void) | null = null;
    getCurrentWebview().onDragDropEvent(async (event) => {
      const payload = event.payload;
      if (payload.type !== "drop" || payload.paths.length === 0 || !isVisibleRef.current) return;
      const scaleFactor = await getCurrentWindow().scaleFactor().catch(() => window.devicePixelRatio || 1);
      if (fileDropCancelled) return;
      const position = payload.position.toLogical(scaleFactor);
      const dropZoneId = getTerminalFileDropZoneIdAtPoint(position.x, position.y);
      if (dropZoneId && dropZoneId !== sessionId) return;
      if (!dropZoneId && (!isActiveRef.current || !isVisibleRef.current)) return;

      pasteIntoTerminal(formatShellPathList(payload.paths, await getShellForPathQuoting()));
      terminal.focus();
    }).then((unlisten) => {
      if (fileDropCancelled) {
        unlisten();
      } else {
        unlistenFileDrop = unlisten;
      }
    }).catch((err) => {
      logError("Failed to listen terminal file drop", { sessionId, err });
    });

    return () => {
      pasteTarget.removeEventListener("paste", onPaste, pasteListenerOptions);
      unregisterTerminalDropZone();
      window.removeEventListener("dragover", onDragOver, true);
      window.removeEventListener("drop", onDrop, true);
      fileDropCancelled = true;
      unlistenFileDrop?.();
    };
  };

  const pasteText = (terminal: Terminal, text: string) => {
    const normalizedText = trimTerminalPasteBoundaryLineBreaks(text);
    if (!normalizedText) return;
    useTerminalStore.getState().markAttentionInputHandled(sessionId);
    terminal.paste(normalizedText);
  };

  return {
    isComposingRef,
    attachInputForwarding,
    attachIme,
    clearSuggestion: () => clearSuggestionRef.current(),
    cancelAiSuggestionRefresh: () => cancelAiSuggestionRefreshRef.current(),
    scheduleSuggestionRefresh: () => scheduleSuggestionRefreshRef.current(),
    updateSuggestionGhostPosition: () => updateSuggestionGhostPositionRef.current(),
    acceptSuggestion: () => acceptSuggestionRef.current(),
    onCommandSubmitted: (command) => {
      lastSubmittedCommandRef.current = command;
      suggestionContextCacheRef.current = null;
    },
    attachPasteAndDrop,
    pasteText,
    attachSelection,
  };
}
