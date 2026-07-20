import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { getCliManagerDataPaths } from "../lib/appPaths";
import { getDb } from "../lib/db";
import { debugConsoleInfo, debugConsoleWarn } from "../lib/debugConsole";
import { translateCurrent } from "../lib/i18n";
import { logError, logWarn } from "../lib/logger";
import type { CliHookPayload, CliHookEventName } from "./terminalStore";

export type ReplayEventKind =
  | "session"
  | "prompt"
  | "tool"
  | "mcp"
  | "skill"
  | "subtask"
  | "permission"
  | "notification"
  | "snapshot"
  | "error";

export type ReplayEventStatus = "recorded" | "running" | "completed" | "failed" | "attention" | "saved" | "planned";

export interface ReplaySession {
  sessionKey: string;
  tabId: string;
  cliSessionId: string | null;
  source: string | null;
  projectPath: string | null;
  title: string;
  startedAt: string;
  updatedAt: string;
  status: ReplayEventStatus;
  eventCount: number;
}

export interface ReplayEvent {
  id: number | null;
  sessionKey: string;
  eventIndex: number;
  kind: ReplayEventKind;
  title: string;
  detail: string;
  timestamp: string;
  durationMs: number | null;
  status: ReplayEventStatus;
  tags: string[];
  payload: Record<string, unknown>;
}

export interface ReplaySnapshotFile {
  path: string;
  status: string;
  staged: boolean;
  added: number;
  deleted: number;
}

export interface ReplayWorktreeSnapshot {
  projectPath: string;
  head: string;
  branch: string | null;
  dirty: boolean;
  patch: string;
  patchBytes?: number;
  patchTruncated?: boolean;
  files: ReplaySnapshotFile[];
}

interface ReplaySessionRow {
  session_key: string;
  tab_id: string;
  cli_session_id: string | null;
  source: string | null;
  project_path: string | null;
  title: string;
  started_at: string;
  updated_at: string;
  status: ReplayEventStatus;
  event_count: number;
}

interface ReplayEventRow {
  id: number;
  session_key: string;
  event_index: number;
  kind: ReplayEventKind;
  title: string;
  detail: string | null;
  timestamp: string;
  duration_ms: number | null;
  status: ReplayEventStatus;
  tags_json: string;
  payload_json: string;
}

interface TextFilePayload {
  content: string;
  sizeBytes: number;
}

interface ReplayStore {
  sessions: ReplaySession[];
  eventsBySession: Record<string, ReplayEvent[]>;
  selectedSessionKey: string | null;
  loading: boolean;
  ready: boolean;
  error: string | null;
  ensureReady: () => Promise<void>;
  loadRecentSessions: (limit?: number, preferredSessionKey?: string | null) => Promise<void>;
  loadSession: (sessionKey: string) => Promise<void>;
  selectSession: (sessionKey: string) => Promise<void>;
  recordCliHookEvent: (payload: CliHookPayload) => Promise<void>;
  captureCodeSnapshot: (sessionKey: string, projectPath: string, reason?: string) => Promise<ReplayEvent | null>;
}

let initPromise: Promise<void> | null = null;

const OOM_PAYLOAD_WARN_BYTES = 512 * 1024;
const OOM_PATCH_WARN_BYTES = 1024 * 1024;
const OOM_REPLAY_EVENTS_WARN_COUNT = 200;
const REPLAY_EVENTS_IN_MEMORY_LIMIT = 200;
const SNAPSHOT_PATCH_DIR = "replay-snapshots";
const SNAPSHOT_PATCH_STORAGE = "file";

function stringByteLength(value: string): number {
  if (typeof Blob !== "undefined") return new Blob([value]).size;
  return value.length;
}

function getPayloadPatchBytes(payload: Record<string, unknown>): number {
  const patch = payload.patch;
  if (typeof patch === "string" && patch.length > 0) return stringByteLength(patch);
  const patchBytes = payload.patchBytes;
  return typeof patchBytes === "number" && Number.isFinite(patchBytes) ? patchBytes : 0;
}

