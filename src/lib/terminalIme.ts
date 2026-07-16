import type { RefObject } from "react";
import type { Terminal } from "@xterm/xterm";
import { TUI_BORDER_CHAR_PATTERN, TUI_BORDER_PREFIX_PATTERN } from "./terminalTui";
import type { OsPlatform } from "./shell";

const IME_PROCESS_KEY_CODE = 229;
const IME_PROCESS_KEY_RECOVERY_WINDOW_MS = 400;
const IME_COMPOSITION_END_SUPPRESS_WINDOW_MS = 80;
const NATIVE_TEXT_INPUT_DEDUP_WINDOW_MS = 16;
const CJK_NATIVE_PUNCTUATION_PATTERN = /^[\u3000-\u303f\uff01-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff65]+$/u;

interface TerminalCellSize {
  width: number;
  height: number;
}

export interface TerminalImeControllerOptions {
  terminal: Terminal;
  container: HTMLDivElement;
  isActiveRef: RefObject<boolean>;
  isComposingRef: RefObject<boolean>;
  osPlatformRef: RefObject<OsPlatform>;
  fontSize: number;
  getTerminalRenderedCellSize: (
    terminal: Terminal,
    container: HTMLElement,
    fallbackFontSize: number,
  ) => TerminalCellSize;
  forwardNativeInput: (data: string) => void;
  clearSuggestion: () => void;
  updateSuggestionPosition: () => void;
  scheduleFit: (force?: boolean) => void;
  onCompositionCommitted: (textareaValue: string) => void;
}

