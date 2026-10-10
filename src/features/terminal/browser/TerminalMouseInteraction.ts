import type { ITerminalOptions } from "@xterm/xterm";

export type TerminalMouseInteractionOptions = Pick<
  ITerminalOptions,
  "mouseEventsRequireAlt"
>;

/**
 * Require an explicit Alt modifier before xterm emits mouse reports.
 *
 * CLI processes can leave mouse tracking enabled after they exit. Without
 * this guard, ordinary pointer movement in another split pane is encoded as
 * `ESC [ M ...` and written into the shell's input line as visible text.
 * Alt still allows mouse-aware TUIs to receive their reports explicitly.
 */
export const createTerminalMouseInteractionOptions =
  (): TerminalMouseInteractionOptions => ({
    mouseEventsRequireAlt: true,
  });
