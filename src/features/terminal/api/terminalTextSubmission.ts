import type { Terminal } from "@xterm/xterm";
import { translateCurrent } from "../../../shared/i18n/index";
import { terminalProcessManager } from "./TerminalProcessManager";

type SubmissionTerminal = Pick<Terminal, "paste" | "input" | "options">;

interface SubmissionTarget {
  terminal: SubmissionTerminal;
  captured: string[] | null;
}

const targets = new Map<string, SubmissionTarget>();

// Capture only synchronous programmatic onData events; ordinary keyboard input stays unchanged.
export function registerTerminalTextSubmissionTarget(sessionId: string, terminal: SubmissionTerminal) {
  const target: SubmissionTarget = { terminal, captured: null };
  targets.set(sessionId, target);
  return {
    captureInput: (data: string): boolean => {
      if (!target.captured) return false;
      target.captured.push(data);
      return true;
    },
    dispose: () => {
      // Stale cleanup must not unregister a newer attachment of the same session.
      if (targets.get(sessionId) === target) targets.delete(sessionId);
    },
  };
}

// Let xterm normalize/sanitize/frame the paste and apply its native input policies.
// Collect its onData events into one acknowledged write, with Enter outside the paste.
export async function submitTerminalText(sessionId: string, text: string): Promise<void> {
  const target = targets.get(sessionId);
  if (!target || target.terminal.options.disableStdin || target.captured) {
    throw new Error(translateCurrent("commandTemplate.toast.terminalNotReady"));
  }

  const captured: string[] = [];
  target.captured = captured;
  try {
    if (text) target.terminal.paste(text);
    target.terminal.input("\r", true);
  } finally {
    target.captured = null;
  }
  if (captured.length === 0) {
    throw new Error(translateCurrent("commandTemplate.toast.terminalNotReady"));
  }

  await terminalProcessManager.write(sessionId, captured.join(""));
}
