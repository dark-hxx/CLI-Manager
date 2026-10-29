import type { ITerminalOptions, Terminal } from "@xterm/xterm";

export type TerminalKeyboardMode = "legacy" | "kitty" | "win32";
export type TerminalKey = {
  key: string;
  code: string;
  keyCode: number;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
};

export interface TerminalKeyboardState {
  mode: TerminalKeyboardMode;
  flags: number;
  mainFlags: number;
  altFlags: number;
  mainStack: number[];
  altStack: number[];
}

type NativeKeyEvent = TerminalKey & {
  type: "keydown" | "keyup"; location: number; repeat: boolean;
  getModifierState(key: string): boolean;
};
type NativeEncoder = {
  useKitty: boolean;
  useWin32InputMode: boolean;
  evaluateKeyDown(event: NativeKeyEvent): { key?: string };
  evaluateKeyUp(event: NativeKeyEvent): { key?: string } | undefined;
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === "object" && value !== null
);
const isFlag = (value: unknown): value is number => (
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0x7fffffff
);
const isStack = (value: unknown): value is number[] => (
  Array.isArray(value) && value.length <= 16 && value.every(isFlag)
);

// xterm 6.1 beta exposes neither Kitty state nor a public key encoder. Keep its
// pinned, runtime-checked compatibility boundary here; never maintain a second parser.
function keyboardInternals(terminal: Terminal) {
  const core: unknown = Reflect.get(terminal, "_core");
  const encoder = isRecord(core) ? core._keyboardService : undefined;
  const service = isRecord(core) ? core.coreService : undefined;
  const state = isRecord(service) ? service.kittyKeyboard : undefined;
  if (
    !isRecord(encoder) || typeof encoder.useKitty !== "boolean"
    || typeof encoder.useWin32InputMode !== "boolean"
    || typeof encoder.evaluateKeyDown !== "function" || typeof encoder.evaluateKeyUp !== "function"
    || !isRecord(state) || !isFlag(state.flags) || !isFlag(state.mainFlags) || !isFlag(state.altFlags)
    || !isStack(state.mainStack) || !isStack(state.altStack)
  ) {
    throw new Error("Unsupported xterm keyboard API");
  }
  return { encoder: encoder as NativeEncoder, state };
}

/** Advertise Kitty without forcing a process into it. Win32 remains opt-out until
 * its native-console and virtual-input paths have a separate compatibility gate. */
export function createTerminalKeyboardOptions(): Pick<ITerminalOptions, "vtExtensions"> {
  return { vtExtensions: { kittyKeyboard: true } };
}

/** Return a snapshot, not mutable references to xterm's per-screen stacks. */
export function readTerminalKeyboardState(terminal: Terminal): TerminalKeyboardState {
  const { encoder, state } = keyboardInternals(terminal);
  return {
    mode: encoder.useWin32InputMode ? "win32" : encoder.useKitty ? "kitty" : "legacy",
    flags: state.flags as number,
    mainFlags: state.mainFlags as number,
    altFlags: state.altFlags as number,
    mainStack: [...state.mainStack as number[]],
    altStack: [...state.altStack as number[]],
  };
}

/** Build an event-like value for the native evaluator, without DOM redispatch or
 * changing protocol state. Lock modifiers cannot turn a semantic newline into submit. */
export function encodeTerminalKey(
  terminal: Terminal,
  key: TerminalKey,
  phase: "keydown" | "keyup" = "keydown",
  repeat = false,
): string {
  const { encoder } = keyboardInternals(terminal);
  const event: NativeKeyEvent = {
    shiftKey: false, ctrlKey: false, altKey: false, metaKey: false,
    ...key, type: phase, location: 0, repeat,
    getModifierState: () => false,
  };
  const result = phase === "keyup" ? encoder.evaluateKeyUp(event) : encoder.evaluateKeyDown(event);
  return result?.key ?? "";
}

/** Virtual keys are a complete stroke; include a release only when negotiated. */
export function encodeTerminalKeyStroke(terminal: Terminal, key: TerminalKey): string {
  return encodeTerminalKey(terminal, key) + encodeTerminalKey(terminal, key, "keyup");
}