function getEventsPatchStats(events: ReplayEvent[]): { snapshotCount: number; maxPatchBytes: number; totalPatchBytes: number } {
  let snapshotCount = 0;
  let maxPatchBytes = 0;
  let totalPatchBytes = 0;
  for (const event of events) {
    const patchBytes = getPayloadPatchBytes(event.payload);
    if (patchBytes <= 0) continue;
    snapshotCount += 1;
    totalPatchBytes += patchBytes;
    maxPatchBytes = Math.max(maxPatchBytes, patchBytes);
  }
  return { snapshotCount, maxPatchBytes, totalPatchBytes };
}

function logReplayOomDiagnostic(phase: string, fields: Record<string, unknown>, warn = false): void {
  const payload = {
    area: "aiReplay",
    phase,
    ...fields,
  };
  if (warn) {
    debugConsoleWarn("[oom-diagnostics:webview]", payload);
  } else {
    debugConsoleInfo("[oom-diagnostics:webview]", payload);
  }
}

function normalizeTimestamp(value: string | null | undefined): string {
  if (!value) return new Date().toISOString();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString();
}

function trimOptional(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function parseJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function sanitizeSnapshotPathSegment(value: unknown, fallback: string): string {
  const raw = String(value ?? "").trim() || fallback;
  const safe = raw.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+|[.-]+$/g, "");
  return (safe || fallback).slice(0, 120);
}

async function createDirIfMissing(rootPath: string, parentPath: string, name: string): Promise<void> {
  try {
    await invoke("file_create_dir", { rootPath, parentPath, name, overwrite: false });
  } catch (err) {
    if (String(err).includes("target_exists")) return;
    throw err;
  }
}

async function writeSnapshotPatchFile(sessionKey: string, checkpointId: string, patch: string): Promise<string> {
  const paths = await getCliManagerDataPaths();
  const sessionDir = sanitizeSnapshotPathSegment(sessionKey, "session");
  const fileName = `${sanitizeSnapshotPathSegment(checkpointId, "snapshot")}.patch`;
  await createDirIfMissing(paths.dataDir, "", SNAPSHOT_PATCH_DIR);
  await createDirIfMissing(paths.dataDir, SNAPSHOT_PATCH_DIR, sessionDir);
  const relativePath = `${SNAPSHOT_PATCH_DIR}/${sessionDir}/${fileName}`;
  await invoke("file_write_text", { rootPath: paths.dataDir, relativePath, content: patch });
  return relativePath;
}

async function readSnapshotPatchFile(relativePath: string): Promise<string | null> {
  const paths = await getCliManagerDataPaths();
  const result = await invoke<TextFilePayload>("file_read_text", {
    rootPath: paths.dataDir,
    relativePath,
  });
  return result.content;
}

async function hydrateSnapshotPayload(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (typeof payload.patch === "string" && payload.patch.length > 0) return payload;
  const patchPath = typeof payload.patchPath === "string" ? payload.patchPath : "";
  if (!patchPath) return payload;
  try {
    const patch = await readSnapshotPatchFile(patchPath);
    return patch ? { ...payload, patch } : payload;
  } catch (err) {
    logWarn("Failed to read AI replay snapshot patch file", { patchPath, err });
    return payload;
  }
}

function mapSession(row: ReplaySessionRow): ReplaySession {
  return {
    sessionKey: row.session_key,
    tabId: row.tab_id,
    cliSessionId: row.cli_session_id,
    source: row.source,
    projectPath: row.project_path,
    title: row.title,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    status: row.status,
    eventCount: row.event_count,
  };
}

async function mapEvent(row: ReplayEventRow): Promise<ReplayEvent> {
  const parsedPayload = parseJsonObject(row.payload_json);
  const payload = row.kind === "snapshot"
    ? await hydrateSnapshotPayload(parsedPayload)
    : parsedPayload;
  return {
    id: row.id,
    sessionKey: row.session_key,
    eventIndex: row.event_index,
    kind: row.kind,
    title: row.title,
    detail: row.detail ?? "",
    timestamp: row.timestamp,
    durationMs: row.duration_ms,
    status: row.status,
    tags: parseJsonArray(row.tags_json),
    payload,
  };
}

