import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { toast } from "sonner";
import type { TerminalSession } from "../lib/types";
import { logError } from "../lib/logger";
import { useSettingsStore } from "./settingsStore";
import { normalizeShellKey } from "../lib/shell";

export type SessionStatus = "running" | "exited" | "error";

export interface SplitState {
  direction: "horizontal" | "vertical";
  secondSessionId: string;
  ratio: number;
}

interface PtyStatusPayload {
  status: string;
  exit_code: number | null;
}

interface TerminalStore {
  sessions: TerminalSession[];
  activeSessionId: string | null;
  sessionStatuses: Record<string, SessionStatus>;
  statusListeners: Record<string, UnlistenFn>;
  splits: Record<string, SplitState>;
  createSession: (projectId?: string, cwd?: string, title?: string, startupCmd?: string, envVars?: Record<string, string>, shell?: string) => Promise<string>;
  closeSession: (id: string) => Promise<void>;
  setActive: (id: string) => void;
  reorderSessions: (fromId: string, toId: string) => void;
  splitTerminal: (sessionId: string, direction: "horizontal" | "vertical", cwd?: string, shell?: string) => Promise<void>;
  unsplitTerminal: (sessionId: string) => Promise<void>;
  setSplitRatio: (sessionId: string, ratio: number) => void;
}

export const useTerminalStore = create<TerminalStore>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  sessionStatuses: {},
  statusListeners: {},
  splits: {},

  createSession: async (projectId, cwd, title, startupCmd, envVars, shell) => {
    const normalizedInputShell = normalizeShellKey(shell);
    const normalizedDefaultShell = normalizeShellKey(useSettingsStore.getState().defaultShell);
    const resolvedShell =
      normalizedInputShell ?? (projectId ? null : (normalizedDefaultShell ?? null));

    let sessionId: string;
    try {
      sessionId = await invoke<string>("pty_create", {
        cwd: cwd ?? null,
        envVars: envVars ?? null,
        shell: resolvedShell,
      });
    } catch (err) {
      const description = String(err);
      toast.error("创建终端失败", { description });
      logError("pty_create invoke failed", {
        projectId: projectId ?? null,
        cwd: cwd ?? null,
        shell: resolvedShell,
        err,
      });
      throw err;
    }
    const session: TerminalSession = {
      id: sessionId,
      projectId,
      title: title ?? "Terminal",
    };

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

    if (startupCmd) {
      setTimeout(() => {
        invoke("pty_write", { sessionId, data: startupCmd + "\r" }).catch((err) => {
          toast.error("启动命令写入失败", { description: String(err) });
          logError("Failed to write startup command", { sessionId, startupCmd, err });
        });
      }, 500);
    }

    return sessionId;
  },

  closeSession: async (id) => {
    const split = get().splits[id];

    if (split) {
      get().statusListeners[split.secondSessionId]?.();
      await invoke("pty_close", { sessionId: split.secondSessionId }).catch(() => {});
    }

    get().statusListeners[id]?.();
    await invoke("pty_close", { sessionId: id });

    const remaining = get().sessions.filter((s) => s.id !== id);
    const newStatuses = { ...get().sessionStatuses };
    const newListeners = { ...get().statusListeners };
    const newSplits = { ...get().splits };

    delete newStatuses[id];
    delete newListeners[id];
    delete newSplits[id];
    if (split) {
      delete newStatuses[split.secondSessionId];
      delete newListeners[split.secondSessionId];
    }

    set({
      sessions: remaining,
      activeSessionId:
        get().activeSessionId === id
          ? remaining[remaining.length - 1]?.id ?? null
          : get().activeSessionId,
      sessionStatuses: newStatuses,
      statusListeners: newListeners,
      splits: newSplits,
    });
  },

  setActive: (id) => set({ activeSessionId: id }),

  reorderSessions: (fromId, toId) => {
    const list = [...get().sessions];
    const fromIdx = list.findIndex((s) => s.id === fromId);
    const toIdx = list.findIndex((s) => s.id === toId);
    if (fromIdx < 0 || toIdx < 0) return;
    const [moved] = list.splice(fromIdx, 1);
    list.splice(toIdx, 0, moved);
    set({ sessions: list });
  },

  splitTerminal: async (sessionId, direction, cwd, shell) => {
    if (get().splits[sessionId]) return;

    const normalizedInputShell = normalizeShellKey(shell);
    const normalizedDefaultShell = normalizeShellKey(useSettingsStore.getState().defaultShell);
    const resolvedShell = normalizedInputShell ?? (normalizedDefaultShell ?? null);

    let secondSessionId: string;
    try {
      secondSessionId = await invoke<string>("pty_create", {
        cwd: cwd ?? null,
        envVars: null,
        shell: resolvedShell,
      });
    } catch (err) {
      const description = String(err);
      toast.error("创建分屏终端失败", { description });
      logError("pty_create invoke failed for split terminal", {
        sessionId,
        cwd: cwd ?? null,
        shell: resolvedShell,
        err,
      });
      throw err;
    }

    const unlisten = await listen<PtyStatusPayload>(`pty-status-${secondSessionId}`, (event) => {
      const status = event.payload.status as SessionStatus;
      set((state) => ({
        sessionStatuses: { ...state.sessionStatuses, [secondSessionId]: status },
      }));
    });

    set((state) => ({
      splits: {
        ...state.splits,
        [sessionId]: { direction, secondSessionId, ratio: 0.5 },
      },
      sessionStatuses: { ...state.sessionStatuses, [secondSessionId]: "running" },
      statusListeners: { ...state.statusListeners, [secondSessionId]: unlisten },
    }));
  },

  unsplitTerminal: async (sessionId) => {
    const split = get().splits[sessionId];
    if (!split) return;

    get().statusListeners[split.secondSessionId]?.();
    await invoke("pty_close", { sessionId: split.secondSessionId }).catch(() => {});

    const newStatuses = { ...get().sessionStatuses };
    const newListeners = { ...get().statusListeners };
    const newSplits = { ...get().splits };
    delete newStatuses[split.secondSessionId];
    delete newListeners[split.secondSessionId];
    delete newSplits[sessionId];

    set({ sessionStatuses: newStatuses, statusListeners: newListeners, splits: newSplits });
  },

  setSplitRatio: (sessionId, ratio) => {
    const split = get().splits[sessionId];
    if (!split) return;
    set((state) => ({
      splits: {
        ...state.splits,
        [sessionId]: { ...split, ratio: Math.max(0.2, Math.min(0.8, ratio)) },
      },
    }));
  },
}));
