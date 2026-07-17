import { useRef, type RefObject } from "react";
import { parseOsc7Cwd } from "../lib/terminalOscPath";
import {
  LEGACY_RUNTIME_OSC_PREFIX,
  OSC_PREFIX,
  findOscTerminator,
  formatSpecialColorReply,
  matchIntegrationOscPrefix,
  parseSpecialColorQuery,
  parseStandardIntegrationCwd,
} from "../lib/terminalOscParse";
import { useTerminalStore, type ShellRuntimeEventName } from "../stores/terminalStore";
import type { OsPlatform } from "../lib/shell";
import { terminalProcessManager } from "../terminal/core/TerminalProcessManager";

const OSC_CARRY_BUFFER_MAX = 8192;

interface TerminalColors {
  foreground: string;
  background: string;
}

interface UseTerminalOscOptions {
  sessionId: string;
  osPlatformRef: RefObject<OsPlatform>;
  onPtyWriteError: (stage: string, err: unknown) => void;
}

export interface UseTerminalOscResult {
  normalizeTerminalOutput: (text: string) => string;
  updateSessionCwdIfChanged: (cwd: string | null) => void;
  updateTerminalColorReplies: (colors: TerminalColors) => void;
}

export function useTerminalOsc({
  sessionId,
  osPlatformRef,
  onPtyWriteError,
}: UseTerminalOscOptions): UseTerminalOscResult {
  const runtimeOscBufferRef = useRef("");
  const specialOscBufferRef = useRef("");
  const terminalColorRepliesRef = useRef({
    foreground: formatSpecialColorReply(10, "#d8dee9"),
    background: formatSpecialColorReply(11, "#0c0e10"),
  });

  const emitShellRuntimeEvent = (event: ShellRuntimeEventName, exitCode: number | null) => {
    useTerminalStore.getState().handleShellRuntimeEvent({ sessionId, event, exitCode, origin: "osc" });
  };

  const updateSessionCwdIfChanged = (cwd: string | null) => {
    const value = cwd?.trim();
    if (!value) return;
    const store = useTerminalStore.getState();
    const session = store.sessions.find((item) => item.id === sessionId);
    if (!session || session.cwd === value) return;
    store.updateSessionCwd(sessionId, value);
  };

  const handleLegacyRuntimeOsc = (body: string) => {
    const fields = Object.fromEntries(body.split(";").map((part) => {
      const separator = part.indexOf("=");
      return separator < 0 ? [part, ""] : [part.slice(0, separator), part.slice(separator + 1)];
    }));
    if (fields.session !== sessionId) return;
    const eventName = fields.event;
    if (eventName !== "command_started" && eventName !== "command_finished" && eventName !== "prompt_shown") return;
    const exitCode = fields.exit !== undefined && fields.exit !== "" ? Number(fields.exit) : null;
    emitShellRuntimeEvent(eventName as ShellRuntimeEventName, Number.isFinite(exitCode) ? exitCode : null);
  };

  const handleStandardIntegrationOsc = (body: string) => {
    const osc7Cwd = parseOsc7Cwd(body, osPlatformRef.current);
    if (osc7Cwd) {
      updateSessionCwdIfChanged(osc7Cwd);
      return;
    }

    const separator = body.indexOf(";");
    const command = separator < 0 ? body : body.slice(0, separator);
    const rest = separator < 0 ? "" : body.slice(separator + 1);
    const cwd = parseStandardIntegrationCwd(command, rest);
    if (cwd) {
      updateSessionCwdIfChanged(cwd);
      return;
    }

    if (command === "A") {
      emitShellRuntimeEvent("prompt_shown", null);
    } else if (command === "C") {
      emitShellRuntimeEvent("command_started", null);
    } else if (command === "D") {
      const exitField = rest.split(";")[0] ?? "";
      const exitCode = exitField === "" ? null : Number(exitField);
      emitShellRuntimeEvent("command_finished", Number.isFinite(exitCode) ? exitCode : null);
    }
  };

  const processShellIntegrationOsc = (text: string) => {
    const combined = runtimeOscBufferRef.current + text;
    runtimeOscBufferRef.current = "";
    let output = "";
    let cursor = 0;

    while (cursor < combined.length) {
      const start = combined.indexOf("\x1b]", cursor);
      if (start < 0) {
        if (combined.charCodeAt(combined.length - 1) === 0x1b) {
          output += combined.slice(cursor, combined.length - 1);
          runtimeOscBufferRef.current = "\x1b";
        } else {
          output += combined.slice(cursor);
        }
        break;
      }

      const matched = matchIntegrationOscPrefix(combined, start);
      if (matched.kind === "none") {
        output += combined.slice(cursor, start + 2);
        cursor = start + 2;
        continue;
      }
      if (matched.kind === "partial") {
        output += combined.slice(cursor, start);
        runtimeOscBufferRef.current = combined.slice(start);
        break;
      }

      const terminator = findOscTerminator(combined, start + matched.prefix.length);
      if (terminator === null) {
        output += combined.slice(cursor, start);
        runtimeOscBufferRef.current = combined.slice(start);
        break;
      }
      if ("abortAt" in terminator) {
        output += combined.slice(cursor, terminator.abortAt);
        cursor = terminator.abortAt;
        continue;
      }

      const body = combined.slice(start + matched.prefix.length, terminator.index);
      const sequenceEnd = terminator.index + terminator.length;
      if (matched.prefix === LEGACY_RUNTIME_OSC_PREFIX) {
        handleLegacyRuntimeOsc(body);
      } else {
        handleStandardIntegrationOsc(body);
        output += combined.slice(start, sequenceEnd);
      }
      cursor = sequenceEnd;
    }

    if (runtimeOscBufferRef.current.length > OSC_CARRY_BUFFER_MAX) {
      runtimeOscBufferRef.current = "";
    }

    return output;
  };

  const processSpecialOscQueries = (text: string) => {
    const combined = specialOscBufferRef.current + text;
    specialOscBufferRef.current = "";
    let output = "";
    let cursor = 0;

    while (cursor < combined.length) {
      const start = combined.indexOf(OSC_PREFIX, cursor);
      if (start < 0) {
        if (combined.charCodeAt(combined.length - 1) === 0x1b) {
          output += combined.slice(cursor, combined.length - 1);
          specialOscBufferRef.current = "\x1b";
        } else {
          output += combined.slice(cursor);
        }
        break;
      }

      output += combined.slice(cursor, start);
      const terminator = findOscTerminator(combined, start + OSC_PREFIX.length);
      if (terminator === null) {
        specialOscBufferRef.current = combined.slice(start);
        break;
      }
      if ("abortAt" in terminator) {
        output += combined.slice(start, terminator.abortAt);
        cursor = terminator.abortAt;
        continue;
      }

      const body = combined.slice(start + OSC_PREFIX.length, terminator.index);
      const queryId = parseSpecialColorQuery(body);
      if (queryId === 10 || queryId === 11) {
        const reply =
          queryId === 10
            ? terminalColorRepliesRef.current.foreground
            : terminalColorRepliesRef.current.background;
        terminalProcessManager.write(sessionId, reply).catch((err) => onPtyWriteError("osc_color_reply", err));
      } else {
        output += combined.slice(start, terminator.index + terminator.length);
      }
      cursor = terminator.index + terminator.length;
    }

    if (specialOscBufferRef.current.length > OSC_CARRY_BUFFER_MAX) {
      specialOscBufferRef.current = "";
    }

    return output;
  };

  const normalizeTerminalOutput = (text: string) => processShellIntegrationOsc(processSpecialOscQueries(text));

  const updateTerminalColorReplies = (colors: TerminalColors) => {
    terminalColorRepliesRef.current = {
      foreground: formatSpecialColorReply(10, colors.foreground),
      background: formatSpecialColorReply(11, colors.background),
    };
  };

  return {
    normalizeTerminalOutput,
    updateSessionCwdIfChanged,
    updateTerminalColorReplies,
  };
}
