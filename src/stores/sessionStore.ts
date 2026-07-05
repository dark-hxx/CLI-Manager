import { create } from "zustand";
import { Store } from "@tauri-apps/plugin-store";
import type { TerminalSession, PersistedSplit } from "../lib/types";
import { getCliManagerDataPaths } from "../lib/appPaths";

interface SessionStore {
  sessions: TerminalSession[];
  splits: PersistedSplit[];
  activeSessionId: string | null;
  loaded: boolean;

  load: () => Promise<void>;
  saveSessions: (sessions: TerminalSession[]) => Promise<void>;
  saveSplits: (splits: PersistedSplit[]) => Promise<void>;
  saveActiveSessionId: (id: string | null) => Promise<void>;
  clear: () => Promise<void>;
}

let store: Store | null = null;
async function getStore() {
  if (!store) {
    const paths = await getCliManagerDataPaths();
    store = await Store.load(paths.sessionsStorePath, { autoSave: 100, defaults: {} });
  }
  return store;
}

export const useSessionStore = create<SessionStore>(() => ({
  sessions: [],
  splits: [],
  activeSessionId: null,
  loaded: false,

  load: async () => {
    const s = await getStore();
    const sessions = (await s.get<TerminalSession[]>("sessions")) ?? [];
    const splits = (await s.get<PersistedSplit[]>("splits")) ?? [];
    const activeSessionId = await s.get<string>("activeSessionId");

    useSessionStore.setState({
      sessions,
      splits,
      activeSessionId: activeSessionId ?? null,
      loaded: true,
    });
  },

  saveSessions: async (sessions) => {
    const s = await getStore();
    // 伪会话（子 Agent 转录 / 文件编辑器 / 同步历史）是临时视图，绝不持久化/恢复。
    const persistable = sessions.filter(
      (session) => session.kind !== "subagent-transcript" && session.kind !== "file-editor" && session.kind !== "synced-history"
    );
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

  clear: async () => {
    const s = await getStore();
    await s.set("sessions", []);
    await s.set("splits", []);
    await s.set("activeSessionId", null);
    useSessionStore.setState({
      sessions: [],
      splits: [],
      activeSessionId: null,
    });
  },
}));
