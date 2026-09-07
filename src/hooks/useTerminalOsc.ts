import { useRef, type RefObject } from "react";
import { parseOsc7Cwd } from "../lib/terminalOscPath";
import {
  DCS_PREFIX,
  LEGACY_RUNTIME_OSC_PREFIX,
  OSC52_MAX_BASE64_CHARS,
  OSC_PREFIX,
  TMUX_DCS_PREFIX,
  findDcsTerminator,
  findOscTerminator,
  matchDcsPrefix,
  matchIntegrationOscPrefix,
  parseOsc52Body,
  parseSpecialColorQuery,
  parseStandardIntegrationCwd,
  unwrapTmuxDcsBody,
} from "../lib/terminalOscParse";
import { useTerminalStore, type ShellRuntimeEventName } from "../stores/terminalStore";
import type { OsPlatform } from "../lib/shell";

const OSC_CARRY_BUFFER_MAX = 8192;
const OSC52_CARRY_BUFFER_MAX = OSC52_MAX_BASE64_CHARS + 64;
const SSH_CONNECTED_MARKER = "\x1b]777;cli-manager-ssh=connected\x07";
const SSH_AUTH_PROMPT_PATTERN = /password|passphrase|verification code|one-time|authenticity of host|continue connecting|permission denied/i;

interface UseTerminalOscOptions {
  sessionId: string;
  osPlatformRef: RefObject<OsPlatform>;
  onOsc52Write?: (text: string) => void;
  onOsc52Query?: (selection: string) => void;
}

export interface NormalizeTerminalOutputOptions {
  applyOsc52?: boolean;
}

export interface UseTerminalOscResult {
  normalizeTerminalOutput: (text: string, options?: NormalizeTerminalOutputOptions) => string;
  updateSessionCwdIfChanged: (cwd: string | null) => void;
}

