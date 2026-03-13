import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { TerminalSession } from "../lib/types";

export type SessionStatus = "running" | "exited" | "error";

interface PtyStatusPayload {
  status: string;
  exit_code: number | null;
}

interface TerminalStore {
  sessions: TerminalSession[];
  activeSessionId: string | null;
  sessionStatuses: Record<string, SessionStatus>;
  statusListeners: Record<string, UnlistenFn>;
  createSession: (projectId?: string, cwd?: string, title?: string, startupCmd?: string, envVars?: Record<string, string>, shell?: string) => Promise<string>;
  closeSession: (id: string) => Promise<void>;
  setActive: (id: string) => void;
}

export const useTerminalStore = create<TerminalStore>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  sessionStatuses: {},
  statusListeners: {},

  createSession: async (projectId, cwd, title, startupCmd, envVars, shell) => {
    const sessionId = await invoke<string>("pty_create", {
      cwd: cwd ?? null,
      envVars: envVars ?? null,
      shell: shell ?? null,
    });
    const session: TerminalSession = {
      id: sessionId,
      projectId,
      title: title ?? "Terminal",
    };

    // Listen for status changes from Rust backend
    const unlisten = await listen<PtyStatusPayload>(`pty-status-${sessionId}`, (event) => {
      const status = event.payload.status as SessionStatus;
      set((state) => ({
        sessionStatuses: { ...state.sessionStatuses, [sessionId]: status },
      }));
    });

    set((state) => ({
      sessions: [...state.sessions, session],
      activeSessionId: sessionId,
      sessionStatuses: { ...state.sessionStatuses, [sessionId]: "running" },
      statusListeners: { ...state.statusListeners, [sessionId]: unlisten },
    }));

    // Auto-execute startup command after a brief delay for shell init
    if (startupCmd) {
      setTimeout(() => {
        invoke("pty_write", { sessionId, data: startupCmd + "\r" }).catch(console.error);
      }, 500);
    }

    return sessionId;
  },

  closeSession: async (id) => {
    // Clean up status listener
    const listener = get().statusListeners[id];
    listener?.();

    await invoke("pty_close", { sessionId: id });
    const remaining = get().sessions.filter((s) => s.id !== id);
    const { [id]: _s, ...restStatuses } = get().sessionStatuses;
    const { [id]: _l, ...restListeners } = get().statusListeners;
    set({
      sessions: remaining,
      activeSessionId:
        get().activeSessionId === id
          ? remaining[remaining.length - 1]?.id ?? null
          : get().activeSessionId,
      sessionStatuses: restStatuses,
      statusListeners: restListeners,
    });
  },

  setActive: (id) => set({ activeSessionId: id }),
}));
