import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { getDb } from "../lib/db";
import type {
  HistorySearchHit,
  HistorySessionDetail,
  HistorySessionSummary,
  HistorySessionView,
  HistorySource,
  HistorySourceFilter,
  SessionMeta,
} from "../lib/types";

type SessionMetaMap = Record<string, SessionMeta>;

interface MetaPatchInput {
  alias?: string;
  starred?: boolean;
  tags?: string[];
}

interface HistoryStore {
  isOpen: boolean;
  loadingSessions: boolean;
  loadingSessionDetail: boolean;
  searching: boolean;
  sourceFilter: HistorySourceFilter;
  sessions: HistorySessionView[];
  activeSessionKey: string | null;
  activeSession: HistorySessionDetail | null;
  globalQuery: string;
  sessionQuery: string;
  searchHits: HistorySearchHit[];
  metaMap: SessionMetaMap;
  focusGlobalSearchSeq: number;
  focusSessionSearchSeq: number;
  ensureMetaTable: () => Promise<void>;
  openHistory: () => Promise<void>;
  closeHistory: () => void;
  toggleHistory: () => Promise<void>;
  setSourceFilter: (filter: HistorySourceFilter) => Promise<void>;
  loadSessions: () => Promise<void>;
  openSession: (sessionKey: string) => Promise<void>;
  setGlobalQuery: (query: string) => void;
  runGlobalSearch: (query: string) => Promise<void>;
  setSessionQuery: (query: string) => void;
  updateMeta: (sessionKey: string, patch: MetaPatchInput) => Promise<void>;
  triggerGlobalSearchFocus: () => void;
  triggerSessionSearchFocus: () => void;
}

const DEFAULT_SESSION_LIMIT = 500;
const DEFAULT_SEARCH_LIMIT = 120;

function asString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return String(value);
}

