import type { Terminal } from "@xterm/xterm";
import { encodeTerminalKey, readTerminalKeyboardState, type TerminalKey } from "./terminalKeyboardProtocol";

type HeldKey = { target?: TerminalKey; legacy?: string; protocol: string; released?: boolean };

/** Candidate-confirmation Enter must never enter the semantic newline mapper. */
export function isTerminalNewlineComposition(event: KeyboardEvent, composing: boolean): boolean {
  return event.type === "keydown" && (composing || event.isComposing || event.keyCode === 229 || event.key === "Process")
    && (event.key === "Enter" || event.key === "Process" || event.keyCode === 229);
}

/** Pair consumed physical keys with their mapped press/release. A settings or
 * modifier change while held must not change the semantic key being released. */
export function createTerminalKeyRouting(
  terminal: Terminal,
  send: (data: string, userInput: boolean, kind: "native" | "legacy") => void,
) {
  const held = new Map<string, HeldKey>();
  const identity = (event: KeyboardEvent) => event.code || event.key;
  const protocol = () => {
    const state = readTerminalKeyboardState(terminal);
    return `${state.mode}:${state.flags}:${terminal.buffer.active.type}`;
  };
  const emit = (entry: HeldKey, phase: "keydown" | "keyup", repeat = false) => {
    // Never emit a stale release into a new process/mode after reset or exit.
    if (entry.protocol !== protocol()) return;
    const data = entry.target ? encodeTerminalKey(terminal, entry.target, phase, repeat)
      : phase === "keydown" ? entry.legacy ?? "" : "";
    if (data) send(data, phase === "keydown", entry.target ? "native" : "legacy");
  };
  return {
    /** Legacy policies (including Codex/Grok ESC+CR) remain explicit; enhanced
     * LF-style composers use canonical Shift+Enter, not the physical setting. */
    newline(event: KeyboardEvent, legacy: string) {
      const enhanced = readTerminalKeyboardState(terminal).mode !== "legacy";
      const entry: HeldKey = {
        protocol: protocol(),
        ...(enhanced && legacy === "\n"
          ? { target: { key: "Enter", code: "Enter", keyCode: 13, shiftKey: true } }
          : { legacy }),
      };
      held.set(identity(event), entry);
      emit(entry, "keydown", event.repeat);
    },
    wrap(handler: (event: KeyboardEvent) => boolean, imeGuard: (event: KeyboardEvent) => boolean) {
      return (event: KeyboardEvent): boolean => {
        // Composition ownership must precede even a held-key repeat/remap.
        const id = identity(event);
        if (imeGuard(event)) {
          if (event.type === "keydown" && !held.has(id)) held.set(id, { protocol: protocol() });
          return false;
        }
        let entry = held.get(id);
        if (entry?.released && event.type === "keydown") {
          // A new press replaces a blur tombstone; an old held repeat does not.
          if (event.repeat) { event.preventDefault(); return false; }
          held.delete(id); entry = undefined;
        }
        if (entry && (event.type === "keyup" || event.type === "keypress")) {
          event.preventDefault();
          if (event.type === "keyup") { held.delete(id); emit(entry, "keyup"); }
          return false;
        }
        if (entry && event.type === "keydown" && (entry.target || entry.legacy)) {
          event.preventDefault(); emit(entry, "keydown", true); return false;
        }
        // Window-capture shortcuts can consume a press before xterm sees it.
        const pass = event.defaultPrevented ? false : handler(event);
        if (!pass && event.type === "keydown" && !event.isComposing && event.keyCode !== 229
          && event.key !== "Process" && !held.has(id)) {
          held.set(id, { protocol: protocol() });
        }
        return pass;
      };
    },
    /** Blur releases active mappings. Retain only a tombstone until physical up
     * (or a fresh press), so refocus cannot leak the original chord's release. */
    release() {
      for (const [id, entry] of held) {
        if (!entry.released) emit(entry, "keyup");
        held.set(id, { protocol: entry.protocol, released: true });
      }
    },
    dispose() { held.clear(); },
  };
}
