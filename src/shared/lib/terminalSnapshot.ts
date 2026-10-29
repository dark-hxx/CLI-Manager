import type { Terminal } from "@xterm/xterm";
import type { SerializeAddon } from "@xterm/addon-serialize";

const RESET_MOUSE_TRACKING = "\x1b[?9;1000;1002;1003l";
const RESET_MOUSE_ENCODING = "\x1b[?1006;1016l";
const TRACKING_MODES = { none: "", x10: "9", vt200: "1000", drag: "1002", any: "1003" };
const ENCODINGS = { DEFAULT: "", SGR: "\x1b[?1006h", SGR_PIXELS: "\x1b[?1016h" };

/** SerializeAddon omits mouse encoding and disabled modes; both are part of a checkpoint. */
export function serializeTerminalSnapshot(terminal: Terminal, addon: Pick<SerializeAddon, "serialize">): string {
  // xterm 6.1 exposes tracking but not encoding publicly. Keep this pinned-version
  // read-only adapter isolated; an incompatible upgrade must not publish a corrupt checkpoint.
  const core = (terminal as unknown as {
    _core?: { mouseStateService?: { activeEncoding?: string } };
  })._core;
  const encoding = core?.mouseStateService?.activeEncoding;
  if (!encoding || !Object.prototype.hasOwnProperty.call(ENCODINGS, encoding)) {
    throw new Error("terminal_snapshot_mouse_encoding_unavailable");
  }
  const encodingState = RESET_MOUSE_ENCODING + ENCODINGS[encoding as keyof typeof ENCODINGS];
  const mode = TRACKING_MODES[terminal.modes.mouseTrackingMode];
  const mouseState = RESET_MOUSE_TRACKING + encodingState + (mode ? `\x1b[?${mode}h` : "");
  // Encoding precedes the addon's tracking enable. Repeat the full state at the
  // tail so the persisted scrollback limit cannot discard it.
  return RESET_MOUSE_TRACKING + encodingState + addon.serialize() + mouseState;
}

/** Only for a known serialized snapshot, never for ordinary PTY output. */
export function restoreTerminalSnapshot(snapshot: string): string {
  let tracking = false;
  let encodingDeclared = false;
  for (const match of snapshot.matchAll(/\x1b\[\?([\d;]+)([hl])/g)) {
    const modes = match[1].split(";").map(Number);
    if (modes.some((mode) => mode === 1006 || mode === 1016)) encodingDeclared = true;
    if (modes.some((mode) => mode === 9 || mode === 1000 || mode === 1002 || mode === 1003)) {
      tracking = match[2] === "h";
    }
  }
  // Old snapshots irreversibly lost the encoding. Do not guess SGR or emit
  // legacy reports into an application expecting SGR; live mode declarations
  // re-enable normal mouse handling. New snapshots explicitly include DEFAULT too.
  return tracking && !encodingDeclared ? snapshot + RESET_MOUSE_TRACKING : snapshot;
}

/** Old daemons have no checkpoint tag: only a saved snapshot's exact bytes prove identity. */
export function restoreKnownTerminalCheckpoint(output: string, savedSnapshot?: string): string {
  if (!savedSnapshot || !output.endsWith(savedSnapshot)) return output;
  return restoreTerminalSnapshot(output);
}