function asNumber(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function normalizeRole(raw: unknown): string {
  const value = asString(raw).trim().toLowerCase();
  if (!value) return "assistant";
  if (value.includes("user") || value.includes("human")) return "user";
  if (value.includes("assistant") || value.includes("model") || value.includes("llm")) {
    return "assistant";
  }
  if (value.includes("system")) return "system";
  if (value.includes("tool")) return "tool";
  return value;
}

function normalizeSummary(raw: unknown): HistorySessionSummary {
  const rec = (raw ?? {}) as Record<string, unknown>;
  return {
    session_id: asString(rec.session_id ?? rec.sessionId),
    source: asString(rec.source) as HistorySource,
    project_key: asString(rec.project_key ?? rec.projectKey),
    title: asString(rec.title),
    file_path: asString(rec.file_path ?? rec.filePath),
    created_at: asNumber(rec.created_at ?? rec.createdAt),
    updated_at: asNumber(rec.updated_at ?? rec.updatedAt),
    message_count: asNumber(rec.message_count ?? rec.messageCount),
    branch: asString(rec.branch || "") || null,
  };
}

function normalizeDetail(raw: unknown): HistorySessionDetail {
  const rec = (raw ?? {}) as Record<string, unknown>;
  const summary = normalizeSummary(rec);
  const messagesRaw = Array.isArray(rec.messages) ? rec.messages : [];
  const messages = messagesRaw.map((msg) => {
    const m = msg as Record<string, unknown>;
    return {
      role: normalizeRole(m.role),
      content: asString(m.content),
      timestamp: asString(m.timestamp ?? "") || null,
    };
  });
  return {
    ...summary,
    messages,
  };
}

function normalizeHit(raw: unknown): HistorySearchHit {
  const rec = (raw ?? {}) as Record<string, unknown>;
  return {
    session_id: asString(rec.session_id ?? rec.sessionId),
    source: asString(rec.source) as HistorySource,
    project_key: asString(rec.project_key ?? rec.projectKey),
    title: asString(rec.title),
    file_path: asString(rec.file_path ?? rec.filePath),
    role: asString(rec.role),
    snippet: asString(rec.snippet),
    timestamp: asString(rec.timestamp ?? "") || null,
  };
}

function normalizeSourceFilter(filter: HistorySourceFilter): HistorySource | null {
  if (filter === "all") return null;
  return filter;
}

function makeSessionKey(source: HistorySource, sessionId: string, filePath: string): string {
  return `${source}:${sessionId}:${filePath}`;
}

function parseTags(tagsJson: string): string[] {
  try {
    const parsed = JSON.parse(tagsJson);
    if (Array.isArray(parsed)) {
      return parsed
        .map((item) => String(item).trim())
        .filter((item) => item.length > 0);
    }
  } catch {
    // ignore malformed JSON
  }
  return [];
}

function toView(summary: HistorySessionSummary, meta?: SessionMeta): HistorySessionView {
  const alias = meta?.alias ?? "";
  const starred = meta ? meta.starred === 1 : false;
  const tags = meta ? parseTags(meta.tags_json) : [];
  const displayTitle = alias.trim() || summary.title;
  return {
    ...summary,
    sessionKey: makeSessionKey(summary.source, summary.session_id, summary.file_path),
    alias,
    starred,
    tags,
    displayTitle,
  };
}

function applyMeta(summaries: HistorySessionSummary[], metaMap: SessionMetaMap): HistorySessionView[] {
  const views = summaries.map((summary) => {
    const key = makeSessionKey(summary.source, summary.session_id, summary.file_path);
    return toView(summary, metaMap[key]);
  });
  views.sort((a, b) => {
    if (a.starred !== b.starred) {
      return a.starred ? -1 : 1;
    }
    return b.updated_at - a.updated_at;
  });
  return views;
}

async function readMetaMap(): Promise<SessionMetaMap> {
  const db = await getDb();
  const rows = await db.select<SessionMeta[]>(
    "SELECT * FROM session_meta ORDER BY updated_at DESC"
  );
  const result: SessionMetaMap = {};
  for (const row of rows) {
    result[row.session_key] = row;
  }
  return result;
}

export const useHistoryStore = create<HistoryStore>((set, get) => ({
  isOpen: false,
  loadingSessions: false,
  loadingSessionDetail: false,
  searching: false,
  sourceFilter: "all",
  sessions: [],
  activeSessionKey: null,
  activeSession: null,
  globalQuery: "",
  sessionQuery: "",
  searchHits: [],
  metaMap: {},
  focusGlobalSearchSeq: 0,
  focusSessionSearchSeq: 0,

  ensureMetaTable: async () => {
    const db = await getDb();
    await db.execute(`
      CREATE TABLE IF NOT EXISTS session_meta (
        session_key TEXT PRIMARY KEY,
        session_id  TEXT NOT NULL,
        source      TEXT NOT NULL,
        project_key TEXT NOT NULL,
        file_path   TEXT NOT NULL,
        alias       TEXT NOT NULL DEFAULT '',
        starred     INTEGER NOT NULL DEFAULT 0,
        tags_json   TEXT NOT NULL DEFAULT '[]',
        updated_at  TEXT NOT NULL
      )
    `);
    await db.execute(
      "CREATE INDEX IF NOT EXISTS idx_session_meta_source ON session_meta(source)"
    );
    await db.execute(
      "CREATE INDEX IF NOT EXISTS idx_session_meta_updated ON session_meta(updated_at DESC)"
    );
  },

  openHistory: async () => {
    set({ isOpen: true });
    if (get().sessions.length === 0) {
      await get().loadSessions();
    }
  },

  closeHistory: () => {
    set({ isOpen: false });
  },

  toggleHistory: async () => {
    if (get().isOpen) {
      get().closeHistory();
      return;
    }
    await get().openHistory();
  },

  setSourceFilter: async (filter) => {
    set({ sourceFilter: filter });
    await get().loadSessions();
    const query = get().globalQuery.trim();
    if (query) {
      await get().runGlobalSearch(query);
    } else {
      set({ searchHits: [] });
    }
  },

  loadSessions: async () => {
    set({ loadingSessions: true });
    try {
      await get().ensureMetaTable();
      const source = normalizeSourceFilter(get().sourceFilter);
      const summariesRaw = await invoke<unknown[]>("history_list_sessions", {
        source,
        query: null,
        limit: DEFAULT_SESSION_LIMIT,
      });
      const summaries = (summariesRaw ?? []).map((item) => normalizeSummary(item));
      const metaMap = await readMetaMap();
      const sessions = applyMeta(summaries, metaMap);
      const activeSessionKey = get().activeSessionKey;
      const activeExists = activeSessionKey
        ? sessions.some((item) => item.sessionKey === activeSessionKey)
        : false;
      const nextActiveKey = activeExists ? activeSessionKey : sessions[0]?.sessionKey ?? null;
      set({
        sessions,
        metaMap,
        activeSessionKey: nextActiveKey,
        activeSession: activeExists ? get().activeSession : null,
      });
      if (nextActiveKey && !activeExists) {
        await get().openSession(nextActiveKey);
      }
    } finally {
      set({ loadingSessions: false });
    }
  },

  openSession: async (sessionKey) => {
    const target = get().sessions.find((item) => item.sessionKey === sessionKey);
    if (!target) return;
    set({ activeSessionKey: sessionKey, loadingSessionDetail: true });
    try {
      const detailRaw = await invoke<unknown>("history_get_session", {
        filePath: target.file_path,
        source: target.source,
        projectKey: target.project_key,
      });
      const detail = normalizeDetail(detailRaw);
      set({ activeSession: detail });
    } finally {
      set({ loadingSessionDetail: false });
    }
  },

  setGlobalQuery: (query) => {
    set({ globalQuery: query });
  },

  runGlobalSearch: async (query) => {
    const normalized = query.trim();
    set({ globalQuery: query });
    if (!normalized) {
      set({ searchHits: [] });
      return;
    }

    set({ searching: true });
    try {
      const source = normalizeSourceFilter(get().sourceFilter);
      const hitsRaw = await invoke<unknown[]>("history_search", {
        query: normalized,
        source,
        limit: DEFAULT_SEARCH_LIMIT,
      });
      const hits = (hitsRaw ?? []).map((item) => normalizeHit(item));
      set({ searchHits: hits });
    } finally {
      set({ searching: false });
    }
  },

  setSessionQuery: (query) => {
    set({ sessionQuery: query });
  },

  updateMeta: async (sessionKey, patch) => {
    const session = get().sessions.find((item) => item.sessionKey === sessionKey);
    if (!session) return;
    const current = get().metaMap[sessionKey];
    const alias = patch.alias !== undefined ? patch.alias.trim() : current?.alias ?? "";
    const starred =
      patch.starred !== undefined ? (patch.starred ? 1 : 0) : current?.starred ?? 0;
    const tags = patch.tags !== undefined ? patch.tags : parseTags(current?.tags_json ?? "[]");
    const tagsJson = JSON.stringify(
      tags.map((item) => item.trim()).filter((item) => item.length > 0)
    );
    const updatedAt = Date.now().toString();

    const db = await getDb();
    await db.execute(
      `INSERT INTO session_meta
        (session_key, session_id, source, project_key, file_path, alias, starred, tags_json, updated_at)
       VALUES
        ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT(session_key) DO UPDATE SET
        alias = excluded.alias,
        starred = excluded.starred,
        tags_json = excluded.tags_json,
        updated_at = excluded.updated_at`,
      [
        sessionKey,
        session.session_id,
        session.source,
        session.project_key,
        session.file_path,
        alias,
        starred,
        tagsJson,
        updatedAt,
      ]
    );

    const nextMeta: SessionMeta = {
      session_key: sessionKey,
      session_id: session.session_id,
      source: session.source,
      project_key: session.project_key,
      file_path: session.file_path,
      alias,
      starred,
      tags_json: tagsJson,
      updated_at: updatedAt,
    };

    const nextMetaMap = { ...get().metaMap, [sessionKey]: nextMeta };
    const summaries: HistorySessionSummary[] = get().sessions.map((item) => ({
      session_id: item.session_id,
      source: item.source,
      project_key: item.project_key,
      title: item.title,
      file_path: item.file_path,
      created_at: item.created_at,
      updated_at: item.updated_at,
      message_count: item.message_count,
      branch: item.branch,
    }));
    const sessions = applyMeta(summaries, nextMetaMap);
    set({ metaMap: nextMetaMap, sessions });
  },

  triggerGlobalSearchFocus: () => {
    set((state) => ({ focusGlobalSearchSeq: state.focusGlobalSearchSeq + 1 }));
  },

  triggerSessionSearchFocus: () => {
    set((state) => ({ focusSessionSearchSeq: state.focusSessionSearchSeq + 1 }));
  },
}));
