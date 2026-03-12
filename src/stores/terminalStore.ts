import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { TerminalSession } from "../lib/types";

interface TerminalStore {
  sessions: TerminalSession[];
  activeSessionId: string | null;
  createSession: (projectId?: string, cwd?: string, title?: string, startupCmd?: string, envVars?: Record<string, string>) => Promise<string>;
  closeSession: (id: string) => Promise<void>;
  setActive: (id: string) => void;
}

export const useTerminalStore = create<TerminalStore>((set, get) => ({
  sessions: [],
  activeSessionId: null,

  createSession: async (projectId, cwd, title, startupCmd, envVars) => {
    const sessionId = await invoke<string>("pty_create", {
      cwd: cwd ?? null,
      envVars: envVars ?? null,
    });
    const session: TerminalSession = {
      id: sessionId,
      projectId,
      title: title ?? "Terminal",
    };
    set({
      sessions: [...get().sessions, session],
      activeSessionId: sessionId,
    });

    // Auto-execute startup command after a brief delay for shell init
    if (startupCmd) {
      setTimeout(() => {
        invoke("pty_write", { sessionId, data: startupCmd + "\r" }).catch(console.error);
      }, 500);
    }

    return sessionId;
  },

  closeSession: async (id) => {
    await invoke("pty_close", { sessionId: id });
    const remaining = get().sessions.filter((s) => s.id !== id);
    set({
      sessions: remaining,
      activeSessionId:
        get().activeSessionId === id
          ? remaining[remaining.length - 1]?.id ?? null
          : get().activeSessionId,
    });
  },

  setActive: (id) => set({ activeSessionId: id }),
}));