export const attachTerminalIme = ({
  terminal,
  container,
  isActiveRef,
  isComposingRef,
  osPlatformRef,
  fontSize,
  getTerminalRenderedCellSize,
  forwardNativeInput,
  clearSuggestion,
  updateSuggestionPosition,
  scheduleFit,
  onCompositionCommitted,
}: TerminalImeControllerOptions) => {
  const textarea = container.querySelector(".xterm-helper-textarea") as HTMLTextAreaElement | null;
  const viewport = container.querySelector(".xterm-viewport") as HTMLElement | null;
  const listenerOptions = { capture: true } as const;
  let cancelled = false;
  let lastImeProcessKeyAt = -1;
  let lastCompositionEndAt = -1;
  let lastNativeTextInputAt = -1;
  let lastNativeTextInputData = "";
  let compositionScrollRafId: number | null = null;
  let containerScrollResetRafId: number | null = null;
  let helperTextareaAnchorRafId: number | null = null;
  let compositionAnchorRafId: number | null = null;
  let compositionAnchorTimeoutId: number | null = null;
  let compositionScrollLock: { element: HTMLElement; scrollTop: number; scrollLeft: number }[] = [];
  let compositionAnchorCell: { x: number; y: number } | null = null;

  const captureCompositionScroll = () => {
    compositionScrollLock = [container, viewport]
      .filter((element): element is HTMLElement => Boolean(element))
      .map((element) => ({
        element,
        scrollTop: element.scrollTop,
        scrollLeft: element.scrollLeft,
      }));
  };

  const restoreCompositionScroll = () => {
    for (const { element, scrollTop, scrollLeft } of compositionScrollLock) {
      if (element.scrollTop !== scrollTop) element.scrollTop = scrollTop;
      if (element.scrollLeft !== scrollLeft) element.scrollLeft = scrollLeft;
    }
  };

  const scheduleCompositionScrollRestore = () => {
    restoreCompositionScroll();
    if (compositionScrollRafId !== null) {
      cancelAnimationFrame(compositionScrollRafId);
    }
    compositionScrollRafId = requestAnimationFrame(() => {
      compositionScrollRafId = null;
      restoreCompositionScroll();
    });
  };

  const resetTerminalContainerScroll = () => {
    if (container.scrollTop !== 0) container.scrollTop = 0;
    if (container.scrollLeft !== 0) container.scrollLeft = 0;
  };

  const scheduleTerminalContainerScrollReset = () => {
    resetTerminalContainerScroll();
    if (containerScrollResetRafId !== null) {
      cancelAnimationFrame(containerScrollResetRafId);
    }
    containerScrollResetRafId = requestAnimationFrame(() => {
      containerScrollResetRafId = null;
      resetTerminalContainerScroll();
    });
  };

  const estimateCellSize = () => {
    const fallbackFontSize = typeof terminal.options.fontSize === "number" ? terminal.options.fontSize : fontSize;
    return getTerminalRenderedCellSize(terminal, container, fallbackFontSize);
  };

  const resolveCompositionAnchorCell = () => {
    const buffer = terminal.buffer.active;
    const inputPromptPattern = /^(?:[>$#\u203a\u276f\u00bb\u2023]|PS(?:\s|>))/u;
    const clampX = (x: number) => Math.min(Math.max(0, x), Math.max(0, terminal.cols - 1));
    const clampY = (y: number) => Math.min(Math.max(0, y), Math.max(0, terminal.rows - 1));
    const cursor = {
      x: clampX(buffer.cursorX),
      y: clampY(buffer.cursorY),
    };
    const rowText = (row: number) => {
      const line = buffer.getLine(buffer.viewportY + row);
      return line ? line.translateToString(true) : null;
    };
    const rowIsPromptRow = (row: number) => {
      const text = rowText(row);
      if (text === null) return false;
      const trimmed = text.trimStart().replace(TUI_BORDER_PREFIX_PATTERN, "");
      return Boolean(trimmed) && inputPromptPattern.test(trimmed);
    };
    const rowIsHorizontalRule = (row: number) => {
      const text = rowText(row);
      if (text === null) return false;
      const trimmed = text.trim();
      return trimmed.length > 0 && /^[─━═╌╍┄┅┈┉╴╶]+$/u.test(trimmed);
    };
    const anchorAtRowTextEnd = (row: number) => {
      const line = buffer.getLine(buffer.viewportY + row);
      if (!line) return { x: 0, y: clampY(row) };
      for (let x = Math.min(terminal.cols, line.length) - 1; x >= 0; x -= 1) {
        const cell = line.getCell(x);
        const chars = cell?.getChars().trim();
        if (!cell || !chars || TUI_BORDER_CHAR_PATTERN.test(chars)) continue;
        return { x: clampX(x + Math.max(1, cell.getWidth())), y: clampY(row) };
      }
      const text = line.translateToString(true);
      const indent = text.length - text.replace(/^\s+/u, "").length;
      return { x: clampX(indent > 0 ? indent : 1), y: clampY(row) };
    };

    for (let row = terminal.rows - 1; row >= 0; row -= 1) {
      if (!rowIsPromptRow(row)) continue;

      let ruleRow = terminal.rows;
      for (let nextRow = row + 1; nextRow < terminal.rows; nextRow += 1) {
        if (rowIsHorizontalRule(nextRow)) {
          ruleRow = nextRow;
          break;
        }
      }
      const boxBottom = Math.max(row, ruleRow - 1);
      for (let nextRow = row; nextRow <= boxBottom; nextRow += 1) {
        const line = buffer.getLine(buffer.viewportY + nextRow);
        if (!line) continue;
        const width = Math.min(terminal.cols, line.length);
        for (let x = 0; x < width; x += 1) {
          const cell = line.getCell(x);
          if (cell && cell.isInverse() !== 0) {
            return { x: clampX(x), y: clampY(nextRow) };
          }
        }
      }

      if (ruleRow >= terminal.rows && cursor.y >= row) return cursor;

      let lastContentRow = row;
      for (let nextRow = row + 1; nextRow <= boxBottom; nextRow += 1) {
        if ((rowText(nextRow) ?? "").trim().length > 0) lastContentRow = nextRow;
      }
      const anchorRow = lastContentRow === row ? row : boxBottom;
      return anchorRow === row && cursor.y === row
        ? cursor
        : anchorAtRowTextEnd(anchorRow);
    }

    return cursor;
  };

  const applyCompositionAnchorFix = () => {
    if (!isComposingRef.current) return;
    const compositionView = container.querySelector(".composition-view") as HTMLElement | null;
    if (!textarea && !compositionView) return;
    const anchor = compositionAnchorCell ?? resolveCompositionAnchorCell();
    const cell = estimateCellSize();
    const left = String(Math.max(0, anchor.x * cell.width)) + "px";
    const top = String(Math.max(0, anchor.y * cell.height)) + "px";
    const height = String(Math.max(1, cell.height)) + "px";
    if (compositionView) {
      compositionView.style.left = left;
      compositionView.style.top = top;
      compositionView.style.height = height;
      compositionView.style.lineHeight = height;
    }
    if (textarea) {
      const compositionBounds = compositionView?.getBoundingClientRect();
      const width = compositionBounds && compositionBounds.width > 0
        ? compositionBounds.width
        : Math.max(1, cell.width);
      textarea.style.left = left;
      textarea.style.top = top;
      textarea.style.width = String(width) + "px";
      textarea.style.height = height;
      textarea.style.lineHeight = height;
    }
  };

  const scheduleCompositionAnchorFix = () => {
    applyCompositionAnchorFix();
    if (compositionAnchorRafId !== null) {
      cancelAnimationFrame(compositionAnchorRafId);
    }
    compositionAnchorRafId = requestAnimationFrame(() => {
      compositionAnchorRafId = null;
      applyCompositionAnchorFix();
    });
    if (compositionAnchorTimeoutId !== null) {
      window.clearTimeout(compositionAnchorTimeoutId);
    }
    compositionAnchorTimeoutId = window.setTimeout(() => {
      compositionAnchorTimeoutId = null;
      applyCompositionAnchorFix();
    }, 0);
  };

  const pinHelperTextareaAnchor = () => {
    if (!textarea || isComposingRef.current) return;
    const anchor = resolveCompositionAnchorCell();
    const cell = estimateCellSize();
    textarea.style.left = String(Math.max(0, anchor.x * cell.width)) + "px";
    textarea.style.top = String(Math.max(0, anchor.y * cell.height)) + "px";
    textarea.style.opacity = "0";
    textarea.style.width = "1px";
    textarea.style.height = String(Math.max(1, cell.height)) + "px";
    textarea.style.lineHeight = String(Math.max(1, cell.height)) + "px";
  };

  const scheduleHelperTextareaAnchorPin = () => {
    pinHelperTextareaAnchor();
    if (helperTextareaAnchorRafId !== null) {
      cancelAnimationFrame(helperTextareaAnchorRafId);
    }
    helperTextareaAnchorRafId = requestAnimationFrame(() => {
      helperTextareaAnchorRafId = null;
      pinHelperTextareaAnchor();
    });
  };

  const cancelHelperTextareaAnchorPin = () => {
    if (helperTextareaAnchorRafId !== null) {
      cancelAnimationFrame(helperTextareaAnchorRafId);
      helperTextareaAnchorRafId = null;
    }
  };

  const nowForImeInput = () => performance.now();
  const isHelperTextareaEvent = (event: Event) => Boolean(textarea) && event.target === textarea;
  const shouldRecoverNativeTextInput = (event: InputEvent) => {
    if (!isHelperTextareaEvent(event) || event.inputType !== "insertText" || !event.data) return false;
    if (/^[\t\n\v\f\r ]+$/.test(event.data)) return false;
    if (isComposingRef.current || event.isComposing) return false;
    const now = nowForImeInput();
    if (lastCompositionEndAt >= 0 && now - lastCompositionEndAt <= IME_COMPOSITION_END_SUPPRESS_WINDOW_MS) return false;
    const isMac = osPlatformRef.current === "macos"
      || (osPlatformRef.current === "unknown" && navigator.platform.toLowerCase().includes("mac"));
    if (isMac && CJK_NATIVE_PUNCTUATION_PATTERN.test(event.data)) return true;
    return lastImeProcessKeyAt >= 0 && now - lastImeProcessKeyAt <= IME_PROCESS_KEY_RECOVERY_WINDOW_MS;
  };
  const scheduleNativeTextInputRecovery = (data: string) => {
    window.setTimeout(() => {
      if (cancelled) return;
      forwardNativeInput(data);
    }, 0);
  };
  const recoverNativeTextInput = (event: InputEvent) => {
    if (!shouldRecoverNativeTextInput(event)) return;
    const data = event.data ?? "";
    const now = nowForImeInput();
    if (lastNativeTextInputData === data && now - lastNativeTextInputAt <= NATIVE_TEXT_INPUT_DEDUP_WINDOW_MS) return;
    lastNativeTextInputAt = now;
    lastNativeTextInputData = data;
    scheduleNativeTextInputRecovery(data);
  };
  const onNativeTextBeforeInput = (event: Event) => {
    recoverNativeTextInput(event as InputEvent);
  };
  const onNativeTextInput = (event: Event) => {
    recoverNativeTextInput(event as InputEvent);
  };
  const onImeProcessKeyDown = (event: KeyboardEvent) => {
    if (!isHelperTextareaEvent(event) || event.keyCode !== IME_PROCESS_KEY_CODE || event.ctrlKey || event.altKey || event.metaKey) return;
    lastImeProcessKeyAt = nowForImeInput();
  };
  const onCompositionStart = () => {
    isComposingRef.current = true;
    clearSuggestion();
    lastImeProcessKeyAt = -1;
    compositionAnchorCell = resolveCompositionAnchorCell();
    cancelHelperTextareaAnchorPin();
    captureCompositionScroll();
    scheduleCompositionScrollRestore();
    scheduleCompositionAnchorFix();
  };
  const onCompositionUpdate = () => {
    scheduleCompositionScrollRestore();
    scheduleCompositionAnchorFix();
  };
  const onCompositionEnd = () => {
    isComposingRef.current = false;
    lastCompositionEndAt = nowForImeInput();
    compositionAnchorCell = null;
    onCompositionCommitted(textarea?.value ?? "");
    scheduleCompositionScrollRestore();
    scheduleHelperTextareaAnchorPin();
    scheduleFit(true);
  };

  scheduleHelperTextareaAnchorPin();
  container.addEventListener("scroll", scheduleTerminalContainerScrollReset, { passive: true });
  const cursorDisposable = terminal.onCursorMove(() => {
    if (!isActiveRef.current) return;
    if (isComposingRef.current) {
      clearSuggestion();
      scheduleCompositionScrollRestore();
      scheduleCompositionAnchorFix();
      return;
    }
    updateSuggestionPosition();
    if (!textarea || document.activeElement !== textarea) return;
    scheduleTerminalContainerScrollReset();
    scheduleHelperTextareaAnchorPin();
  });
  const renderDisposable = terminal.onRender(() => {
    if (!isComposingRef.current) {
      updateSuggestionPosition();
      return;
    }
    clearSuggestion();
    scheduleCompositionScrollRestore();
    scheduleCompositionAnchorFix();
  });
  container.addEventListener("keydown", onImeProcessKeyDown, listenerOptions);
  container.addEventListener("beforeinput", onNativeTextBeforeInput, listenerOptions);
  container.addEventListener("input", onNativeTextInput, listenerOptions);
  textarea?.addEventListener("compositionstart", onCompositionStart);
  textarea?.addEventListener("compositionupdate", onCompositionUpdate);
  textarea?.addEventListener("compositionend", onCompositionEnd);

  return () => {
    cancelled = true;
    container.removeEventListener("keydown", onImeProcessKeyDown, listenerOptions);
    container.removeEventListener("beforeinput", onNativeTextBeforeInput, listenerOptions);
    container.removeEventListener("input", onNativeTextInput, listenerOptions);
    textarea?.removeEventListener("compositionstart", onCompositionStart);
    textarea?.removeEventListener("compositionupdate", onCompositionUpdate);
    textarea?.removeEventListener("compositionend", onCompositionEnd);
    container.removeEventListener("scroll", scheduleTerminalContainerScrollReset);
    cursorDisposable.dispose();
    renderDisposable.dispose();
    if (compositionScrollRafId !== null) cancelAnimationFrame(compositionScrollRafId);
    if (containerScrollResetRafId !== null) cancelAnimationFrame(containerScrollResetRafId);
    if (helperTextareaAnchorRafId !== null) cancelAnimationFrame(helperTextareaAnchorRafId);
    if (compositionAnchorRafId !== null) cancelAnimationFrame(compositionAnchorRafId);
    if (compositionAnchorTimeoutId !== null) window.clearTimeout(compositionAnchorTimeoutId);
  };
};
