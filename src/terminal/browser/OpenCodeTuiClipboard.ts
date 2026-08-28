import type { Terminal } from "@xterm/xterm";

export interface OpenCodeTuiClipboardOptions {
  container: HTMLElement;
  terminal: Terminal;
  isActive: () => boolean;
  isVisible: () => boolean;
  hasInputFocus: () => boolean;
  isMac: () => boolean;
  readClipboardText: () => Promise<string>;
  pasteText: (text: string) => void;
  wrapMultilinePaste: (text: string) => string;
  copyText: (text: string) => Promise<void>;
  clearInputSelection: () => void;
  focusTerminal: () => void;
  logError: (message: string, error: unknown) => void;
}

const isPlainWindowsControl = (event: KeyboardEvent): boolean => (
  event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey
);

const isCtrlShiftWindowsControl = (event: KeyboardEvent): boolean => (
  event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey
);

/**
 * OpenCode's TUI enables terminal mouse/input handling. Keep its clipboard
 * shortcut path isolated from the shared xterm keyboard handler so other CLI
 * tools retain their existing Ctrl+C/Ctrl+V semantics.
 */
export function attachOpenCodeTuiClipboard({
  container,
  terminal,
  isActive,
  isVisible,
  hasInputFocus,
  isMac,
  readClipboardText,
  pasteText,
  wrapMultilinePaste,
  copyText,
  clearInputSelection,
  focusTerminal,
  logError,
}: OpenCodeTuiClipboardOptions): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    // This module implements the Windows/Linux OpenCode-specific clipboard
    // handling. On macOS the generic xterm handler should keep its original
    // Cmd/Ctrl semantics, so this OpenCode listener is inert there.
    if (!isActive() || !isVisible() || !hasInputFocus() || isMac()) return;
    const key = event.key.toLowerCase();

    if (key === "c" && isPlainWindowsControl(event) && terminal.hasSelection()) {
      const selection = terminal.getSelection();
      if (!selection) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      void copyText(selection)
        .then(() => {
          terminal.clearSelection();
          clearInputSelection();
          focusTerminal();
        })
        .catch((error) => {
          logError("Failed to copy OpenCode TUI selection", error);
        });
      return;
    }

    const isPaste = key === "v" && (isPlainWindowsControl(event) || isCtrlShiftWindowsControl(event));
    if (!isPaste) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    void readClipboardText()
      .then((text) => {
        if (!text) return;
        pasteText(isCtrlShiftWindowsControl(event) ? wrapMultilinePaste(text) : text);
        focusTerminal();
      })
      .catch((error) => {
        logError("Failed to paste into OpenCode TUI", error);
      });
  };

  container.addEventListener("keydown", onKeyDown, { capture: true });
  return () => container.removeEventListener("keydown", onKeyDown, { capture: true });
}