function buildPromptSessionTitle(message: string | null | undefined): string | null {
  const trimmed = trimOptional(message);
  if (!trimmed) return null;
  const normalized = trimmed.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  const maxLength = 72;
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
}

function buildSourceSessionTitle(source: string | null | undefined): string {
  if (source === "codex") return translateCurrent("aiReplay.source.codex");
  if (source === "claude") return translateCurrent("aiReplay.source.claude");
  return translateCurrent("aiReplay.source.default");
}

function classifyPayload(payload: CliHookPayload): Pick<ReplayEvent, "kind" | "title" | "detail" | "status" | "tags" | "durationMs"> {
  const event = payload.event;
  const source = trimOptional(payload.source) ?? "cli";
  const tags = [source, event];
  const agentType = trimOptional(payload.agentType);
  const toolUseId = trimOptional(payload.toolUseId);
  const toolName = trimOptional(payload.toolName);
  const mcpServer = trimOptional(payload.mcpServer);
  const skillName = trimOptional(payload.skillName);
  const haystack = `${payload.title ?? ""} ${payload.message ?? ""} ${agentType ?? ""} ${toolName ?? ""} ${mcpServer ?? ""} ${skillName ?? ""}`.toLowerCase();

  if (agentType) tags.push(agentType);
  if (toolUseId) tags.push("tool");
  if (toolName) tags.push(toolName);
  if (mcpServer || haystack.includes("mcp__")) tags.push("mcp");
  if (skillName || haystack.includes("skill")) tags.push("skill");
  if (mcpServer) tags.push(mcpServer);
  if (skillName) tags.push(skillName);

  const titleFromPayload = trimOptional(payload.title);
  const message = trimOptional(payload.message);
  const toolTitle = toolName ?? titleFromPayload;
  const toolDetail = mcpServer
    ? `MCP ${mcpServer}${toolName ? ` · ${toolName}` : ""}`
    : skillName
      ? `Skill ${skillName}`
      : message ?? toolName ?? "Tool event";
  const toolKind: ReplayEventKind = mcpServer ? "mcp" : skillName ? "skill" : "tool";

  const eventMap: Record<CliHookEventName, Pick<ReplayEvent, "kind" | "title" | "detail" | "status" | "durationMs">> = {
    SessionStart: {
      kind: "session",
      title: titleFromPayload ?? "SessionStart",
      detail: message ?? "CLI session bound to terminal tab",
      status: "recorded",
      durationMs: null,
    },
    UserPromptSubmit: {
      kind: "prompt",
      title: titleFromPayload ?? "UserPromptSubmit",
      detail: message ?? "User prompt submitted",
      status: "running",
      durationMs: null,
    },
    Notification: {
      kind: "notification",
      title: titleFromPayload ?? "Notification",
      detail: message ?? "CLI notification",
      status: "attention",
      durationMs: null,
    },
    Stop: {
      kind: "session",
      title: titleFromPayload ?? "Stop",
      detail: message ?? "AI response completed",
      status: "completed",
      durationMs: null,
    },
    StopFailure: {
      kind: "error",
      title: titleFromPayload ?? "StopFailure",
      detail: message ?? "AI response failed",
      status: "failed",
      durationMs: null,
    },
    PermissionRequest: {
      kind: "permission",
      title: titleFromPayload ?? "PermissionRequest",
      detail: message ?? "Permission requested",
      status: "attention",
      durationMs: null,
    },
    SubagentStart: {
      kind: "subtask",
      title: titleFromPayload ?? `${agentType ?? "Subagent"} started`,
      detail: message ?? "Subtask started",
      status: "running",
      durationMs: null,
    },
    SubagentStop: {
      kind: "subtask",
      title: titleFromPayload ?? `${agentType ?? "Subagent"} finished`,
      detail: message ?? "Subtask finished",
      status: "completed",
      durationMs: null,
    },
    AgentToolStart: {
      kind: toolKind,
      title: titleFromPayload ?? "AgentToolStart",
      detail: toolDetail,
      status: "running",
      durationMs: null,
    },
    AgentToolStop: {
      kind: toolKind,
      title: titleFromPayload ?? "AgentToolStop",
      detail: toolDetail,
      status: "completed",
      durationMs: null,
    },
    ToolStart: {
      kind: toolKind,
      title: toolTitle ?? "ToolStart",
      detail: toolDetail,
      status: "running",
      durationMs: null,
    },
    ToolStop: {
      kind: toolKind,
      title: toolTitle ?? "ToolStop",
      detail: toolDetail,
      status: "completed",
      durationMs: null,
    },
  };

  return { ...eventMap[event], tags };
}

