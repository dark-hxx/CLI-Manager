export interface TerminalExitCleanupOptions {
  closePty: boolean;
  closeAllPty: boolean;
  foregroundSessionIds: string[];
}

export interface TerminalExitCleanupDependencies {
  closeAll: () => Promise<void>;
  close: (sessionId: string) => Promise<void>;
  shutdownDaemonIfIdle: () => Promise<boolean>;
}

export interface TerminalExitCleanupResult {
  canExit: boolean;
  daemonStopped: boolean | null;
  closeAllError: unknown | null;
  foregroundCloseErrors: Array<{ sessionId: string; error: unknown }>;
  shutdownError: unknown | null;
}

export async function cleanupTerminalProcessesForExit(
  options: TerminalExitCleanupOptions,
  dependencies: TerminalExitCleanupDependencies,
): Promise<TerminalExitCleanupResult> {
  const result: TerminalExitCleanupResult = {
    canExit: true,
    daemonStopped: null,
    closeAllError: null,
    foregroundCloseErrors: [],
    shutdownError: null,
  };

  if (!options.closePty) return result;

  if (options.closeAllPty) {
    try {
      await dependencies.closeAll();
    } catch (error) {
      result.closeAllError = error;
    }
  } else {
    for (const sessionId of options.foregroundSessionIds) {
      try {
        await dependencies.close(sessionId);
      } catch (error) {
        result.foregroundCloseErrors.push({ sessionId, error });
      }
    }
  }

  try {
    result.daemonStopped = await dependencies.shutdownDaemonIfIdle();
  } catch (error) {
    result.canExit = false;
    result.shutdownError = error;
  }
  return result;
}
