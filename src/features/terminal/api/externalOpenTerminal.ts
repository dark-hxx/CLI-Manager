import { useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { logError } from "../../../shared/platform/logger";

const IN_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

function externalTerminalTitle(path: string): string | undefined {
  const trimmed = path.trim();
  const withoutTrailingSeparators = trimmed.replace(/[\\/]+$/, "");
  if (!withoutTrailingSeparators) return undefined;
  const parts = withoutTrailingSeparators.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] || undefined;
}

interface ExternalOpenTerminalOptions {
  closeHistory: () => void;
  createSession: (projectId?: string, cwd?: string, title?: string) => Promise<string>;
  enabled?: boolean;
  setActive: (sessionId: string) => void;
}

export function useExternalOpenTerminalRequests({
  closeHistory,
  createSession,
  enabled = true,
  setActive,
}: ExternalOpenTerminalOptions): void {
  const drainingRef = useRef(false);
  const drainRequestedRef = useRef(false);

  const drain = useCallback(async () => {
    drainRequestedRef.current = true;
    if (drainingRef.current) return;
    drainingRef.current = true;
    try {
      while (drainRequestedRef.current) {
        drainRequestedRef.current = false;
        let paths: string[];
        try {
          paths = await invoke<string[]>("take_pending_open_terminal_requests");
        } catch (error) {
          logError("Failed to read pending Explorer terminal requests", error);
          return;
        }
        for (const path of paths) {
          const cwd = path.trim();
          if (!cwd) continue;
          try {
            const sessionId = await createSession(undefined, cwd, externalTerminalTitle(cwd));
            setActive(sessionId);
            closeHistory();
            await invoke("app_show_main_window").catch((error) => {
              logError("Failed to focus CLI-Manager after Explorer launch", error);
            });
          } catch (error) {
            logError("Failed to open terminal from Windows Explorer", { cwd, error });
          }
        }
      }
    } finally {
      drainingRef.current = false;
      if (drainRequestedRef.current) void drain();
    }
  }, [closeHistory, createSession, setActive]);

  useEffect(() => {
    if (!IN_TAURI || !enabled) return;
    const unlisten = listen("open-terminal-requested", () => {
      void drain();
    });
    void drain();
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, [drain, enabled]);
}
