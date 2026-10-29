import type { Terminal } from "@xterm/xterm";
import { encodeTerminalKeyStroke, readTerminalKeyboardState, type TerminalKey } from "../../../src/shared/lib/terminalKeyboardProtocol";
import { keyBytes, type Key, type Modifiers } from "./input";

const keys: Record<Key, TerminalKey> = {
  esc: { key: "Escape", code: "Escape", keyCode: 27 },
  backtab: { key: "Tab", code: "Tab", keyCode: 9, shiftKey: true },
  interrupt: { key: "c", code: "KeyC", keyCode: 67, ctrlKey: true },
  slash: { key: "/", code: "Slash", keyCode: 191 },
  up: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  down: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  left: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  right: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  pageup: { key: "PageUp", code: "PageUp", keyCode: 33 },
  pagedown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  tab: { key: "Tab", code: "Tab", keyCode: 9 },
  enter: { key: "Enter", code: "Enter", keyCode: 13 },
};

/** Dock keys are physical strokes, not chat submissions. Honor the negotiated
 * encoder and its release rules without changing the composer paste contract. */
export function terminalKeyBytes(terminal: Terminal, key: Key, modifiers: Modifiers): string {
  if (readTerminalKeyboardState(terminal).mode === "legacy") {
    return keyBytes(key, modifiers, terminal.modes.applicationCursorKeysMode);
  }
  return encodeTerminalKeyStroke(terminal, {
    ...keys[key], ctrlKey: keys[key].ctrlKey || modifiers.ctrl, altKey: modifiers.alt,
  });
}
