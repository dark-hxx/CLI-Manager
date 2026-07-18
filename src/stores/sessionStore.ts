import { create } from "zustand";
import { Store } from "@tauri-apps/plugin-store";
import type { TerminalSession, PersistedSplit } from "../lib/types";
import { getCliManagerDataPaths } from "../lib/appPaths";
import { singleFlight } from "../lib/singleFlight";
import {
  migrateTerminalWorkspans,
  sanitizeTerminalWorkspans,
  type TerminalWorkspan,
} from "./terminalWorkspan";

interface SessionStore {
  sessions: TerminalSession[];
  splits: PersistedSplit[];
  activeSessionId: string | null;
  workspans: TerminalWorkspan[];
  activeWorkspanId: string | null;
  loaded: boolean;

  load: () => Promise<void>;
  saveSessions: (sessions: TerminalSession[]) => Promise<void>;
  saveSplits: (splits: PersistedSplit[]) => Promise<void>;
  saveActiveSessionId: (id: string | null) => Promise<void>;
  saveWorkspans: (workspans: TerminalWorkspan[], activeWorkspanId: string | null, sessions: TerminalSession[]) => Promise<void>;
  clear: () => Promise<void>;
}

function isPersistableSession(session: TerminalSession): boolean {
  return session.kind !== "subagent-transcript" && session.kind !== "file-editor" && session.kind !== "synced-history";
}

let store: Store | null = null;
async function getStore() {
  if (!store) {
    const paths = await getCliManagerDataPaths();
    store = await Store.load(paths.sessionsStorePath, { autoSave: 0, defaults: {} });
  }
  return store;
}

export const useSessionStore = create<SessionStore>(() => ({
  sessions: [],
  splits: [],
  activeSessionId: null,
  workspans: [],
  activeWorkspanId: null,
  loaded: false,

  load: singleFlight(async () => {
    const s = await getStore();
    const sessions = (await s.get<TerminalSession[]>("sessions")) ?? [];
    const splits = (await s.get<PersistedSplit[]>("splits")) ?? [];
    const activeSessionId = await s.get<string>("activeSessionId");
    const workspans = migrateTerminalWorkspans(await s.get<unknown>("workspans"));
    const storedActiveWorkspanId = await s.get<unknown>("activeWorkspanId");
    const activeWorkspanId = typeof storedActiveWorkspanId === "string"
      && workspans.some((workspan) => workspan.id === storedActiveWorkspanId)
      ? storedActiveWorkspanId
      : null;

    useSessionStore.setState({
      sessions,
      splits,
      activeSessionId: activeSessionId ?? null,
      workspans,
      activeWorkspanId,
      loaded: true,
    });
  }),

  saveSessions: async (sessions) => {
    const s = await getStore();
    // 伪会话（子 Agent 转录 / 文件编辑器 / 同步历史）是临时视图，绝不持久化/恢复。
    const persistable = sessions.filter(isPersistableSession);
    await s.set("sessions", persistable);
    useSessionStore.setState({ sessions: persistable });
  },

  saveSplits: async (splits) => {
    const s = await getStore();
    await s.set("splits", splits);
    useSessionStore.setState({ splits });
  },

  saveActiveSessionId: async (id) => {
    const s = await getStore();
    if (id === null) {
      await s.set("activeSessionId", null);
    } else {
      await s.set("activeSessionId", id);
    }
    useSessionStore.setState({ activeSessionId: id });
  },

  saveWorkspans: async (workspans, activeWorkspanId, sessions) => {
    const s = await getStore();
    const validSessionIds = new Set(sessions.filter(isPersistableSession).map((session) => session.id));
    const persistableWorkspans = sanitizeTerminalWorkspans(workspans, validSessionIds);
    const resolvedActiveWorkspanId = activeWorkspanId
      && persistableWorkspans.some((workspan) => workspan.id === activeWorkspanId)
      ? activeWorkspanId
      : persistableWorkspans[0]?.id ?? null;
    await s.set("workspans", persistableWorkspans);
    await s.set("activeWorkspanId", resolvedActiveWorkspanId);
    useSessionStore.setState({
      workspans: persistableWorkspans,
      activeWorkspanId: resolvedActiveWorkspanId,
    });
  },

  clear: async () => {
    const s = await getStore();
    await s.set("sessions", []);
    await s.set("splits", []);
    await s.set("activeSessionId", null);
    await s.set("workspans", []);
    await s.set("activeWorkspanId", null);
    useSessionStore.setState({
      sessions: [],
      splits: [],
      activeSessionId: null,
      workspans: [],
      activeWorkspanId: null,
    });
  },
}));
