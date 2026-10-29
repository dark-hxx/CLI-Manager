import type { Terminal } from "@xterm/xterm";

type ScrollAction = "scrollToTop" | "scrollToBottom" | "pageUp" | "pageDown";

/** Only the normal buffer owns local history navigation; TUIs own alternate keys. */
export function applyTerminalScrollShortcut(
  terminal: Terminal, combo: string, shortcuts: Record<ScrollAction, string>,
): boolean {
  if (terminal.buffer.active.type !== "normal") return false;
  for (const action of ["scrollToTop", "scrollToBottom", "pageUp", "pageDown"] as const) {
    if (!shortcuts[action].trim() || combo !== shortcuts[action]) continue;
    if (action === "scrollToTop") terminal.scrollToTop();
    else if (action === "scrollToBottom") terminal.scrollToBottom();
    else terminal.scrollPages(action === "pageUp" ? -1 : 1);
    return true;
  }
  return false;
}
