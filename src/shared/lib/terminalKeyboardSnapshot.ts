import type { Terminal } from "@xterm/xterm";
import { readTerminalKeyboardState } from "./terminalKeyboardProtocol";

// Rebuild the saved stack bottom-up with standard Kitty sequences. A setter for
// only current flags would fail after an application subsequently pops a frame.
function serializeKeyboardStack(stack: number[], flags: number): string {
  const values = [...stack, flags];
  return "\x1b[<16u" + `\x1b[=${values[0]}u`
    + values.slice(1).map((value) => `\x1b[>${value}u`).join("");
}

// Recognize only our bounded, generated prefix, not arbitrary PTY protocol input.
const STACK_PREFIX = "\\x1b\\[<16u\\x1b\\[=\\d{1,10}u(?:\\x1b\\[>\\d{1,10}u){0,16}";
const KEYBOARD_PREFIX = new RegExp(
  "^\\x1b\\[\\?47l" + STACK_PREFIX + "\\x1b\\[\\?47h" + STACK_PREFIX + "\\x1b\\[\\?47l",
);

/** Tail-line persistence must retain the pre-paint screen stacks verbatim. Do not
 * move their buffer toggles to the tail: that would erase alternate-screen content. */
export function preserveTerminalKeyboardSnapshotPrefix(snapshot: string, tail: string): string {
  if (snapshot === tail) return snapshot;
  return (KEYBOARD_PREFIX.exec(snapshot)?.[0] ?? "") + tail;
}

/** Serialize after the existing write barrier. Seed both keyboard screens before
 * SerializeAddon paints normal/alternate content; never toggle buffers after it
 * paints, which would discard the restored alternate screen or move the cursor. */
export function serializeTerminalWithKeyboardState(terminal: Terminal, serialize: () => string): string {
  const state = readTerminalKeyboardState(terminal);
  // Preserve even stale saved flags: xterm swaps them on redundant buffer toggles.
  const prefix = "\x1b[?47l" + serializeKeyboardStack(state.mainStack, state.mainFlags)
    + "\x1b[?47h" + serializeKeyboardStack(state.altStack, state.altFlags) + "\x1b[?47l";
  return prefix + serialize() + `\x1b[=${state.flags}u`
    + (terminal.modes.win32InputMode ? "\x1b[?9001h" : "\x1b[?9001l");
}