async function ensureTables(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      const db = await getDb();
      await db.execute(`
        CREATE TABLE IF NOT EXISTS ai_replay_sessions (
          session_key TEXT PRIMARY KEY,
          tab_id TEXT NOT NULL,
          cli_session_id TEXT,
          source TEXT,
          project_path TEXT,
          title TEXT NOT NULL,
          started_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          status TEXT NOT NULL,
          event_count INTEGER NOT NULL DEFAULT 0
        )
      `);
      await db.execute(`
        CREATE TABLE IF NOT EXISTS ai_replay_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_key TEXT NOT NULL,
          event_index INTEGER NOT NULL,
          kind TEXT NOT NULL,
          title TEXT NOT NULL,
          detail TEXT,
          timestamp TEXT NOT NULL,
          duration_ms INTEGER,
          status TEXT NOT NULL,
          tags_json TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          UNIQUE(session_key, event_index)
        )
      `);
      await db.execute("CREATE INDEX IF NOT EXISTS idx_ai_replay_events_session ON ai_replay_events(session_key, event_index)");
      await db.execute("CREATE INDEX IF NOT EXISTS idx_ai_replay_sessions_updated ON ai_replay_sessions(updated_at DESC)");
    })().catch((err) => {
      initPromise = null;
      throw err;
    });
  }
  await initPromise;
}

async function fetchSession(sessionKey: string): Promise<ReplaySession | null> {
  const db = await getDb();
  const rows = await db.select<ReplaySessionRow[]>(
    "SELECT * FROM ai_replay_sessions WHERE session_key = $1 LIMIT 1",
    [sessionKey]
  );
  return rows[0] ? mapSession(rows[0]) : null;
}

async function fetchEvents(sessionKey: string): Promise<ReplayEvent[]> {
  const db = await getDb();
  const countRows = await db.select<Array<{ total: number | null }>>(
    "SELECT COUNT(*) AS total FROM ai_replay_events WHERE session_key = $1",
    [sessionKey]
  );
  const storedEvents = countRows[0]?.total ?? 0;
  const rows = await db.select<ReplayEventRow[]>(
    "SELECT * FROM ai_replay_events WHERE session_key = $1 ORDER BY event_index DESC LIMIT $2",
    [sessionKey, REPLAY_EVENTS_IN_MEMORY_LIMIT]
  );
  const events = await Promise.all(rows.reverse().map(mapEvent));
  const payloadBytes = rows.reduce((sum, row) => sum + stringByteLength(row.payload_json), 0);
  const maxPayloadBytes = rows.reduce((max, row) => Math.max(max, stringByteLength(row.payload_json)), 0);
  const patchStats = getEventsPatchStats(events);
  logReplayOomDiagnostic("fetchEvents", {
    sessionKey,
    events: events.length,
    storedEvents,
    inMemoryLimit: REPLAY_EVENTS_IN_MEMORY_LIMIT,
    payloadBytes,
    maxPayloadBytes,
    snapshotCount: patchStats.snapshotCount,
    totalPatchBytes: patchStats.totalPatchBytes,
    maxPatchBytes: patchStats.maxPatchBytes,
    thresholdExceeded: storedEvents >= OOM_REPLAY_EVENTS_WARN_COUNT ||
      maxPayloadBytes >= OOM_PAYLOAD_WARN_BYTES ||
      patchStats.maxPatchBytes >= OOM_PATCH_WARN_BYTES,
  }, storedEvents >= OOM_REPLAY_EVENTS_WARN_COUNT ||
    maxPayloadBytes >= OOM_PAYLOAD_WARN_BYTES ||
    patchStats.maxPatchBytes >= OOM_PATCH_WARN_BYTES);
  return events;
}

