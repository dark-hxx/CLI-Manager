export type ComposerNewlineShortcut = "Shift+Enter" | "Ctrl+Enter" | "Alt+Enter";

export const ESC_CR_COMPOSER_NEWLINE = "\x1b\r";
export const LF_NEWLINE = "\n";

export interface TerminalNewlineKeyEvent {
  type: string;
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

export type TerminalNewlineKeyDecision =
  | { action: "none" }
  | { action: "write"; data: string }
  | { action: "swallow" }
  | { action: "pass" };

export const resolveTerminalNewlineKeyEvent = (
  event: TerminalNewlineKeyEvent,
  options: {
    shortcut: ComposerNewlineShortcut;
    usesEscCrComposerNewline: boolean;
  },
): TerminalNewlineKeyDecision => {
  if (event.type !== "keydown" || event.key !== "Enter" || event.metaKey) {
    return { action: "none" };
  }

  const isShiftEnter = event.shiftKey && !event.ctrlKey && !event.altKey;
  const isCtrlEnter = event.ctrlKey && !event.shiftKey && !event.altKey;
  const isAltEnter = event.altKey && !event.ctrlKey && !event.shiftKey;
  if (!isShiftEnter && !isCtrlEnter && !isAltEnter) return { action: "none" };

  const matched =
    (options.shortcut === "Shift+Enter" && isShiftEnter)
    || (options.shortcut === "Ctrl+Enter" && isCtrlEnter)
    || (options.shortcut === "Alt+Enter" && isAltEnter);
  if (matched) {
    return {
      action: "write",
      data: options.usesEscCrComposerNewline ? ESC_CR_COMPOSER_NEWLINE : LF_NEWLINE,
    };
  }

  // Grok Build owns Alt+Enter natively. Let xterm emit its ESC+CR sequence
  // when the app setting is another managed shortcut.
  if (isAltEnter && options.usesEscCrComposerNewline) return { action: "pass" };
  return { action: "swallow" };
};
