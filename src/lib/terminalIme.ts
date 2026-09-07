import type { RefObject } from "react";
import type { Terminal } from "@xterm/xterm";
import type { OsPlatform } from "./shell";
import {
  resolveTerminalImeCompositionAnchor,
  type TerminalImeAnchor,
  type TerminalImeAnchorResolver,
  type TerminalImeTextareaAnchorResolver,
} from "./terminalImeAnchor";

export type {
  TerminalImeAnchor,
  TerminalImeAnchorResolver,
  TerminalImeTextareaAnchorResolver,
} from "./terminalImeAnchor";

const IME_PROCESS_KEY_CODE = 229;
const IME_PROCESS_KEY_RECOVERY_WINDOW_MS = 400;
const IME_COMPOSITION_END_SUPPRESS_WINDOW_MS = 80;
const NATIVE_TEXT_INPUT_DEDUP_WINDOW_MS = 16;
const CJK_NATIVE_PUNCTUATION_PATTERN = /^[\u3000-\u303f\uff01-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff65]+$/u;
// macOS \u4e0a\u7ecf IME \u8f93\u5165\u4e0a\u4e0b\u6587\u63d0\u4ea4\u7684 ASCII \u7b26\u53f7\u5b57\u7b26\uff08\u9700\u8981 Shift \u6216\u672c\u8eab\u5c31\u662f\u7b26\u53f7\u7684\u952e\uff09\u3002
// \u8fd9\u7c7b\u5b57\u7b26\u5728 WebKit \u4e2d\u53ef\u80fd\u4ee5\u300cinsertText \u5148\u4e8e keydown(229)\u300d\u7684\u987a\u5e8f\u5230\u8fbe\uff0c
// \u5bfc\u81f4\u65e2\u6709\u6062\u590d\u903b\u8f91\uff08\u4f9d\u8d56 keydown(229)\uff09\u65e0\u6cd5\u89e6\u53d1\u3002
const ASCII_SYMBOL_PATTERN = /^[!-/:-@[-^`{-~"']$/u;
// \u4e2d\u6587\u8f93\u5165\u6cd5\u4e0b\u7ecf IME \u63d0\u4ea4\u7684\u5168\u89d2\u6807\u70b9/\u7b26\u53f7\uff08U+2014-U+2027 \u7834\u6298\u53f7/\u7701\u7565\u53f7\uff0c
// U+2018-U+201F \u5404\u7c7b\u5f15\u53f7\uff0c\u5982 \u201c \u201d \u2018 \u2019 \u2014\u2014\u2026\uff09\u3002\u5b83\u4eec\u4e0d\u5c5e\u4e8e ASCII\uff0c
// \u4f46\u540c\u6837\u4ee5\u300cinsertText \u5148\u4e8e keydown(229)\u300d\u5230\u8fbe\uff0c\u9700\u8981\u4e0e ASCII \u7b26\u53f7\u4e00\u81f4\u5730\u89e6\u53d1\u6062\u590d\u3002
const FULLWIDTH_SYMBOL_PATTERN = /^[\u2014-\u2027\u2018-\u201f]+$/u;

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
  onImeProcessKey?: (at: number) => void;
  onCompositionStarted?: () => void;
  clearSuggestion: () => void;
  updateSuggestionPosition: () => void;
  scheduleFit: (force?: boolean) => void;
  onCompositionCommitted: (textareaValue: string) => void;
  resolveCompositionAnchor?: TerminalImeAnchorResolver;
  resolveTextareaAnchor?: TerminalImeTextareaAnchorResolver;
  shouldRefreshCompositionAnchor?: () => boolean;
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
  onImeProcessKey,
  onCompositionStarted,
  clearSuggestion,
  updateSuggestionPosition,
  scheduleFit,
  onCompositionCommitted,
  resolveCompositionAnchor,
  resolveTextareaAnchor,
  shouldRefreshCompositionAnchor,
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
  let compositionEndCleanupTimerId: number | null = null;
  let compositionScrollLock: { element: HTMLElement; scrollTop: number; scrollLeft: number }[] = [];
  let compositionAnchorCell: TerminalImeAnchor | null = null;

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
    const fallbackAnchor = resolveTerminalImeCompositionAnchor(terminal);
    return resolveCompositionAnchor?.(terminal, fallbackAnchor) ?? fallbackAnchor;
  };

  const refreshCompositionAnchorIfNeeded = () => {
    if (shouldRefreshCompositionAnchor?.()) {
      compositionAnchorCell = resolveCompositionAnchorCell();
    }
  };

  const applyCompositionAnchorFix = () => {
    if (!isComposingRef.current) return;
    const compositionView = container.querySelector(".composition-view") as HTMLElement | null;
    if (!textarea && !compositionView) return;
    const anchor = compositionAnchorCell ?? resolveCompositionAnchorCell();
    const textareaAnchor = resolveTextareaAnchor?.(terminal, anchor) ?? anchor;
    const cell = estimateCellSize();
    const left = String(Math.max(0, anchor.x * cell.width)) + "px";
    const top = String(Math.max(0, anchor.y * cell.height)) + "px";
    const textareaLeft = String(Math.max(0, textareaAnchor.x * cell.width)) + "px";
    const textareaTop = String(Math.max(0, textareaAnchor.y * cell.height)) + "px";
    const height = String(Math.max(1, cell.height)) + "px";
    const maxWidth = String(Math.max(1, terminal.cols - anchor.x) * cell.width) + "px";
    if (compositionView) {
      compositionView.style.left = left;
      compositionView.style.top = top;
      compositionView.style.height = height;
      compositionView.style.lineHeight = height;
      compositionView.style.maxWidth = maxWidth;
    }
    if (textarea) {
      const compositionBounds = compositionView?.getBoundingClientRect();
      const width = compositionBounds && compositionBounds.width > 0
        ? compositionBounds.width
        : Math.max(1, cell.width);
      textarea.style.left = textareaLeft;
      textarea.style.top = textareaTop;
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
    const textareaAnchor = resolveTextareaAnchor?.(terminal, anchor) ?? anchor;
    const cell = estimateCellSize();
    textarea.style.left = String(Math.max(0, textareaAnchor.x * cell.width)) + "px";
    textarea.style.top = String(Math.max(0, textareaAnchor.y * cell.height)) + "px";
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
    // macOS 上经 IME 输入上下文提交的 ASCII 符号（如 Shift+1 的 !、Shift+' 的 "）：
    // WebKit 可能以「insertText 先于 keydown(229)」的顺序到达，此刻 lastImeProcessKeyAt
    // 尚未设置，既有的 keydown(229) 依赖无法触发；直接对这些符号触发恢复，
    // 避免 xterm 因 _keyDownSeen 抑制而丢失该字符（否则单击打不出符号）。
    if (isMac && ASCII_SYMBOL_PATTERN.test(event.data)) return true;
    // 中文全角标点（“ ” ‘ ’ —— …）同样经 IME 提交，与 ASCII 符号一致触发恢复。
    if (isMac && FULLWIDTH_SYMBOL_PATTERN.test(event.data)) return true;
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
    pinHelperTextareaAnchor();
    const now = nowForImeInput();
    lastImeProcessKeyAt = now;
    onImeProcessKey?.(now);
  };
  const onCompositionStart = () => {
    if (compositionEndCleanupTimerId !== null) {
      window.clearTimeout(compositionEndCleanupTimerId);
      compositionEndCleanupTimerId = null;
    }
    onCompositionStarted?.();
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
    refreshCompositionAnchorIfNeeded();
    scheduleCompositionScrollRestore();
    scheduleCompositionAnchorFix();
  };
  const onCompositionEnd = () => {
    isComposingRef.current = false;
    lastCompositionEndAt = nowForImeInput();
    if (compositionEndCleanupTimerId !== null) {
      window.clearTimeout(compositionEndCleanupTimerId);
    }
    // xterm finalizes IME text from the helper textarea in its own setTimeout(0).
    // Our listener is registered after xterm's, so deferring the geometry reset
    // lets xterm read the committed candidate before we resize or re-anchor the
    // textarea. WKWebView can otherwise leave only the last raw pinyin letter.
    compositionEndCleanupTimerId = window.setTimeout(() => {
      compositionEndCleanupTimerId = null;
      if (cancelled || isComposingRef.current) return;
      compositionAnchorCell = null;
      onCompositionCommitted(textarea?.value ?? "");
      scheduleCompositionScrollRestore();
      scheduleHelperTextareaAnchorPin();
      scheduleFit(true);
    }, 0);
  };

  scheduleHelperTextareaAnchorPin();
  container.addEventListener("scroll", scheduleTerminalContainerScrollReset, { passive: true });
  const cursorDisposable = terminal.onCursorMove(() => {
    if (!isActiveRef.current) return;
    if (isComposingRef.current) {
      clearSuggestion();
      refreshCompositionAnchorIfNeeded();
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
    refreshCompositionAnchorIfNeeded();
    scheduleCompositionScrollRestore();
    scheduleCompositionAnchorFix();
  });
  const resizeDisposable = terminal.onResize(() => {
    if (!isComposingRef.current) {
      scheduleHelperTextareaAnchorPin();
      return;
    }
    compositionAnchorCell = null;
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
    resizeDisposable.dispose();
    if (compositionScrollRafId !== null) cancelAnimationFrame(compositionScrollRafId);
    if (containerScrollResetRafId !== null) cancelAnimationFrame(containerScrollResetRafId);
    if (helperTextareaAnchorRafId !== null) cancelAnimationFrame(helperTextareaAnchorRafId);
    if (compositionAnchorRafId !== null) cancelAnimationFrame(compositionAnchorRafId);
    if (compositionAnchorTimeoutId !== null) window.clearTimeout(compositionAnchorTimeoutId);
    if (compositionEndCleanupTimerId !== null) window.clearTimeout(compositionEndCleanupTimerId);
  };
};