interface ReplayEventDraft {
  kind: ReplayEventKind;
  title: string;
  detail: string;
  timestamp: string;
  durationMs: number | null;
  status: ReplayEventStatus;
  tags: string[];
  payload: Record<string, unknown>;
  persistedPayload?: Record<string, unknown>;
}

interface ReplaySessionDraft {
  title: string;
  cliSessionId: string | null;
  source: string | null;
  projectPath: string | null;
}

const REPLAY_EVENT_INSERT_ATTEMPTS = 3;

function isUniqueEventIndexError(err: unknown): boolean {
  return String(err).includes("UNIQUE constraint failed: ai_replay_events.session_key, ai_replay_events.event_index");
}

async function persistReplayEvent(
  sessionKey: string,
  sessionDraft: ReplaySessionDraft,
  eventDraft: ReplayEventDraft
): Promise<{ session: ReplaySession; event: ReplayEvent }> {
  await ensureTables();
  const db = await getDb();
  const existing = await fetchSession(sessionKey);
  const timestamp = normalizeTimestamp(eventDraft.timestamp);
  const startedAt = existing?.startedAt ?? timestamp;
  let eventIndex = 1;
  const tagsJson = JSON.stringify(eventDraft.tags);
  const payloadJson = JSON.stringify(eventDraft.persistedPayload ?? eventDraft.payload);
  const payloadBytes = stringByteLength(payloadJson);
  const patchBytes = getPayloadPatchBytes(eventDraft.payload);

  for (let attempt = 1; attempt <= REPLAY_EVENT_INSERT_ATTEMPTS; attempt += 1) {
    const nextIndexRows = await db.select<Array<{ next_index: number | null }>>(
      "SELECT COALESCE(MAX(event_index), 0) + 1 AS next_index FROM ai_replay_events WHERE session_key = $1",
      [sessionKey]
    );
    eventIndex = nextIndexRows[0]?.next_index ?? 1;

    try {
      await db.execute(
        `INSERT INTO ai_replay_events
          (session_key, event_index, kind, title, detail, timestamp, duration_ms, status, tags_json, payload_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          sessionKey,
          eventIndex,
          eventDraft.kind,
          eventDraft.title,
          eventDraft.detail,
          timestamp,
          eventDraft.durationMs,
          eventDraft.status,
          tagsJson,
          payloadJson,
        ]
      );
      break;
    } catch (err) {
      if (!isUniqueEventIndexError(err) || attempt === REPLAY_EVENT_INSERT_ATTEMPTS) throw err;
      logWarn("AI replay event index conflict, retrying", { sessionKey, eventIndex, attempt, err });
    }
  }

  await db.execute(
    `INSERT OR REPLACE INTO ai_replay_sessions
      (session_key, tab_id, cli_session_id, source, project_path, title, started_at, updated_at, status, event_count)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      sessionKey,
      sessionKey,
      sessionDraft.cliSessionId,
      sessionDraft.source,
      sessionDraft.projectPath,
      sessionDraft.title,
      startedAt,
      timestamp,
      eventDraft.status,
      eventIndex,
    ]
  );
  logReplayOomDiagnostic("persistEvent", {
    sessionKey,
    eventIndex,
    kind: eventDraft.kind,
    status: eventDraft.status,
    payloadBytes,
    patchBytes,
    thresholdExceeded: eventIndex >= OOM_REPLAY_EVENTS_WARN_COUNT ||
      payloadBytes >= OOM_PAYLOAD_WARN_BYTES ||
      patchBytes >= OOM_PATCH_WARN_BYTES,
  }, eventIndex >= OOM_REPLAY_EVENTS_WARN_COUNT ||
    payloadBytes >= OOM_PAYLOAD_WARN_BYTES ||
    patchBytes >= OOM_PATCH_WARN_BYTES);

  return {
    session: {
      sessionKey,
      tabId: sessionKey,
      cliSessionId: sessionDraft.cliSessionId,
      source: sessionDraft.source,
      projectPath: sessionDraft.projectPath,
      title: sessionDraft.title,
      startedAt,
      updatedAt: timestamp,
      status: eventDraft.status,
      eventCount: eventIndex,
    },
    event: {
      id: null,
      sessionKey,
      eventIndex,
      kind: eventDraft.kind,
      title: eventDraft.title,
      detail: eventDraft.detail,
      timestamp,
      durationMs: eventDraft.durationMs,
      status: eventDraft.status,
      tags: eventDraft.tags,
      payload: eventDraft.payload,
    },
  };
}

function applyPersistedEvent(session: ReplaySession, event: ReplayEvent) {
  useReplayStore.setState((state) => ({
    sessions: [session, ...state.sessions.filter((item) => item.sessionKey !== session.sessionKey)].slice(0, 12),
    eventsBySession: {
      ...state.eventsBySession,
      [session.sessionKey]: [...(state.eventsBySession[session.sessionKey] ?? []), event].slice(-REPLAY_EVENTS_IN_MEMORY_LIMIT),
    },
    selectedSessionKey: state.selectedSessionKey ?? session.sessionKey,
    ready: true,
    error: null,
  }));
  const events = useReplayStore.getState().eventsBySession[session.sessionKey] ?? [];
  const patchStats = getEventsPatchStats(events);
  logReplayOomDiagnostic("applyPersistedEvent", {
    sessionKey: session.sessionKey,
    events: events.length,
    latestKind: event.kind,
    latestEventIndex: event.eventIndex,
    snapshotCount: patchStats.snapshotCount,
    totalPatchBytes: patchStats.totalPatchBytes,
    maxPatchBytes: patchStats.maxPatchBytes,
    thresholdExceeded: events.length >= OOM_REPLAY_EVENTS_WARN_COUNT ||
      patchStats.maxPatchBytes >= OOM_PATCH_WARN_BYTES,
    inMemoryLimit: REPLAY_EVENTS_IN_MEMORY_LIMIT,
  }, events.length >= OOM_REPLAY_EVENTS_WARN_COUNT || patchStats.maxPatchBytes >= OOM_PATCH_WARN_BYTES);
}

function shouldCaptureSnapshot(event: CliHookEventName): boolean {
  return event === "UserPromptSubmit" ||
    event === "ToolStop" ||
    event === "AgentToolStop" ||
    event === "SubagentStop" ||
    event === "Stop" ||
    event === "StopFailure";
}

async function getLastSnapshotPayload(sessionKey: string): Promise<Record<string, unknown> | null> {
  const db = await getDb();
  const rows = await db.select<Pick<ReplayEventRow, "payload_json">[]>(
    "SELECT payload_json FROM ai_replay_events WHERE session_key = $1 AND kind = 'snapshot' ORDER BY event_index DESC LIMIT 1",
    [sessionKey]
  );
  return rows[0]?.payload_json ? hydrateSnapshotPayload(parseJsonObject(rows[0].payload_json)) : null;
}

export const useReplayStore = create<ReplayStore>((set, get) => ({
  sessions: [],
  eventsBySession: {},
  selectedSessionKey: null,
  loading: false,
  ready: false,
  error: null,

  ensureReady: async () => {
    try {
      await ensureTables();
      set({ ready: true, error: null });
    } catch (err) {
      logError("Failed to initialize AI replay store", err);
      set({ error: String(err), ready: false });
    }
  },

  loadRecentSessions: async (limit = 12, preferredSessionKey = null) => {
    set({ loading: true });
    try {
      await ensureTables();
      const db = await getDb();
      const rows = await db.select<ReplaySessionRow[]>(
        "SELECT * FROM ai_replay_sessions ORDER BY updated_at DESC LIMIT $1",
        [limit]
      );
      const sessions = rows.map(mapSession);
      set((state) => ({
        sessions,
        selectedSessionKey: preferredSessionKey ?? state.selectedSessionKey ?? sessions[0]?.sessionKey ?? null,
        loading: false,
        ready: true,
        error: null,
      }));
    } catch (err) {
      logError("Failed to load AI replay sessions", err);
      set({ loading: false, error: String(err) });
    }
  },

  loadSession: async (sessionKey) => {
    set({ loading: true });
    try {
      await ensureTables();
      const [session, events] = await Promise.all([fetchSession(sessionKey), fetchEvents(sessionKey)]);
      const patchStats = getEventsPatchStats(events);
      logReplayOomDiagnostic("loadSession", {
        sessionKey,
        found: Boolean(session),
        events: events.length,
        snapshotCount: patchStats.snapshotCount,
        totalPatchBytes: patchStats.totalPatchBytes,
        maxPatchBytes: patchStats.maxPatchBytes,
        thresholdExceeded: events.length >= OOM_REPLAY_EVENTS_WARN_COUNT ||
          patchStats.maxPatchBytes >= OOM_PATCH_WARN_BYTES,
      }, events.length >= OOM_REPLAY_EVENTS_WARN_COUNT || patchStats.maxPatchBytes >= OOM_PATCH_WARN_BYTES);
      set((state) => ({
        sessions: session
          ? [session, ...state.sessions.filter((item) => item.sessionKey !== session.sessionKey)].slice(0, 12)
          : state.sessions,
        eventsBySession: { ...state.eventsBySession, [sessionKey]: events },
        selectedSessionKey: sessionKey,
        loading: false,
        ready: true,
        error: null,
      }));
    } catch (err) {
      logError("Failed to load AI replay session", { sessionKey, err });
      set({ loading: false, error: String(err) });
    }
  },

  selectSession: async (sessionKey) => {
    if (!get().eventsBySession[sessionKey]) {
      await get().loadSession(sessionKey);
      return;
    }
    set({ selectedSessionKey: sessionKey });
  },

  recordCliHookEvent: async (payload) => {
    const sessionKey = trimOptional(payload.tabId);
    if (!sessionKey) return;

    try {
      await ensureTables();
      const timestamp = normalizeTimestamp(payload.timestamp);
      const classified = classifyPayload(payload);
      const existing = await fetchSession(sessionKey);
      const source = trimOptional(payload.source) ?? existing?.source ?? null;
      const title = payload.event === "UserPromptSubmit"
        ? buildPromptSessionTitle(payload.message) ?? existing?.title ?? buildSourceSessionTitle(source)
        : existing?.title ?? buildSourceSessionTitle(source);
      const cliSessionId = trimOptional(payload.sessionId) ?? existing?.cliSessionId ?? null;
      const projectPath = payload.environmentType === "ssh"
        ? null
        : trimOptional(payload.cwd) ?? existing?.projectPath ?? null;
      const rawPayload = payload as unknown as Record<string, unknown>;
      const rawPayloadBytes = stringByteLength(JSON.stringify(rawPayload));
      const willCaptureSnapshot = Boolean(projectPath && shouldCaptureSnapshot(payload.event));
      logReplayOomDiagnostic("recordCliHookEvent", {
        sessionKey,
        event: payload.event,
        source,
        projectPath: Boolean(projectPath),
        payloadBytes: rawPayloadBytes,
        willCaptureSnapshot,
        thresholdExceeded: rawPayloadBytes >= OOM_PAYLOAD_WARN_BYTES,
      }, rawPayloadBytes >= OOM_PAYLOAD_WARN_BYTES);
      const { session, event } = await persistReplayEvent(
        sessionKey,
        { title, cliSessionId, source, projectPath },
        {
          kind: classified.kind,
          title: classified.title,
          detail: classified.detail,
          timestamp,
          durationMs: classified.durationMs,
          status: classified.status,
          tags: classified.tags,
          payload: rawPayload,
        }
      );
      applyPersistedEvent(session, event);

      if (projectPath && shouldCaptureSnapshot(payload.event)) {
        void get().captureCodeSnapshot(sessionKey, projectPath, payload.event);
      }
    } catch (err) {
      logError("Failed to record AI replay hook event", { payload, err });
      set({ error: String(err) });
    }
  },

  captureCodeSnapshot: async (sessionKey, projectPath, reason) => {
    const normalizedProjectPath = trimOptional(projectPath);
    if (!normalizedProjectPath) return null;
    try {
      await ensureTables();
      const startedAt = performance.now();
      const snapshot = await invoke<ReplayWorktreeSnapshot>("git_get_worktree_snapshot", {
        projectPath: normalizedProjectPath,
      });
      const elapsedMs = Math.round(performance.now() - startedAt);
      const patchBytes = snapshot.patchBytes ?? stringByteLength(snapshot.patch);
      logReplayOomDiagnostic("captureCodeSnapshot.result", {
        sessionKey,
        projectPath: normalizedProjectPath,
        reason: reason ?? "manual",
        dirty: snapshot.dirty,
        files: snapshot.files.length,
        patchBytes,
        patchTruncated: Boolean(snapshot.patchTruncated),
        elapsedMs,
        thresholdExceeded: patchBytes >= OOM_PATCH_WARN_BYTES || Boolean(snapshot.patchTruncated),
      }, patchBytes >= OOM_PATCH_WARN_BYTES || Boolean(snapshot.patchTruncated));
      if (!snapshot.dirty) return null;
      if (!snapshot.patch.trim() && !snapshot.patchTruncated) return null;

      const lastSnapshot = await getLastSnapshotPayload(sessionKey);
      if (!snapshot.patchTruncated && lastSnapshot?.patch === snapshot.patch && lastSnapshot?.head === snapshot.head) {
        logReplayOomDiagnostic("captureCodeSnapshot.skippedDuplicate", {
          sessionKey,
          projectPath: normalizedProjectPath,
          patchBytes,
        }, patchBytes >= OOM_PATCH_WARN_BYTES);
        return null;
      }

      const existing = await fetchSession(sessionKey);
      const title = existing?.title ?? `${snapshot.branch ?? "git"} replay`;
      const timestamp = new Date().toISOString();
      const detail = translateCurrent("aiReplay.snapshot.detail", {
        count: snapshot.files.length,
        branch: snapshot.branch ?? snapshot.head.slice(0, 7),
      });
      const checkpointId = `snapshot-${Date.now().toString(36)}`;
      const payload: Record<string, unknown> = {
        ...snapshot,
        patchBytes,
        checkpointId,
        reason: reason ?? "manual",
        changedFiles: snapshot.files.map((file) => file.path),
      };
      let persistedPayload = payload;
      if (snapshot.patch.trim()) {
        const patchPath = await writeSnapshotPatchFile(sessionKey, checkpointId, snapshot.patch);
        persistedPayload = {
          ...payload,
          patchPath,
          patchStorage: SNAPSHOT_PATCH_STORAGE,
        };
        delete persistedPayload.patch;
      }
      const { session, event } = await persistReplayEvent(
        sessionKey,
        {
          title,
          cliSessionId: existing?.cliSessionId ?? null,
          source: existing?.source ?? null,
          projectPath: normalizedProjectPath,
        },
        {
          kind: "snapshot",
          title: translateCurrent("aiReplay.snapshot.title"),
          detail,
          timestamp,
          durationMs: null,
          status: "saved",
          tags: ["snapshot", "git", "rollback"],
          payload,
          persistedPayload,
        }
      );
      applyPersistedEvent(session, event);
      return event;
    } catch (err) {
      logError("Failed to capture AI replay code snapshot", { sessionKey, projectPath, err });
      set({ error: String(err) });
      return null;
    }
  },
}));
