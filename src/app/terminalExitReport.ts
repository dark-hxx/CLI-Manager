import type { TerminalExitCleanupResult } from "../features/terminal/api/terminalExitCleanup";
import { logInfo, logWarn } from "../shared/platform/logger";

// Only confirmed cleanup can be labelled complete; false daemonStopped may mean routing remains active.
export function reportTerminalExitCleanup(result: TerminalExitCleanupResult, source: string, closePty: boolean, closeAllPty: boolean, requestedCount: number): boolean {
  if (result.closeAllError) logWarn("Failed to close all PTY sessions before exit", { source, err: result.closeAllError });
  for (const failure of result.foregroundCloseErrors) {
    logWarn("Failed to close foreground PTY session before exit", { source, sessionId: failure.sessionId, err: failure.error });
  }
  if (!result.canExit) {
    logWarn("exit: daemon shutdown failed, keeping application open", { source, err: result.shutdownError });
    return false;
  }
  if (closePty) logInfo("exit: PTY cleanup completed", {
    source, closeAllPty, requestedCount,
    failedForegroundCount: result.foregroundCloseErrors.length,
    daemonStopped: result.daemonStopped,
  });
  return true;
}
