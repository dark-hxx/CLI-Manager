import type { ITerminalOptions } from "@xterm/xterm";

export type TerminalMouseInteractionOptions = Pick<
  ITerminalOptions,
  "mouseEventsRequireAlt" | "macOptionClickForcesSelection" | "altClickMovesCursor"
>;

/**
 * Keep mouse-aware TUIs aligned with standard terminal behavior: the
 * application receives unmodified mouse reports. Local selection uses Shift
 * on Windows/Linux and Option on macOS, which xterm requires us to enable.
 * Short Option gestures must not inject click-to-caret keys into the CLI.
 */
export const createTerminalMouseInteractionOptions =
  (): TerminalMouseInteractionOptions => ({
    mouseEventsRequireAlt: false,
    macOptionClickForcesSelection: true,
    altClickMovesCursor: false,
  });
