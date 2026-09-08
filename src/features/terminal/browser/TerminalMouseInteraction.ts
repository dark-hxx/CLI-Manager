import type { ITerminalOptions } from "@xterm/xterm";

export type TerminalMouseInteractionOptions = Pick<
  ITerminalOptions,
  "mouseEventsRequireAlt"
>;

/**
 * Keep mouse-aware TUIs aligned with standard terminal behavior: the
 * application receives unmodified mouse reports and Shift keeps text
 * selection available in xterm.
 */
export const createTerminalMouseInteractionOptions =
  (): TerminalMouseInteractionOptions => ({
    mouseEventsRequireAlt: false,
  });
