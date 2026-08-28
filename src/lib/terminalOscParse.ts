// Pure OSC (Operating System Command) sequence parsing for the terminal stream.
// No React or xterm runtime dependency — these operate on raw strings only.
// The stateful scanning (carry buffers) and side-effect dispatch (cwd updates,
// runtime events, color replies) stay in XTermTerminal; only the pure matchers
// and formatters live here so they can be tested in isolation.

import { decodeOscPathValue } from "./terminalOscPath";
import { normalizeHexColor } from "./terminalColor";

export const LEGACY_RUNTIME_OSC_PREFIX = "\x1b]777;cli-manager;";
export const CWD_OSC_PREFIX = "\x1b]7;";
export const INTEGRATION_OSC_PREFIXES = ["\x1b]133;", "\x1b]633;", CWD_OSC_PREFIX, LEGACY_RUNTIME_OSC_PREFIX];
export const OSC_PREFIX = "\x1b]";

export type SpecialColorQueryId = 10 | 11;

export type OscPrefixMatch =
  | { kind: "match"; prefix: string }
  | { kind: "partial" }
  | { kind: "none" };

// Terminator: BEL or ST (ESC \). null means the sequence is not yet complete
// (spans chunks, needs buffering).
export type OscTerminator = { index: number; length: number } | { abortAt: number } | null;

export function parseStandardIntegrationCwd(command: string, rest: string): string | null {
  if (command !== "P") return null;
  const field = rest.split(";").find((part) => part.toLocaleLowerCase().startsWith("cwd="));
  if (!field) return null;
  const value = decodeOscPathValue(field.slice(field.indexOf("=") + 1)).trim();
  return value || null;
}

export const matchIntegrationOscPrefix = (text: string, start: number): OscPrefixMatch => {
  let partial = false;
  for (const prefix of INTEGRATION_OSC_PREFIXES) {
    const available = Math.min(prefix.length, text.length - start);
    if (text.startsWith(prefix.slice(0, available), start)) {
      if (available === prefix.length) return { kind: "match", prefix };
      partial = true;
    }
  }
  return partial ? { kind: "partial" } : { kind: "none" };
};

export const findOscTerminator = (text: string, from: number): OscTerminator => {
  for (let i = from; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code === 0x07) return { index: i, length: 1 };
    if (code === 0x1b) {
      if (i + 1 >= text.length) return null;
      if (text[i + 1] === "\\") return { index: i, length: 2 };
      // A bare ESC should not appear inside an OSC body; treat it as an invalid
      // sequence and pass it through rather than swallowing normal output.
      return { abortAt: i };
    }
  }
  return null;
};

export const parseSpecialColorQuery = (body: string): SpecialColorQueryId | null => {
  const separator = body.indexOf(";");
  if (separator < 0) return null;
  const oscId = body.slice(0, separator);
  const payload = body.slice(separator + 1).trim();
  if (payload !== "?") return null;
  if (oscId === "10") return 10;
  if (oscId === "11") return 11;
  return null;
};

export const formatSpecialColorReply = (queryId: SpecialColorQueryId, hex: string) => {
  const normalized = normalizeHexColor(hex, queryId === 10 ? "#d8dee9" : "#0c0e10");
  const r = normalized.slice(1, 3);
  const g = normalized.slice(3, 5);
  const b = normalized.slice(5, 7);
  return `${OSC_PREFIX}${queryId};rgb:${r}${r}/${g}${g}/${b}${b}\x1b\\`;
};

export const DCS_PREFIX = "\x1bP";
export const TMUX_DCS_PREFIX = "\x1bPtmux;";
export const OSC52_MAX_BASE64_CHARS = 2_000_000;

export type Osc52Action =
  | { kind: "write"; text: string; selection: string }
  | { kind: "query"; selection: string }
  | { kind: "clear" }
  | { kind: "invalid" };

export type DcsPrefixMatch =
  | { kind: "tmux" }
  | { kind: "other" }
  | { kind: "partial" }
  | { kind: "none" };

export const matchDcsPrefix = (text: string, start: number): DcsPrefixMatch => {
  const available = text.length - start;
  if (available <= 0 || text.charCodeAt(start) !== 0x1b) return { kind: "none" };
  if (available === 1) return { kind: "partial" };
  if (text[start + 1] !== "P") return { kind: "none" };
  const tmuxAvailable = Math.min(TMUX_DCS_PREFIX.length, available);
  if (text.startsWith(TMUX_DCS_PREFIX.slice(0, tmuxAvailable), start)) {
    return tmuxAvailable === TMUX_DCS_PREFIX.length ? { kind: "tmux" } : { kind: "partial" };
  }
  return { kind: "other" };
};

export const findDcsTerminator = (text: string, from: number, skipEscapedEsc = false): OscTerminator => {
  for (let i = from; i < text.length; i += 1) {
    if (text.charCodeAt(i) !== 0x1b) continue;
    if (i + 1 >= text.length) return null;
    if (skipEscapedEsc && text[i + 1] === "\x1b") {
      i += 1;
      continue;
    }
    if (text[i + 1] === "\\") return { index: i, length: 2 };
  }
  return null;
};

export const unwrapTmuxDcsBody = (body: string): string => body.replace(/\x1b\x1b/g, "\x1b");

export const decodeOsc52Payload = (payload: string): string | null => {
  const compact = payload.replace(/\s+/g, "");
  if (!compact || compact.length > OSC52_MAX_BASE64_CHARS) return null;
  const remainder = compact.length % 4;
  if (remainder === 1 || (remainder !== 0 && compact.includes("="))) return null;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) return null;
  const normalized = remainder === 0 ? compact : `${compact}${"=".repeat(4 - remainder)}`;
  try {
    const binary = atob(normalized);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
};

export const parseOsc52Body = (body: string): Osc52Action | null => {
  if (body !== "52" && !body.startsWith("52;")) return null;
  const firstSep = body.indexOf(";");
  if (firstSep < 0) return { kind: "clear" };
  const remainder = body.slice(firstSep + 1);
  const secondSep = remainder.indexOf(";");
  const selection = secondSep < 0 ? remainder : remainder.slice(0, secondSep);
  const payload = secondSep < 0 ? "" : remainder.slice(secondSep + 1);
  if (payload === "?") return { kind: "query", selection };
  if (payload === "") return { kind: "clear" };
  const text = decodeOsc52Payload(payload);
  if (text === null) return { kind: "invalid" };
  return { kind: "write", text, selection };
};

const encodeOsc52Bytes = (bytes: Uint8Array): string => {
  const chunks: string[] = [];
  for (let start = 0; start < bytes.length; start += 0x8000) {
    chunks.push(String.fromCharCode(...bytes.subarray(start, start + 0x8000)));
  }
  return btoa(chunks.join(""));
};

export const encodeOsc52Payload = (text: string): string => encodeOsc52Bytes(new TextEncoder().encode(text));

export const formatOsc52Reply = (text: string, selection = "c"): string | null => {
  const bytes = new TextEncoder().encode(text);
  if (Math.ceil(bytes.length / 3) * 4 > OSC52_MAX_BASE64_CHARS) return null;
  return `${OSC_PREFIX}52;${selection};${encodeOsc52Bytes(bytes)}\x07`;
};
