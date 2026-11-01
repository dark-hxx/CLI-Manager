import { create } from "zustand";
import { Store } from "@tauri-apps/plugin-store";
import type { TerminalSession, PersistedSplit } from "../../../shared/types/index";
import { getCliManagerDataPaths } from "../../../shared/platform/appPaths";
import { singleFlight } from "../../../shared/lib/singleFlight";
import { mergeRetiredSessionBackup, partitionRetiredSessions } from "../lib/retiredSessionMigration";
import { toast } from "sonner";
import { translateCurrent } from "../../../shared/i18n/index";
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
  return session.kind === undefined || session.kind === "pty";
}

let store: Store | null = null;
let writeTail: Promise<void> = Promise.resolve();

// A late snapshot must not overwrite a completed discard; rejected writes must still release the queue.
function queueSessionWrite<T>(work: () => Promise<T>): Promise<T> {
  const operation = writeTail.then(work);
  writeTail = operation.then(() => undefined, () => undefined);
  return operation;
}
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

  load: singleFlight(() => queueSessionWrite(async () => {
    const s = await getStore();
    const original = (await s.get<TerminalSession[]>("sessions")) ?? [];
    const { sessions, retired } = partitionRetiredSessions(original);
    if (retired.length > 0) {
      const archived = (await s.get<unknown>("retiredRemoteHandoffSessions")) ?? [];
      if (!Array.isArray(archived)) throw new Error("retired_session_backup_invalid");
      // 先确认备份落盘，再排除自动恢复；任何失败都不继续启动这些会话。
      await s.set("retiredRemoteHandoffSessions", mergeRetiredSessionBackup(archived, retired));
      await s.save();
      await s.set("sessions", sessions);
      await s.save();
      toast.warning(translateCurrent("settings.remoteConnections.retiredSessions", { count: retired.length }));
    }
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
  })),

  saveSessions: (sessions) => queueSessionWrite(async () => {
    const s = await getStore();
    // 伪会话（子 Agent 转录 / 文件编辑器 / 同步历史）是临时视图，绝不持久化/恢复。
    const persistable = sessions.filter(isPersistableSession);
    await s.set("sessions", persistable);
    useSessionStore.setState({ sessions: persistable });
  }),

  saveSplits: (splits) => queueSessionWrite(async () => {
    const s = await getStore();
    await s.set("splits", splits);
    useSessionStore.setState({ splits });
  }),

  saveActiveSessionId: (id) => queueSessionWrite(async () => {
    const s = await getStore();
    if (id === null) {
      await s.set("activeSessionId", null);
    } else {
      await s.set("activeSessionId", id);
    }
    useSessionStore.setState({ activeSessionId: id });
  }),

  saveWorkspans: (workspans, activeWorkspanId, sessions) => queueSessionWrite(async () => {
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
  }),

  clear: () => queueSessionWrite(async () => {
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
  }),
}));