export function useTerminalOsc({
  sessionId,
  osPlatformRef,
  onOsc52Write,
  onOsc52Query,
}: UseTerminalOscOptions): UseTerminalOscResult {
  const runtimeOscBufferRef = useRef("");
  const specialOscBufferRef = useRef("");
  const dcsBufferRef = useRef("");
  const sshMarkerBufferRef = useRef("");
  const applyOsc52Ref = useRef(true);
  const onOsc52WriteRef = useRef(onOsc52Write);
  const onOsc52QueryRef = useRef(onOsc52Query);
  onOsc52WriteRef.current = onOsc52Write;
  onOsc52QueryRef.current = onOsc52Query;

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

  const emitOsc52Write = (body: string) => {
    const action = parseOsc52Body(body);
    if (!action) return false;
    if (!applyOsc52Ref.current) return true;
    if (action.kind === "write") {
      onOsc52WriteRef.current?.(action.text);
    } else if (action.kind === "query") {
      onOsc52QueryRef.current?.(action.selection);
    }
    return true;
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
      // OSC markers can bracket normal CSI/text; preserve that gap before parsing the next marker.
      output += combined.slice(cursor, start);

      const matched = matchIntegrationOscPrefix(combined, start);
      if (matched.kind === "none") {
        output += combined.slice(start, start + 2);
        cursor = start + 2;
        continue;
      }
      if (matched.kind === "partial") {
        runtimeOscBufferRef.current = combined.slice(start);
        break;
      }

      const terminator = findOscTerminator(combined, start + matched.prefix.length);
      if (terminator === null) {
        runtimeOscBufferRef.current = combined.slice(start);
        break;
      }
      if ("abortAt" in terminator) {
        output += combined.slice(start, terminator.abortAt);
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
        // Live replies are owned by the Rust PTY layer. Keep filtering here
        // for legacy replay and snapshots that may still contain queries.
      } else if (emitOsc52Write(body)) {
        // Host clipboard writes stay out of the visible stream so xterm does
        // not flash the base64 payload, including replay frames.
      } else {
        output += combined.slice(start, terminator.index + terminator.length);
      }
      cursor = terminator.index + terminator.length;
    }

    if (specialOscBufferRef.current.length > OSC52_CARRY_BUFFER_MAX) {
      output += specialOscBufferRef.current;
      specialOscBufferRef.current = "";
    }

    return output;
  };

  const processSshConnectionMarker = (text: string) => {
    let combined = sshMarkerBufferRef.current + text;
    sshMarkerBufferRef.current = "";
    let markerSeen = false;
    if (combined.includes(SSH_CONNECTED_MARKER)) {
      markerSeen = true;
      combined = combined.split(SSH_CONNECTED_MARKER).join("");
    }

    let carryLength = 0;
    const maximumCarry = Math.min(combined.length, SSH_CONNECTED_MARKER.length - 1);
    for (let length = maximumCarry; length > 0; length -= 1) {
      if (combined.endsWith(SSH_CONNECTED_MARKER.slice(0, length))) {
        carryLength = length;
        break;
      }
    }
    if (carryLength > 0) {
      sshMarkerBufferRef.current = combined.slice(-carryLength);
      combined = combined.slice(0, -carryLength);
    }

    const store = useTerminalStore.getState();
    const session = store.sessions.find((item) => item.id === sessionId);
    if (session?.environmentType === "ssh") {
      if (markerSeen) {
        store.updateSshConnectionState(sessionId, "connected");
      } else if (combined.trim()) {
        const authenticationPrompt = SSH_AUTH_PROMPT_PATTERN.test(combined);
        if (authenticationPrompt && session.connectionState !== "disconnected" && session.connectionState !== "failed") {
          store.updateSshConnectionState(sessionId, "authenticating");
        } else if (session.connectionState === "connecting" || session.connectionState === "authenticating") {
          store.updateSshConnectionState(sessionId, "connected");
        }
      }
    }
    return combined;
  };

  const processTmuxDcsPassthrough = (text: string) => {
    const combined = dcsBufferRef.current + text;
    dcsBufferRef.current = "";
    let output = "";
    let cursor = 0;

    while (cursor < combined.length) {
      const dcsStart = combined.indexOf("\x1bP", cursor);
      if (dcsStart < 0) {
        if (combined.charCodeAt(combined.length - 1) === 0x1b) {
          output += combined.slice(cursor, combined.length - 1);
          dcsBufferRef.current = "\x1b";
        } else {
          output += combined.slice(cursor);
        }
        break;
      }

      output += combined.slice(cursor, dcsStart);
      const matched = matchDcsPrefix(combined, dcsStart);
      if (matched.kind === "partial") {
        dcsBufferRef.current = combined.slice(dcsStart);
        break;
      }
      if (matched.kind === "none") {
        output += combined[dcsStart];
        cursor = dcsStart + 1;
        continue;
      }

      const bodyStart = matched.kind === "tmux"
        ? dcsStart + TMUX_DCS_PREFIX.length
        : dcsStart + DCS_PREFIX.length;
      const terminator = findDcsTerminator(combined, bodyStart, matched.kind === "tmux");
      if (terminator === null) {
        dcsBufferRef.current = combined.slice(dcsStart);
        break;
      }
      if ("abortAt" in terminator) {
        output += combined.slice(dcsStart, terminator.abortAt);
        cursor = terminator.abortAt;
        continue;
      }

      const sequenceEnd = terminator.index + terminator.length;
      if (matched.kind === "tmux") {
        output += unwrapTmuxDcsBody(combined.slice(bodyStart, terminator.index));
      } else {
        output += combined.slice(dcsStart, sequenceEnd);
      }
      cursor = sequenceEnd;
    }

    if (dcsBufferRef.current.length > OSC52_CARRY_BUFFER_MAX) {
      output += dcsBufferRef.current;
      dcsBufferRef.current = "";
    }

    return output;
  };

  const normalizeTerminalOutput = (text: string, options?: NormalizeTerminalOutputOptions) => {
    applyOsc52Ref.current = options?.applyOsc52 !== false;
    return processShellIntegrationOsc(
      processSpecialOscQueries(processTmuxDcsPassthrough(processSshConnectionMarker(text))),
    );
  };

  return {
    normalizeTerminalOutput,
    updateSessionCwdIfChanged,
  };
}
