import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getDb } from "../lib/db";
import { createPerfMarker, logInfo, logWarn } from "../lib/logger";
import { normalizeHistoryProjectPaths } from "../lib/historyProjectPaths";
import { buildSshAgentHistoryContext, type SshAgentHistoryContext } from "../lib/sshAgentHistory";
import { ensureHistorySourceSettingsLoaded, getHistoryPathArgs, getHistoryPathArgsSync } from "../lib/historyPathArgs";
import { useProjectStore } from "./projectStore";
import { useSshAgentIntegrationStore } from "./sshAgentIntegrationStore";
import { useBackgroundOperationStore } from "./backgroundOperationStore";
import type {
  HistoryBackupStatus,
  HistoryEditAuditEntry,
  HistoryFileChangeOperation,
  HistoryFileChangeSummary,
  HistoryIndexStatus,
  HistoryMessage,
  HistoryPromptItem,
  HistorySearchHit,
  HistorySessionDetail,
  HistorySessionSummary,
  HistorySessionRef,
  HistorySessionView,
  HistoryStatsDailySeriesItem,
  HistoryStatsHeatmapDay,
  HistoryStatsHourlyActivityItem,
  HistoryStatsModelItem,
  HistoryStatsPayload,
  HistoryStatsProjectEfficiencyItem,
  HistoryStatsProjectItem,
  HistoryStatsSourceItem,
  HistoryTokenTrendPoint,
  HistoryToolEvent,
  HistoryToolCount,
  PromptScope,
  Project,
  HistorySource,
  HistorySourceFilter,
  SessionFavoriteSnapshot,
  SessionMeta,
  SshRemoteHistorySyncResult,
} from "../lib/types";

type SessionMetaMap = Record<string, SessionMeta>;

interface MetaPatchInput {
  alias?: string;
  starred?: boolean;
  tags?: string[];
}

interface OpenHistoryOptions {
  sourceFilter?: HistorySourceFilter;
  projectPath?: string | null;
  scopedProjectPath?: string | null;
  projectId?: string | null;
}

interface HistoryStore {
  isOpen: boolean;
  loadingSessions: boolean;
  loadingMoreSessions: boolean;
  loadingSessionDetail: boolean;
  searching: boolean;
  loadingPrompts: boolean;
  loadingStats: boolean;
  loadingStatsProjectOptions: boolean;
  statsError: string | null;
  statsProjectOptionsError: string | null;
  statsUpdatedAt: number | null;
  statsCacheKey: string | null;
  sourceFilter: HistorySourceFilter;
  projectPathFilter: string | null;
  scopedProjectPathFilter: string | null;
  sessions: HistorySessionView[];
  hasMoreSessions: boolean;
  sessionListOffset: number;
  sessionsIndexGeneration: number;
  activeSessionKey: string | null;
  activeSession: HistorySessionDetail | null;
  globalQuery: string;
  sessionQuery: string;
  searchHits: HistorySearchHit[];
  prompts: HistoryPromptItem[];
  stats: HistoryStatsPayload | null;
  statsProjectOptions: string[];
  focusedMessageIndex: number | null;
  focusedMessageSeq: number;
  metaMap: SessionMetaMap;
  focusGlobalSearchSeq: number;
  focusSessionSearchSeq: number;
  indexStatus: HistoryIndexStatus;
  remoteContext: SshAgentHistoryContext | null;
  ensureMetaTable: () => Promise<void>;
  openHistory: (options?: OpenHistoryOptions) => Promise<void>;
  closeHistory: (options?: { preserveRemoteConsumer?: boolean }) => void;
  toggleHistory: () => Promise<void>;
  setSourceFilter: (filter: HistorySourceFilter) => Promise<void>;
  setProjectPathFilter: (projectPath: string | null) => Promise<void>;
  loadSessions: () => Promise<void>;
  loadMoreSessions: () => Promise<void>;
  loadIndexStatus: () => Promise<void>;
  refreshIndex: () => Promise<void>;
  addConvertedSession: (summary: unknown) => string;
  openSession: (sessionKey: string) => Promise<void>;
  openSearchHit: (hit: HistorySearchHit) => Promise<void>;
  deleteSession: (sessionKey: string) => Promise<void>;
  setGlobalQuery: (query: string) => void;
  runGlobalSearch: (query: string) => Promise<void>;
  setSessionQuery: (query: string) => void;
  loadPrompts: (options: {
    scope: PromptScope;
    query?: string;
    projectKey?: string | null;
    sessionKey?: string | null;
    limit?: number;
  }) => Promise<void>;
  loadStatsProjectOptions: (options?: { force?: boolean }) => Promise<string[]>;
  loadStats: (options?: {
    projectKey?: string | null;
    projectPath?: string | null;
    rangeDays?: number;
    startAt?: number | null;
    endAt?: number | null;
    force?: boolean;
  }) => Promise<void>;
  openSessionAtMessage: (sessionKey: string, messageIndex: number) => Promise<void>;
  clearFocusedMessage: () => void;
  updateMeta: (sessionKey: string, patch: MetaPatchInput) => Promise<void>;
  updateMessage: (sessionKey: string, message: HistoryMessage, newText: string) => Promise<void>;
  deleteMessage: (sessionKey: string, message: HistoryMessage) => Promise<void>;
  deleteMessages: (sessionKey: string, messages: HistoryMessage[]) => Promise<void>;
  insertMessage: (
    sessionKey: string,
    afterMessage: HistoryMessage,
    role: "user" | "assistant",
    text: string
  ) => Promise<void>;
  /** 审计撤回"删除"用：按原行号提示就近恢复一条消息（行号漂移由后端锚点扫描兜底）。 */
  reinsertMessage: (sessionKey: string, lineIndexHint: number, role: string, text: string) => Promise<void>;
  restoreSessionBackup: (sessionKey: string) => Promise<void>;
  fetchBackupStatus: (sessionKey: string) => Promise<HistoryBackupStatus>;
  listEditAudit: (sessionKey: string, limit?: number) => Promise<HistoryEditAuditEntry[]>;
  triggerGlobalSearchFocus: () => void;
  triggerSessionSearchFocus: () => void;
}

const SESSION_PAGE_SIZE = 20;
const SESSION_PAGE_FETCH_LIMIT = SESSION_PAGE_SIZE + 1;
const DEFAULT_SEARCH_LIMIT = 120;
const MIN_GLOBAL_SEARCH_CHARS = 3;
const DEFAULT_HISTORY_INDEX_STATUS: HistoryIndexStatus = {
  rootsKey: "",
  phase: "idle",
  indexedFiles: 0,
  totalFiles: 0,
  generation: 0,
  partial: true,
  lastCompletedAt: null,
  error: null,
};
const STATS_CACHE_TTL_MS = 5 * 60 * 1000;
const STATS_CACHE_MAX = 16;
const STATS_PROJECT_OPTIONS_CACHE_MAX = 8;
interface StatsCacheEntry {
  payload: HistoryStatsPayload;
  cachedAt: number;
}

interface StatsProjectOptionsCacheEntry {
  options: string[];
  cachedAt: number;
}

function effectiveProjectPathFilter(state: Pick<HistoryStore, "projectPathFilter" | "scopedProjectPathFilter">): string | null {
  return state.scopedProjectPathFilter ?? state.projectPathFilter;
}

function remoteSourceMatchesFilter(
  context: SshAgentHistoryContext,
  filter: HistorySourceFilter,
): boolean {
  return filter === "all" || filter === context.source;
}

const statsCache = new Map<string, StatsCacheEntry>();
const statsProjectOptionsCache = new Map<string, StatsProjectOptionsCacheEntry>();
let statsRequestSeq = 0;
let historyMetaReady = false;
let historyMetaInitPromise: Promise<void> | null = null;

function statsCacheGet(key: string): StatsCacheEntry | undefined {
  const entry = statsCache.get(key);
  if (entry) {
    // Refresh LRU recency
    statsCache.delete(key);
    statsCache.set(key, entry);
  }
  return entry;
}

function statsCacheSet(key: string, entry: StatsCacheEntry): void {
  if (statsCache.has(key)) {
    statsCache.delete(key);
  } else if (statsCache.size >= STATS_CACHE_MAX) {
    const oldestKey = statsCache.keys().next().value;
    if (oldestKey !== undefined) statsCache.delete(oldestKey);
  }
  statsCache.set(key, entry);
}

function statsProjectOptionsCacheGet(key: string): StatsProjectOptionsCacheEntry | undefined {
  const entry = statsProjectOptionsCache.get(key);
  if (entry) {
    statsProjectOptionsCache.delete(key);
    statsProjectOptionsCache.set(key, entry);
  }
  return entry;
}

function statsProjectOptionsCacheSet(key: string, entry: StatsProjectOptionsCacheEntry): void {
  if (statsProjectOptionsCache.has(key)) {
    statsProjectOptionsCache.delete(key);
  } else if (statsProjectOptionsCache.size >= STATS_PROJECT_OPTIONS_CACHE_MAX) {
    const oldestKey = statsProjectOptionsCache.keys().next().value;
    if (oldestKey !== undefined) statsProjectOptionsCache.delete(oldestKey);
  }
  statsProjectOptionsCache.set(key, entry);
}

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

function normalizeSessionRef(raw: unknown): HistorySessionRef | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  const sourceId = asString(rec.sourceId ?? rec.source_id) as HistorySource;
  const sourceInstanceId = asString(rec.sourceInstanceId ?? rec.source_instance_id);
  const sourceSessionId = asString(rec.sourceSessionId ?? rec.source_session_id);
  const transportKind = asString(rec.transportKind ?? rec.transport_kind);
  if (!sourceId || !sourceInstanceId || !sourceSessionId || !transportKind) return null;
  const pointersRaw = rec.rawPointers ?? rec.raw_pointers;
  const rawPointers = Array.isArray(pointersRaw) ? pointersRaw : [];
  return {
    sourceId,
    sourceInstanceId,
    sourceSessionId,
    transportKind,
    rawPointers: rawPointers.map((item) => {
      const pointer = (item ?? {}) as Record<string, unknown>;
      return {
        role: asString(pointer.role),
        kind: asString(pointer.kind),
        rawKey: asString(pointer.rawKey ?? pointer.raw_key),
        lineIndex: pointer.lineIndex == null && pointer.line_index == null
          ? null
          : asNumber(pointer.lineIndex ?? pointer.line_index),
      };
    }).filter((pointer) => pointer.rawKey.length > 0),
  };
}

function normalizeSummary(raw: unknown): HistorySessionSummary {
  const rec = (raw ?? {}) as Record<string, unknown>;
  const remoteIdentityRaw = rec.remote_identity ?? rec.remoteIdentity;
  return {
    session_id: asString(rec.session_id ?? rec.sessionId),
    source: asString(rec.source) as HistorySource,
    project_key: asString(rec.project_key ?? rec.projectKey),
    title: asString(rec.title),
    file_path: asString(rec.file_path ?? rec.filePath),
    cwd: asString(rec.cwd ?? "") || null,
    created_at: asNumber(rec.created_at ?? rec.createdAt),
    updated_at: asNumber(rec.updated_at ?? rec.updatedAt),
    message_count: asNumber(rec.message_count ?? rec.messageCount),
    branch: asString(rec.branch || "") || null,
    session_ref: normalizeSessionRef(rec.session_ref ?? rec.sessionRef),
    materialization_level: asString(rec.materialization_level ?? rec.materializationLevel) || undefined,
    freshness_state: asString(rec.freshness_state ?? rec.freshnessState) || undefined,
    as_of: rec.as_of == null && rec.asOf == null ? null : asNumber(rec.as_of ?? rec.asOf),
    remote_identity: remoteIdentityRaw && typeof remoteIdentityRaw === "object"
      ? remoteIdentityRaw as HistorySessionSummary["remote_identity"]
      : null,
    read_only: rec.read_only === true || rec.readOnly === true,
    usage: normalizeSessionUsage(rec.usage),
  };
}

function normalizeDetail(raw: unknown): HistorySessionDetail {
  const rec = (raw ?? {}) as Record<string, unknown>;
  const summary = normalizeSummary(rec);
  const messagesRaw = Array.isArray(rec.messages) ? rec.messages : [];
  const messages = messagesRaw.map((msg) => {
    const m = msg as Record<string, unknown>;
    const rawLineIndex = m.line_index ?? m.lineIndex;
    const rawEditableText = m.editable_text ?? m.editableText;
    return {
      role: normalizeRole(m.role),
      content: asString(m.content),
      timestamp: asString(m.timestamp ?? "") || null,
      model: asString(m.model ?? "") || undefined,
      input_tokens: asNumber(m.input_tokens ?? m.inputTokens),
      output_tokens: asNumber(m.output_tokens ?? m.outputTokens),
      cache_creation_tokens: asNumber(m.cache_creation_tokens ?? m.cacheCreationTokens),
      cache_read_tokens: asNumber(m.cache_read_tokens ?? m.cacheReadTokens),
      // 行号 0 合法，不能走 asNumber 的 0 兜底；缺失/非法一律 null（禁编辑）。
      line_index:
        typeof rawLineIndex === "number" && Number.isFinite(rawLineIndex) && rawLineIndex >= 0
          ? rawLineIndex
          : null,
      editable: m.editable === true,
      editable_text: typeof rawEditableText === "string" ? rawEditableText : null,
    };
  });
  return {
    ...summary,
    cwd: asString(rec.cwd ?? "") || null,
    usage: normalizeSessionUsage(rec.usage),
    tool_events: normalizeToolEvents(rec.tool_events ?? rec.toolEvents),
    file_changes: normalizeFileChanges(rec.file_changes ?? rec.fileChanges),
    messages,
  };
}

function normalizeSessionUsage(raw: unknown): HistorySessionDetail["usage"] {
  if (!raw || typeof raw !== "object") return undefined;
  const rec = raw as Record<string, unknown>;
  return {
    input_tokens: asNumber(rec.input_tokens ?? rec.inputTokens),
    output_tokens: asNumber(rec.output_tokens ?? rec.outputTokens),
    cache_read_tokens: asNumber(rec.cache_read_tokens ?? rec.cacheReadTokens),
    cache_creation_tokens: asNumber(rec.cache_creation_tokens ?? rec.cacheCreationTokens),
    total_cost_usd: asNumber(rec.total_cost_usd ?? rec.totalCostUsd),
    dominant_model: asString(rec.dominant_model ?? rec.dominantModel ?? "") || null,
    current_model: asString(rec.current_model ?? rec.currentModel ?? "") || null,
    context_window: asNumber(rec.context_window ?? rec.contextWindow) || null,
    last_context_tokens: asNumber(rec.last_context_tokens ?? rec.lastContextTokens) || null,
    reasoning_effort: asString(rec.reasoning_effort ?? rec.reasoningEffort ?? "") || null,
    token_trend: normalizeTokenTrend(rec.token_trend ?? rec.tokenTrend),
    tool_call_count: asNumber(rec.tool_call_count ?? rec.toolCallCount),
    mcp_calls: normalizeToolCounts(rec.mcp_calls ?? rec.mcpCalls),
    skill_calls: normalizeToolCounts(rec.skill_calls ?? rec.skillCalls),
    builtin_calls: normalizeToolCounts(rec.builtin_calls ?? rec.builtinCalls),
  };
}

function normalizeTokenTrend(raw: unknown): HistoryTokenTrendPoint[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      const rec = (item ?? {}) as Record<string, unknown>;
      const input = asNumber(rec.input_tokens ?? rec.inputTokens);
      const output = asNumber(rec.output_tokens ?? rec.outputTokens);
      const cacheRead = asNumber(rec.cache_read_tokens ?? rec.cacheReadTokens);
      const cacheCreation = asNumber(rec.cache_creation_tokens ?? rec.cacheCreationTokens);
      const total = asNumber(rec.total_tokens ?? rec.totalTokens)
        || input + output + cacheRead + cacheCreation;
      return {
        input_tokens: input,
        output_tokens: output,
        cache_read_tokens: cacheRead,
        cache_creation_tokens: cacheCreation,
        total_tokens: total,
        model: asString(rec.model ?? "") || null,
      };
    })
    .filter((item) => item.total_tokens > 0);
}

function normalizeToolCounts(raw: unknown): HistoryToolCount[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      const rec = (item ?? {}) as Record<string, unknown>;
      return { name: asString(rec.name), count: asNumber(rec.count) };
    })
    .filter((item) => item.name.length > 0 && item.count > 0);
}

function normalizeToolEvents(raw: unknown): HistoryToolEvent[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      const rec = (item ?? {}) as Record<string, unknown>;
      return {
        call_id: asString(rec.call_id ?? rec.callId ?? "") || null,
        name: asString(rec.name),
        category: asString(rec.category),
        message_index: rec.message_index === null || rec.messageIndex === null
          ? null
          : asNumber(rec.message_index ?? rec.messageIndex),
        timestamp: asString(rec.timestamp ?? "") || null,
        status: asString(rec.status ?? "") || null,
        duration_ms: rec.duration_ms === null || rec.durationMs === null
          ? null
          : asNumber(rec.duration_ms ?? rec.durationMs),
        input_summary: asString(rec.input_summary ?? rec.inputSummary ?? "") || null,
        output_summary: asString(rec.output_summary ?? rec.outputSummary ?? "") || null,
      };
    })
    .filter((item) => item.name.length > 0);
}

function normalizeFileChangeOperations(raw: unknown): HistoryFileChangeOperation[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      const rec = (item ?? {}) as Record<string, unknown>;
      return {
        source: asString(rec.source),
        tool_name: asString(rec.tool_name ?? rec.toolName ?? "") || null,
        file_path: asString(rec.file_path ?? rec.filePath),
        old_text: asString(rec.old_text ?? rec.oldText ?? "") || null,
        new_text: asString(rec.new_text ?? rec.newText ?? "") || null,
        patch: asString(rec.patch ?? "") || null,
        additions: asNumber(rec.additions),
        deletions: asNumber(rec.deletions),
        message_index: rec.message_index === null || rec.messageIndex === null
          ? null
          : asNumber(rec.message_index ?? rec.messageIndex),
        operation_group_index: rec.operation_group_index === null || rec.operationGroupIndex === null
          ? null
          : asNumber(rec.operation_group_index ?? rec.operationGroupIndex),
        timestamp: asString(rec.timestamp ?? "") || null,
      };
    })
    .filter((item) => item.file_path.length > 0);
}

function normalizeFileChanges(raw: unknown): HistoryFileChangeSummary[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      const rec = (item ?? {}) as Record<string, unknown>;
      return {
        file_path: asString(rec.file_path ?? rec.filePath),
        status: asString(rec.status || "M"),
        additions: asNumber(rec.additions),
        deletions: asNumber(rec.deletions),
        latest_message_index: rec.latest_message_index === null || rec.latestMessageIndex === null
          ? null
          : asNumber(rec.latest_message_index ?? rec.latestMessageIndex),
        latest_operation_group_index: rec.latest_operation_group_index === null || rec.latestOperationGroupIndex === null
          ? null
          : asNumber(rec.latest_operation_group_index ?? rec.latestOperationGroupIndex),
        latest_timestamp: asString(rec.latest_timestamp ?? rec.latestTimestamp ?? "") || null,
        operations: normalizeFileChangeOperations(rec.operations),
      };
    })
    .filter((item) => item.file_path.length > 0);
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
    session_ref: normalizeSessionRef(rec.session_ref ?? rec.sessionRef),
    read_only: rec.read_only === true || rec.readOnly === true,
  };
}

function normalizeIndexStatus(raw: unknown): HistoryIndexStatus {
  const rec = (raw ?? {}) as Record<string, unknown>;
  const phase = asString(rec.phase);
  return {
    rootsKey: asString(rec.rootsKey ?? rec.roots_key),
    phase: (["idle", "seeding", "scanning", "indexing", "ready", "error"] as const).includes(
      phase as HistoryIndexStatus["phase"]
    )
      ? (phase as HistoryIndexStatus["phase"])
      : "idle",
    indexedFiles: Math.max(0, asNumber(rec.indexedFiles ?? rec.indexed_files)),
    totalFiles: Math.max(0, asNumber(rec.totalFiles ?? rec.total_files)),
    generation: Math.max(0, asNumber(rec.generation)),
    partial: Boolean(rec.partial),
    lastCompletedAt:
      rec.lastCompletedAt == null && rec.last_completed_at == null
        ? null
        : asNumber(rec.lastCompletedAt ?? rec.last_completed_at),
    error: asString(rec.error ?? "") || null,
  };
}

function normalizePrompt(raw: unknown): HistoryPromptItem {
  const rec = (raw ?? {}) as Record<string, unknown>;
  return {
    session_id: asString(rec.session_id ?? rec.sessionId),
    source: asString(rec.source) as HistorySource,
    project_key: asString(rec.project_key ?? rec.projectKey),
    file_path: asString(rec.file_path ?? rec.filePath),
    session_title: asString(rec.session_title ?? rec.sessionTitle),
    updated_at: asNumber(rec.updated_at ?? rec.updatedAt),
    message_index: asNumber(rec.message_index ?? rec.messageIndex),
    prompt: asString(rec.prompt),
    timestamp: asString(rec.timestamp ?? "") || null,
  };
}

function normalizeStatsProject(raw: unknown): HistoryStatsProjectItem {
  const rec = (raw ?? {}) as Record<string, unknown>;
  return {
    project_key: asString(rec.project_key ?? rec.projectKey),
    sessions: asNumber(rec.sessions),
    messages: asNumber(rec.messages),
    input_tokens: asNumber(rec.input_tokens ?? rec.inputTokens),
    output_tokens: asNumber(rec.output_tokens ?? rec.outputTokens),
    cache_read_tokens: asNumber(rec.cache_read_tokens ?? rec.cacheReadTokens),
    cache_creation_tokens: asNumber(rec.cache_creation_tokens ?? rec.cacheCreationTokens),
    total_cost_usd: asNumber(rec.total_cost_usd ?? rec.totalCostUsd ?? rec.totalCostUSD),
    unpriced_tokens: asNumber(rec.unpriced_tokens ?? rec.unpricedTokens),
  };
}

function normalizeStatsModel(raw: unknown): HistoryStatsModelItem {
  const rec = (raw ?? {}) as Record<string, unknown>;
  return {
    model: asString(rec.model),
    sessions: asNumber(rec.sessions),
    ratio: asNumber(rec.ratio),
    input_tokens: asNumber(rec.input_tokens ?? rec.inputTokens),
    output_tokens: asNumber(rec.output_tokens ?? rec.outputTokens),
    cache_read_tokens: asNumber(rec.cache_read_tokens ?? rec.cacheReadTokens),
    cache_creation_tokens: asNumber(rec.cache_creation_tokens ?? rec.cacheCreationTokens),
    total_cost_usd: asNumber(rec.total_cost_usd ?? rec.totalCostUsd ?? rec.totalCostUSD),
    unpriced_tokens: asNumber(rec.unpriced_tokens ?? rec.unpricedTokens),
  };
}

function normalizeHeatmapDay(raw: unknown): HistoryStatsHeatmapDay {
  const rec = (raw ?? {}) as Record<string, unknown>;
  const sessionRefsRaw = rec.session_refs ?? rec.sessionRefs;
  const sessionRefs = Array.isArray(sessionRefsRaw)
    ? (sessionRefsRaw as unknown[])
    : [];
  return {
    day_start_utc: asNumber(rec.day_start_utc ?? rec.dayStartUtc),
    sessions: asNumber(rec.sessions),
    messages: asNumber(rec.messages),
    level: asNumber(rec.level),
    session_refs: sessionRefs.map((item) => normalizeSummary(item)),
  };
}

function normalizeDailySeries(raw: unknown): HistoryStatsDailySeriesItem {
  const rec = (raw ?? {}) as Record<string, unknown>;
  return {
    day_start_utc: asNumber(rec.day_start_utc ?? rec.dayStartUtc),
    sessions: asNumber(rec.sessions),
    messages: asNumber(rec.messages),
    input_tokens: asNumber(rec.input_tokens ?? rec.inputTokens),
    output_tokens: asNumber(rec.output_tokens ?? rec.outputTokens),
    cache_read_tokens: asNumber(rec.cache_read_tokens ?? rec.cacheReadTokens),
    cache_creation_tokens: asNumber(rec.cache_creation_tokens ?? rec.cacheCreationTokens),
    total_cost_usd: asNumber(rec.total_cost_usd ?? rec.totalCostUsd ?? rec.totalCostUSD),
    unpriced_tokens: asNumber(rec.unpriced_tokens ?? rec.unpricedTokens),
  };
}

function normalizeSourceDistribution(raw: unknown): HistoryStatsSourceItem {
  const rec = (raw ?? {}) as Record<string, unknown>;
  return {
    source: asString(rec.source),
    sessions: asNumber(rec.sessions),
    messages: asNumber(rec.messages),
    input_tokens: asNumber(rec.input_tokens ?? rec.inputTokens),
    output_tokens: asNumber(rec.output_tokens ?? rec.outputTokens),
    cache_read_tokens: asNumber(rec.cache_read_tokens ?? rec.cacheReadTokens),
    cache_creation_tokens: asNumber(rec.cache_creation_tokens ?? rec.cacheCreationTokens),
    total_cost_usd: asNumber(rec.total_cost_usd ?? rec.totalCostUsd ?? rec.totalCostUSD),
    unpriced_tokens: asNumber(rec.unpriced_tokens ?? rec.unpricedTokens),
  };
}

function normalizeProjectEfficiency(raw: unknown): HistoryStatsProjectEfficiencyItem {
  const rec = (raw ?? {}) as Record<string, unknown>;
  return {
    project_key: asString(rec.project_key ?? rec.projectKey),
    sessions: asNumber(rec.sessions),
    messages: asNumber(rec.messages),
    input_tokens: asNumber(rec.input_tokens ?? rec.inputTokens),
    output_tokens: asNumber(rec.output_tokens ?? rec.outputTokens),
    cache_read_tokens: asNumber(rec.cache_read_tokens ?? rec.cacheReadTokens),
    cache_creation_tokens: asNumber(rec.cache_creation_tokens ?? rec.cacheCreationTokens),
    total_cost_usd: asNumber(rec.total_cost_usd ?? rec.totalCostUsd ?? rec.totalCostUSD),
    unpriced_tokens: asNumber(rec.unpriced_tokens ?? rec.unpricedTokens),
    avg_messages_per_session: asNumber(rec.avg_messages_per_session ?? rec.avgMessagesPerSession),
  };
}

function normalizeHourlyActivity(raw: unknown): HistoryStatsHourlyActivityItem {
  const rec = (raw ?? {}) as Record<string, unknown>;
  const sessionRefsRaw = rec.session_refs ?? rec.sessionRefs;
  const sessionRefs = Array.isArray(sessionRefsRaw)
    ? (sessionRefsRaw as unknown[])
    : [];
  return {
    hour: asNumber(rec.hour),
    hour_start_utc: asNumber(rec.hour_start_utc ?? rec.hourStartUtc),
    sessions: asNumber(rec.sessions),
    messages: asNumber(rec.messages),
    level: asNumber(rec.level),
    input_tokens: asNumber(rec.input_tokens ?? rec.inputTokens),
    output_tokens: asNumber(rec.output_tokens ?? rec.outputTokens),
    cache_read_tokens: asNumber(rec.cache_read_tokens ?? rec.cacheReadTokens),
    cache_creation_tokens: asNumber(rec.cache_creation_tokens ?? rec.cacheCreationTokens),
    total_cost_usd: asNumber(rec.total_cost_usd ?? rec.totalCostUsd ?? rec.totalCostUSD),
    unpriced_tokens: asNumber(rec.unpriced_tokens ?? rec.unpricedTokens),
    session_refs: sessionRefs.map((item) => normalizeSummary(item)),
  };
}

function normalizeStats(raw: unknown): HistoryStatsPayload {
  const rec = (raw ?? {}) as Record<string, unknown>;
  const projectRawValue = rec.project_ranking ?? rec.projectRanking;
  const projectRaw = Array.isArray(projectRawValue)
    ? (projectRawValue as unknown[])
    : [];
  const modelRawValue = rec.model_distribution ?? rec.modelDistribution;
  const modelRaw = Array.isArray(modelRawValue)
    ? (modelRawValue as unknown[])
    : [];
  const heatmapRaw = Array.isArray(rec.heatmap) ? (rec.heatmap as unknown[]) : [];
  const dailySeriesRawValue = rec.daily_series ?? rec.dailySeries;
  const dailySeriesRaw = Array.isArray(dailySeriesRawValue)
    ? (dailySeriesRawValue as unknown[])
    : [];
  const sourceRawValue = rec.source_distribution ?? rec.sourceDistribution;
  const sourceRaw = Array.isArray(sourceRawValue)
    ? (sourceRawValue as unknown[])
    : [];
  const efficiencyRawValue = rec.project_efficiency ?? rec.projectEfficiency;
  const efficiencyRaw = Array.isArray(efficiencyRawValue)
    ? (efficiencyRawValue as unknown[])
    : [];
  const hourlyRawValue = rec.hourly_activity ?? rec.hourlyActivity;
  const hourlyRaw = Array.isArray(hourlyRawValue)
    ? (hourlyRawValue as unknown[])
    : [];
  return {
    range_days: asNumber(rec.range_days ?? rec.rangeDays),
    total_sessions: asNumber(rec.total_sessions ?? rec.totalSessions),
    total_messages: asNumber(rec.total_messages ?? rec.totalMessages),
    total_input_tokens: asNumber(rec.total_input_tokens ?? rec.totalInputTokens),
    total_output_tokens: asNumber(rec.total_output_tokens ?? rec.totalOutputTokens),
    total_cache_read_tokens: asNumber(rec.total_cache_read_tokens ?? rec.totalCacheReadTokens),
    total_cache_creation_tokens: asNumber(rec.total_cache_creation_tokens ?? rec.totalCacheCreationTokens),
    total_cost_usd: asNumber(rec.total_cost_usd ?? rec.totalCostUsd ?? rec.totalCostUSD),
    total_unpriced_tokens: asNumber(rec.total_unpriced_tokens ?? rec.totalUnpricedTokens),
    project_ranking: projectRaw.map((item) => normalizeStatsProject(item)),
    model_distribution: modelRaw.map((item) => normalizeStatsModel(item)),
    heatmap: heatmapRaw.map((item) => normalizeHeatmapDay(item)),
    daily_series: dailySeriesRaw.map((item) => normalizeDailySeries(item)),
    source_distribution: sourceRaw.map((item) => normalizeSourceDistribution(item)),
    project_efficiency: efficiencyRaw.map((item) => normalizeProjectEfficiency(item)),
    hourly_activity: hourlyRaw.map((item) => normalizeHourlyActivity(item)),
  };
}

function normalizeStatsProjectOptions(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const projectSet = new Set<string>();
  for (const item of raw) {
    const project = asString(item).trim();
    if (project) projectSet.add(project);
  }
  return Array.from(projectSet).sort((a, b) => a.localeCompare(b));
}

function normalizeSourceFilter(filter: HistorySourceFilter): Exclude<HistorySourceFilter, "all"> | null {
  if (filter === "all") return null;
  return filter;
}

export interface TodayProjectStats {
  sessions: number;
  totalTokens: number;
  totalCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  unpricedTokens: number;
}

export interface FetchHistoryStatsOptions {
  sourceFilter: HistorySourceFilter;
  projectKey?: string | null;
  projectPath?: string | null;
  sourceInstanceId?: string | null;
  rangeDays?: number | null;
  startAt?: number | null;
  endAt?: number | null;
  force?: boolean;
}

export async function fetchHistoryStatsProjectOptions(sourceFilter: HistorySourceFilter): Promise<string[]> {
  const raw = await invoke<unknown>("history_list_stats_projects", {
    source: normalizeSourceFilter(sourceFilter),
    ...(await getHistoryPathArgs()),
  });
  return normalizeStatsProjectOptions(raw);
}

export async function fetchHistoryStatsPayload(options: FetchHistoryStatsOptions): Promise<HistoryStatsPayload> {
  const projectKey = options.projectKey?.trim() || null;
  const projectPath = options.projectPath?.trim() || null;
  const sourceInstanceId = options.sourceInstanceId?.trim() || null;
  const startAt = typeof options.startAt === "number" && Number.isFinite(options.startAt) ? options.startAt : null;
  const endAt = typeof options.endAt === "number" && Number.isFinite(options.endAt) ? options.endAt : null;
  const rangeDays = options.rangeDays ?? 30;
  const force = options.force ?? false;
  const raw = await invoke<unknown>("history_get_stats", {
    source: normalizeSourceFilter(options.sourceFilter),
    ...(await getHistoryPathArgs()),
    projectKey,
    projectPath,
    sourceInstanceId,
    rangeDays,
    startAt,
    endAt,
    force,
  });
  return normalizeStats(raw);
}

export async function fetchRemoteHistoryStatsPayload(
  project: Project,
  options: FetchHistoryStatsOptions,
): Promise<HistoryStatsPayload> {
  let context = await buildSshAgentHistoryContext(project);
  try {
    context = await syncRemoteHistoryContext(context, { limit: 1000 });
    return await fetchHistoryStatsPayload({
      ...options,
      projectKey: null,
      projectPath: project.remote_path,
      sourceInstanceId: context.sourceInstanceId,
      force: true,
    });
  } finally {
    void invoke("history_remote_close", {
      hostId: context.hostId,
      consumerId: context.consumerId,
    }).catch(() => undefined);
  }
}

// 供终端统计面板使用：按项目路径取最近一次 CLI 会话详情，不改动历史工作区的选中状态。
// source 非空时只匹配对应 CLI（claude/codex），供按终端工具区分的场景使用。
// 传入 prev（上次结果的 file_path/updated_at）时，若最近会话未变化则返回 "unchanged"，
// 跳过整个 jsonl 的重新解析，供轮询场景使用。
// forceCatalogRefresh：Hook 刚绑定 sessionId / 用量仍为 0 时强制扫盘索引，避免 catalog TTL 导致侧栏空等再闪出。
export async function fetchLatestProjectSessionDetail(
  projectPath: string,
  prev?: { filePath: string; updatedAt: number },
  source?: HistorySource | null,
  cliSessionId?: string | null,
  options?: { forceCatalogRefresh?: boolean }
): Promise<HistorySessionDetail | "unchanged" | null> {
  try {
    const forceCatalogRefresh = Boolean(options?.forceCatalogRefresh);
    logInfo("history.realtime.lookup.start", {
      source: source ?? null,
      projectPath,
      cliSessionId: cliSessionId ?? null,
      forceCatalogRefresh,
      previousFilePath: prev?.filePath ?? null,
      previousUpdatedAt: prev?.updatedAt ?? null,
    });
    const pathArgs = await getHistoryPathArgs();
    const loadSummary = async (
      query: string | null,
      scopedProjectPath: string | null
    ): Promise<HistorySessionSummary | null> => {
      const summariesRaw = await invoke<unknown[]>("history_list_sessions", {
        source: source ?? null,
        ...pathArgs,
        projectPath: scopedProjectPath,
        query,
        limit: 1,
        offset: 0,
      });
      const summary = (summariesRaw ?? []).map((item) => normalizeSummary(item))[0] ?? null;
      logInfo("history.realtime.lookup.summary", {
        source: source ?? null,
        projectPath: scopedProjectPath,
        query,
        cliSessionId: cliSessionId ?? null,
        found: Boolean(summary),
        sessionId: summary?.session_id ?? null,
        sessionProjectKey: summary?.project_key ?? null,
        sessionFilePath: summary?.file_path ?? null,
      });
      return summary;
    };

    // 绑定了 CLI sessionId 时：先按项目过滤找，失败再仅按 sessionId 找（Pi 等 cwd/project_key 口径与 Claude 不同）。
    // 仍 miss 时强制刷新 catalog 再试一次，避免新会话落盘后 10s TTL 内侧栏一直空白。
    const sessionQuery = cliSessionId?.trim() || null;
    const resolveBoundSummary = async (): Promise<HistorySessionSummary | null> => {
      if (!sessionQuery) {
        return loadSummary(null, projectPath);
      }
      let summary = await loadSummary(sessionQuery, projectPath);
      if (summary?.session_id === sessionQuery) return summary;
      summary = await loadSummary(sessionQuery, null);
      if (summary?.session_id === sessionQuery) return summary;
      if (!forceCatalogRefresh) return null;
      try {
        await invoke("history_refresh_index", { ...pathArgs, wait: true });
      } catch (error) {
        logWarn("history.realtime.lookup.refreshFailed", {
          source: source ?? null,
          projectPath,
          cliSessionId: sessionQuery,
          error: String(error),
        });
      }
      summary = await loadSummary(sessionQuery, projectPath);
      if (summary?.session_id === sessionQuery) return summary;
      summary = await loadSummary(sessionQuery, null);
      return summary?.session_id === sessionQuery ? summary : null;
    };

    const summary = await resolveBoundSummary();
    if (sessionQuery && summary?.session_id !== sessionQuery) {
      logWarn("history.realtime.lookup.sessionMismatch", {
        source: source ?? null,
        projectPath,
        cliSessionId: sessionQuery,
        foundSessionId: summary?.session_id ?? null,
      });
      return null;
    }
    if (!summary) {
      logWarn("history.realtime.lookup.miss", {
        source: source ?? null,
        projectPath,
        cliSessionId: cliSessionId ?? null,
      });
      return null;
    }
    if (prev && summary.file_path === prev.filePath && summary.updated_at === prev.updatedAt) {
      logInfo("history.realtime.lookup.unchanged", {
        source: summary.source,
        projectPath,
        sessionId: summary.session_id,
        sessionFilePath: summary.file_path,
      });
      return "unchanged";
    }
    // aggregateSubtasks=false：实时侧栏优先走可快速返回的路径，避免大会话聚合拖慢首屏。
    const detailRaw = await invoke<unknown>("history_get_session", {
      filePath: summary.file_path,
      ...pathArgs,
      source: summary.source,
      projectKey: summary.project_key,
      aggregateSubtasks: false,
    });
    const detail = normalizeDetail(detailRaw);
    logInfo("history.realtime.lookup.detail", {
      source: detail.source,
      projectPath,
      cliSessionId: cliSessionId ?? null,
      sessionId: detail.session_id,
      sessionProjectKey: detail.project_key,
      sessionFilePath: detail.file_path,
      cwd: detail.cwd ?? null,
      inputTokens: detail.usage?.input_tokens ?? 0,
      outputTokens: detail.usage?.output_tokens ?? 0,
    });
    return detail;
  } catch (error) {
    logWarn("history.realtime.lookup.error", {
      source: source ?? null,
      projectPath,
      cliSessionId: cliSessionId ?? null,
      error: String(error),
    });
    return prev ? "unchanged" : null;
  }
}

// 供「模型价格设置」识别本地模型：扫描全部历史的模型分布，返回去重模型名列表。
// 复用 normalizeStats 兜底 snake/camel 命名与缺失字段，避免直接读原始返回导致 undefined.map。
export async function fetchDiscoveredModels(): Promise<string[]> {
  const raw = await invoke<unknown>("history_get_stats", {
    source: null,
    ...(await getHistoryPathArgs()),
    projectKey: null,
    sourceInstanceId: null,
    rangeDays: null,
    startAt: null,
    endAt: null,
    force: true,
  });
  const stats = normalizeStats(raw);
  return stats.model_distribution
    .map((item) => item.model.trim())
    .filter((model) => model.length > 0);
}

export async function fetchTodayProjectStats(
  projectKey: string,
  source?: HistorySource | null,
  projectPath?: string | null,
  projectPaths?: string[]
): Promise<TodayProjectStats | null> {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const normalizedProjectPath = normalizeHistoryProjectPaths(projectPath ? [projectPath] : [])[0] ?? null;
  const normalizedProjectPaths = normalizeHistoryProjectPaths(projectPaths ?? []);
  const hasProjectPaths = normalizedProjectPaths.length > 0;
  try {
    const raw = await invoke<unknown>("history_get_stats", {
      source: source ?? null,
      ...(await getHistoryPathArgs()),
      projectKey: normalizedProjectPath || hasProjectPaths ? null : projectKey,
      projectPath: hasProjectPaths ? null : normalizedProjectPath,
      projectPaths: hasProjectPaths ? normalizedProjectPaths : null,
      sourceInstanceId: null,
      rangeDays: null,
      startAt: todayStart.getTime(),
      endAt: Date.now(),
      force: false,
    });
    const stats = normalizeStats(raw);
    return {
      sessions: stats.total_sessions,
      totalTokens:
        stats.total_input_tokens +
        stats.total_output_tokens +
        stats.total_cache_read_tokens +
        stats.total_cache_creation_tokens,
      totalCostUsd: stats.total_cost_usd,
      inputTokens: stats.total_input_tokens,
      outputTokens: stats.total_output_tokens,
      cacheReadTokens: stats.total_cache_read_tokens,
      cacheCreationTokens: stats.total_cache_creation_tokens,
      unpricedTokens: stats.total_unpriced_tokens,
    };
  } catch {
    return null;
  }
}

/**
 * 今日项目用量：由后端按多个项目/Worktree 路径一次过滤并按唯一会话聚合。
 */
export async function fetchTodayProjectStatsMerged(
  projectKey: string,
  source: HistorySource | null | undefined,
  projectPaths: string[]
): Promise<TodayProjectStats | null> {
  const uniquePaths = normalizeHistoryProjectPaths(projectPaths);
  if (uniquePaths.length === 0) {
    return fetchTodayProjectStats(projectKey, source, null);
  }
  return fetchTodayProjectStats(projectKey, source, null, uniquePaths);
}

export async function fetchRemoteTodayProjectStats(
  context: SshAgentHistoryContext,
): Promise<{ context: SshAgentHistoryContext; result: TodayProjectStats | null }> {
  const synced = await syncRemoteHistoryContext(context, { limit: 200 });
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const raw = await invoke<unknown>("history_get_stats", {
    source: synced.source,
    ...(await getHistoryPathArgs()),
    projectKey: null,
    projectPath: null,
    projectPaths: synced.projectPaths,
    sourceInstanceId: synced.sourceInstanceId,
    rangeDays: null,
    startAt: todayStart.getTime(),
    endAt: Date.now(),
    force: true,
  });
  const stats = normalizeStats(raw);
  return {
    context: synced,
    result: {
      sessions: stats.total_sessions,
      totalTokens:
        stats.total_input_tokens +
        stats.total_output_tokens +
        stats.total_cache_read_tokens +
        stats.total_cache_creation_tokens,
      totalCostUsd: stats.total_cost_usd,
      inputTokens: stats.total_input_tokens,
      outputTokens: stats.total_output_tokens,
      cacheReadTokens: stats.total_cache_read_tokens,
      cacheCreationTokens: stats.total_cache_creation_tokens,
      unpricedTokens: stats.total_unpriced_tokens,
    },
  };
}

export async function fetchRemoteLatestProjectSessionDetail(
  context: SshAgentHistoryContext,
  prev?: { filePath: string; updatedAt: number },
  cliSessionId?: string | null,
  remoteTranscriptRef?: string | null,
): Promise<{ context: SshAgentHistoryContext; result: HistorySessionDetail | "unchanged" | null }> {
  const requestedSessionId = cliSessionId?.trim() || null;
  if (requestedSessionId) {
    try {
      const detailRaw = await invoke<unknown>("history_remote_get_session", {
        consumerId: context.consumerId,
        sshLaunch: context.launch,
        source: context.source,
        configuredConfigRoot: context.configuredConfigRoot,
        projectPaths: context.projectPaths,
        sourceInstanceId: context.sourceInstanceId,
        sourceSessionId: requestedSessionId,
        remoteTranscriptRef: remoteTranscriptRef?.trim() || null,
      });
      const detail = normalizeDetail(detailRaw);
      if (detail.session_id !== requestedSessionId) return { context, result: null };
      const sourceInstanceId = detail.session_ref?.sourceInstanceId || context.sourceInstanceId;
      const nextContext = sourceInstanceId === context.sourceInstanceId
        ? context
        : { ...context, sourceInstanceId };
      if (prev && detail.file_path === prev.filePath && detail.updated_at === prev.updatedAt) {
        return { context: nextContext, result: "unchanged" };
      }
      return { context: nextContext, result: detail };
    } catch {
      return { context, result: null };
    }
  }
  const synced = await syncRemoteHistoryContext(context, { limit: SESSION_PAGE_FETCH_LIMIT });
  if (!synced.sourceInstanceId) return { context: synced, result: null };
  const summariesRaw = await invoke<unknown[]>("history_remote_list_cached", {
    sourceInstanceId: synced.sourceInstanceId,
    projectPath: synced.projectPaths[0] ?? null,
    query: null,
    limit: SESSION_PAGE_FETCH_LIMIT,
    offset: 0,
  });
  const summaries = (summariesRaw ?? []).map((item) => normalizeSummary(item));
  const summary = summaries[0] ?? null;
  if (!summary) return { context: synced, result: null };
  if (prev && summary.file_path === prev.filePath && summary.updated_at === prev.updatedAt) {
    return { context: synced, result: "unchanged" };
  }
  const detailRaw = await invoke<unknown>("history_remote_get_session", {
    consumerId: synced.consumerId,
    sshLaunch: synced.launch,
    source: synced.source,
    configuredConfigRoot: synced.configuredConfigRoot,
    projectPaths: synced.projectPaths,
    sourceInstanceId: synced.sourceInstanceId,
    sourceSessionId: summary.session_id,
    remoteTranscriptRef: null,
  });
  return { context: synced, result: normalizeDetail(detailRaw) };
}

function getHistoryPathCacheKey(): string {
  const { claudeConfigDir, codexConfigDir } = getHistoryPathArgsSync();
  return `${claudeConfigDir ?? "__default__"}|${codexConfigDir ?? "__default__"}`;
}

function makeSessionKey(
  source: HistorySource,
  sessionId: string,
  filePath: string,
  sessionRef?: HistorySessionRef | null,
): string {
  if (sessionRef?.transportKind === "ssh") {
    return `history:${sessionRef.sourceId}:${sessionRef.sourceInstanceId}:${sessionRef.sourceSessionId}`;
  }
  return `${source}:${sessionId}:${filePath}`;
}

function summarySessionKey(summary: HistorySessionSummary): string {
  return makeSessionKey(summary.source, summary.session_id, summary.file_path, summary.session_ref);
}

function hitSessionKey(hit: HistorySearchHit): string {
  return makeSessionKey(hit.source, hit.session_id, hit.file_path, hit.session_ref);
}

function claudeProjectKeyFromPath(path: string): string {
  return path.trim().replace(/:/g, "-").replace(/[\\/]/g, "-").replace(/-+$/g, "").toLowerCase();
}

function projectLastSegment(path: string): string {
  return normalizeMetaPath(path).replace(/\/+$/g, "").split("/").filter(Boolean).pop()?.toLowerCase() ?? "";
}

function normalizeMetaPath(path: string): string {
  return path.replace(/\\/g, "/");
}

function snapshotMatchesFilters(
  snapshot: SessionFavoriteSnapshot,
  sourceFilter: HistorySourceFilter,
  projectPathFilter: string | null
): boolean {
  if (sourceFilter !== "all" && snapshot.source !== sourceFilter) return false;
  if (!projectPathFilter) return true;
  const projectKey = snapshot.project_key.toLowerCase();
  if (snapshot.source === "claude") {
    return projectKey === claudeProjectKeyFromPath(projectPathFilter);
  }
  return projectKey === projectLastSegment(projectPathFilter) || projectKey === normalizeMetaPath(projectPathFilter).toLowerCase();
}

function makeStatsProjectOptionsCacheKey(
  source: HistorySourceFilter,
  historyPathKey: string
): string {
  return `${source}|${historyPathKey}`;
}

function makeStatsCacheKey(
  source: HistorySourceFilter,
  projectKey: string | null,
  projectPath: string | null,
  timeKey: string,
  historyPathKey: string
): string {
  return `${source}|key=${projectKey ?? "__all__"}|path=${projectPath ?? "__all__"}|${timeKey}|${historyPathKey}`;
}

function makeStatsTimeKey(rangeDays: number, startAt: number | null, endAt: number | null): string {
  if (startAt !== null && endAt !== null) {
    return `absolute:${startAt}:${endAt}`;
  }
  return `range:${rangeDays}`;
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
    sessionKey: summarySessionKey(summary),
    alias,
    starred,
    tags,
    displayTitle,
  };
}

function applyMeta(summaries: HistorySessionSummary[], metaMap: SessionMetaMap): HistorySessionView[] {
  const metaBySourceSession = new Map<string, SessionMeta>();
  const metaBySourcePath = new Map<string, SessionMeta>();
  for (const meta of Object.values(metaMap)) {
    const source = meta.source.toLowerCase();
    if (meta.session_id) {
      metaBySourceSession.set(`${source}:${meta.session_id}`, meta);
    }
    if (meta.file_path) {
      metaBySourcePath.set(`${source}:${normalizeMetaPath(meta.file_path)}`, meta);
    }
  }

  const views = summaries.map((summary) => {
    const key = summarySessionKey(summary);
    const source = summary.source.toLowerCase();
    const meta =
      metaMap[key] ??
      (summary.session_ref?.transportKind === "ssh"
        ? undefined
        : metaBySourceSession.get(`${source}:${summary.session_id}`)) ??
      metaBySourcePath.get(`${source}:${normalizeMetaPath(summary.file_path)}`);
    return toView(summary, meta);
  });
  return sortSessionViews(views);
}

function sortSessionViews(views: HistorySessionView[]): HistorySessionView[] {
  return [...views].sort((a, b) => {
    if (a.starred !== b.starred) {
      return a.starred ? -1 : 1;
    }
    return b.updated_at - a.updated_at;
  });
}

function viewToSummary(view: HistorySessionView): HistorySessionSummary {
  return {
    session_id: view.session_id,
    source: view.source,
    project_key: view.project_key,
    title: view.title,
    file_path: view.file_path,
    cwd: view.cwd,
    created_at: view.created_at,
    updated_at: view.updated_at,
    message_count: view.message_count,
    branch: view.branch,
    session_ref: view.session_ref,
    materialization_level: view.materialization_level,
    freshness_state: view.freshness_state,
    as_of: view.as_of,
    remote_identity: view.remote_identity,
    read_only: view.read_only,
  };
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

function snapshotToSummary(snapshot: SessionFavoriteSnapshot): HistorySessionSummary {
  let sessionRef: HistorySessionRef | null = null;
  try {
    const detail = JSON.parse(snapshot.detail_json) as Record<string, unknown>;
    sessionRef = normalizeSessionRef(detail.session_ref ?? detail.sessionRef);
  } catch {
    sessionRef = null;
  }
  return {
    session_id: snapshot.session_id,
    source: snapshot.source,
    project_key: snapshot.project_key,
    title: snapshot.title,
    file_path: snapshot.file_path,
    created_at: snapshot.created_at,
    updated_at: snapshot.updated_at,
    message_count: snapshot.message_count,
    branch: snapshot.branch ?? null,
    session_ref: sessionRef,
    materialization_level: sessionRef?.transportKind === "ssh" ? "detail" : undefined,
    read_only: sessionRef?.transportKind === "ssh",
  };
}

async function readFavoriteSnapshots(
  sourceFilter: HistorySourceFilter,
  projectPathFilter: string | null
): Promise<SessionFavoriteSnapshot[]> {
  const db = await getDb();
  const rows = await db.select<SessionFavoriteSnapshot[]>(`
    SELECT s.*
    FROM session_favorite_snapshots s
    INNER JOIN session_meta m ON m.session_key = s.session_key
    WHERE m.starred = 1
    ORDER BY s.updated_at DESC
  `);
  return rows.filter((snapshot) => snapshotMatchesFilters(snapshot, sourceFilter, projectPathFilter));
}

async function readFavoriteSnapshotDetail(sessionKey: string): Promise<HistorySessionDetail | null> {
  const db = await getDb();
  const rows = await db.select<Array<{ detail_json: string }>>(
    "SELECT detail_json FROM session_favorite_snapshots WHERE session_key = $1 LIMIT 1",
    [sessionKey]
  );
  const json = rows[0]?.detail_json;
  if (!json) return null;
  try {
    return normalizeDetail(JSON.parse(json));
  } catch (err) {
    logWarn("history.favoriteSnapshot.parseFailed", { sessionKey, error: String(err) });
    return null;
  }
}

async function writeFavoriteSnapshot(sessionKey: string, detail: HistorySessionDetail): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO session_favorite_snapshots
      (session_key, session_id, source, project_key, file_path, title, created_at, updated_at, message_count, branch, detail_json, snapshot_at)
     VALUES
      ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT(session_key) DO UPDATE SET
      session_id = excluded.session_id,
      source = excluded.source,
      project_key = excluded.project_key,
      file_path = excluded.file_path,
      title = excluded.title,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at,
      message_count = excluded.message_count,
      branch = excluded.branch,
      detail_json = excluded.detail_json,
      snapshot_at = excluded.snapshot_at`,
    [
      sessionKey,
      detail.session_id,
      detail.source,
      detail.project_key,
      detail.file_path,
      detail.title,
      detail.created_at,
      detail.updated_at,
      detail.message_count,
      detail.branch ?? null,
      JSON.stringify(detail),
      Date.now().toString(),
    ]
  );
}

async function deleteFavoriteSnapshot(sessionKey: string): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM session_favorite_snapshots WHERE session_key = $1", [sessionKey]);
}

type HistoryEditOp = "edit" | "delete" | "insert" | "restore";

interface HistoryEditOutcome {
  detail: HistorySessionDetail;
  beforeText: string | null;
  afterText: string | null;
  backupPath: string | null;
}

function normalizeEditOutcome(raw: unknown): HistoryEditOutcome {
  const rec = (raw ?? {}) as Record<string, unknown>;
  return {
    detail: normalizeDetail(rec.detail),
    beforeText: asString(rec.beforeText ?? rec.before_text ?? "") || null,
    afterText: asString(rec.afterText ?? rec.after_text ?? "") || null,
    backupPath: asString(rec.backupPath ?? rec.backup_path ?? "") || null,
  };
}

interface HistoryBatchDeleteOutcome {
  detail: HistorySessionDetail;
  backupPath: string | null;
  removed: Array<{ lineIndex: number | null; role: string; text: string }>;
}

function normalizeBatchDeleteOutcome(raw: unknown): HistoryBatchDeleteOutcome {
  const rec = (raw ?? {}) as Record<string, unknown>;
  const removedRaw = Array.isArray(rec.removed) ? rec.removed : [];
  return {
    detail: normalizeDetail(rec.detail),
    backupPath: asString(rec.backupPath ?? rec.backup_path ?? "") || null,
    removed: removedRaw.map((item) => {
      const removed = (item ?? {}) as Record<string, unknown>;
      const rawLineIndex = removed.lineIndex ?? removed.line_index;
      return {
        lineIndex:
          typeof rawLineIndex === "number" && Number.isFinite(rawLineIndex) ? rawLineIndex : null,
        role: asString(removed.role),
        text: asString(removed.text),
      };
    }),
  };
}

function normalizeBackupStatus(raw: unknown): HistoryBackupStatus {
  const rec = (raw ?? {}) as Record<string, unknown>;
  const backupAtRaw = rec.backupAt ?? rec.backup_at;
  return {
    hasBackup: rec.hasBackup === true || rec.has_backup === true,
    backupPath: asString(rec.backupPath ?? rec.backup_path ?? "") || null,
    backupAt: typeof backupAtRaw === "number" && Number.isFinite(backupAtRaw) ? backupAtRaw : null,
  };
}

async function insertEditAuditRecord(entry: {
  sessionKey: string;
  sessionId: string;
  source: string;
  filePath: string;
  op: HistoryEditOp;
  lineIndex: number | null;
  role: string | null;
  beforeText: string | null;
  afterText: string | null;
  backupPath: string | null;
}): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO history_edit_audit
      (session_key, session_id, source, file_path, op, line_index, role, before_text, after_text, backup_path, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      entry.sessionKey,
      entry.sessionId,
      entry.source,
      entry.filePath,
      entry.op,
      entry.lineIndex,
      entry.role,
      entry.beforeText,
      entry.afterText,
      entry.backupPath,
      Date.now(),
    ]
  );
}

function mergeDetailIntoSessions(
  sessions: HistorySessionView[],
  sessionKey: string,
  detail: HistorySessionDetail
): HistorySessionView[] {
  return sortSessionViews(
    sessions.map((item) =>
      item.sessionKey === sessionKey
        ? {
            ...item,
            title: detail.title,
            updated_at: detail.updated_at,
            message_count: detail.message_count,
            displayTitle: item.alias.trim() || detail.title,
          }
        : item
    )
  );
}

/** 编辑写回成功后的共用状态应用：原地替换 detail、更新列表摘要、同步收藏快照。 */
async function applyEditedDetail(
  sessionKey: string,
  target: HistorySessionView,
  detail: HistorySessionDetail
): Promise<void> {
  useHistoryStore.setState((state) => ({
    activeSession: state.activeSessionKey === sessionKey ? detail : state.activeSession,
    sessions: mergeDetailIntoSessions(state.sessions, sessionKey, detail),
  }));
  if (target.starred) {
    try {
      await writeFavoriteSnapshot(sessionKey, detail);
    } catch (err) {
      logWarn("history.edit.snapshotSyncFailed", { sessionKey, error: String(err) });
    }
  }
}

/** 编辑命令成功后的统一收尾：原地替换 detail、更新列表摘要、写审计、同步收藏快照。 */
async function finalizeEditOutcome(options: {
  sessionKey: string;
  target: HistorySessionView;
  op: HistoryEditOp;
  lineIndex: number | null;
  role: string | null;
  outcome: HistoryEditOutcome;
}): Promise<void> {
  const { sessionKey, target, op, lineIndex, role, outcome } = options;
  const detail = outcome.detail;
  await applyEditedDetail(sessionKey, target, detail);
  try {
    await insertEditAuditRecord({
      sessionKey,
      sessionId: detail.session_id,
      source: detail.source,
      filePath: detail.file_path,
      op,
      lineIndex,
      role,
      beforeText: outcome.beforeText,
      afterText: outcome.afterText,
      backupPath: outcome.backupPath,
    });
  } catch (err) {
    // 审计失败不阻断编辑结果，但要留日志可查。
    logWarn("history.edit.auditWriteFailed", { sessionKey, op, error: String(err) });
  }
}

/** 守卫失败（文件被外部改动/行漂移）时自动重载会话，让用户基于最新内容重试。 */
async function reloadAfterEditConflict(sessionKey: string, err: unknown): Promise<never> {
  const message = String(err);
  if (message.includes("history_file_changed") || message.includes("history_line_conflict")) {
    try {
      await useHistoryStore.getState().openSession(sessionKey);
    } catch (reloadErr) {
      logWarn("history.edit.conflictReloadFailed", { sessionKey, error: String(reloadErr) });
    }
  }
  throw err instanceof Error ? err : new Error(message);
}

function requireActiveEditContext(sessionKey: string): {
  target: HistorySessionView;
  active: HistorySessionDetail;
} {
  const state = useHistoryStore.getState();
  const target = state.sessions.find((item) => item.sessionKey === sessionKey);
  const active = state.activeSession;
  if (!target || !active || state.activeSessionKey !== sessionKey) {
    throw new Error("session_not_loaded");
  }
  if (target.favoriteSnapshot) {
    // 快照兜底会话没有可写的源文件
    throw new Error("favorite_snapshot_readonly");
  }
  if (target.session_ref?.transportKind === "ssh" || target.read_only || active.read_only) {
    throw new Error("history_remote_read_only");
  }
  return { target, active };
}

function requireMessageLocator(message: HistoryMessage): { lineIndex: number; expectedText: string } {
  if (!message.editable || message.line_index === null || message.line_index === undefined) {
    throw new Error("message_not_editable");
  }
  return {
    lineIndex: message.line_index,
    expectedText: message.editable_text ?? message.content,
  };
}

async function loadDetailForSnapshot(sessionKey: string, session: HistorySessionView): Promise<HistorySessionDetail> {
  const active = useHistoryStore.getState().activeSession;
  if (useHistoryStore.getState().activeSessionKey === sessionKey && active) {
    return active;
  }
  if (session.session_ref?.transportKind === "ssh") {
    await useHistoryStore.getState().openSession(sessionKey);
    const remoteDetail = useHistoryStore.getState().activeSession;
    if (!remoteDetail) throw new Error("history_remote_online_required");
    return remoteDetail;
  }
  return normalizeDetail(await invoke<unknown>("history_get_session", {
    filePath: session.file_path,
    ...(await getHistoryPathArgs()),
    source: session.source,
    projectKey: session.project_key,
  }));
}

async function applyFavoriteSnapshots(
  summaries: HistorySessionSummary[],
  metaMap: SessionMetaMap,
  sourceFilter: HistorySourceFilter,
  projectPathFilter: string | null,
  sourceSessionKeys?: Set<string>
): Promise<HistorySessionView[]> {
  const summaryMap = new Map<string, HistorySessionSummary>();
  for (const summary of summaries) {
    summaryMap.set(summarySessionKey(summary), summary);
  }
  const sourceKeys = sourceSessionKeys ?? new Set(summaryMap.keys());

  const snapshotKeys = new Set<string>();
  for (const snapshot of await readFavoriteSnapshots(sourceFilter, projectPathFilter)) {
    snapshotKeys.add(snapshot.session_key);
    if (!summaryMap.has(snapshot.session_key)) {
      summaryMap.set(snapshot.session_key, snapshotToSummary(snapshot));
    }
  }

  return applyMeta(Array.from(summaryMap.values()), metaMap).map((session) =>
    snapshotKeys.has(session.sessionKey) && !sourceKeys.has(session.sessionKey)
      ? { ...session, favoriteSnapshot: true }
      : session
  );
}

let globalSearchRequestSeq = 0;
let historyOpenRequestSeq = 0;
let sessionListRequestSeq = 0;
let sessionDetailRequestSeq = 0;
let historyIndexListenerPromise: Promise<void> | null = null;
let historyIndexReadyRefreshTimer: number | null = null;
const remoteHistorySyncPromises = new Map<string, Promise<SshAgentHistoryContext>>();

function isCurrentSessionListRequest(requestSeq: number, remoteConsumerId: string | null): boolean {
  if (requestSeq !== sessionListRequestSeq) return false;
  return (useHistoryStore.getState().remoteContext?.consumerId ?? null) === remoteConsumerId;
}

function ensureHistoryIndexListener(): Promise<void> {
  if (historyIndexListenerPromise) return historyIndexListenerPromise;
  historyIndexListenerPromise = listen<unknown>("history-index-status", (event) => {
    const next = normalizeIndexStatus(event.payload);
    const previous = useHistoryStore.getState().indexStatus;
    useHistoryStore.setState({ indexStatus: next });
    if (
      next.phase !== "ready" ||
      next.generation === previous.generation ||
      !useHistoryStore.getState().isOpen
    ) {
      return;
    }
    if (historyIndexReadyRefreshTimer !== null) window.clearTimeout(historyIndexReadyRefreshTimer);
    historyIndexReadyRefreshTimer = window.setTimeout(() => {
      historyIndexReadyRefreshTimer = null;
      const state = useHistoryStore.getState();
      void state.loadSessions().then(() => {
        const query = useHistoryStore.getState().globalQuery;
        if ([...query.trim()].length >= MIN_GLOBAL_SEARCH_CHARS) {
          return useHistoryStore.getState().runGlobalSearch(query);
        }
      }).catch((error) => {
        logWarn("history.index.readyRefreshFailed", { error: String(error) });
      });
    }, 150);
  })
    .then(() => undefined)
    .catch((error) => {
      historyIndexListenerPromise = null;
      logWarn("history.index.listenerFailed", { error: String(error) });
    });
  return historyIndexListenerPromise;
}

async function syncRemoteHistoryContext(
  context: SshAgentHistoryContext,
  options: { reset?: boolean; limit?: number } = {},
): Promise<SshAgentHistoryContext> {
  const key = JSON.stringify([
    context.consumerId,
    context.source,
    context.configuredConfigRoot,
    [...context.projectPaths].sort(),
    options.reset === true,
    options.reset ? "" : context.cursor,
    options.limit ?? SESSION_PAGE_FETCH_LIMIT,
  ]);
  const existing = remoteHistorySyncPromises.get(key);
  if (existing) return existing;
  const operationId = `remote-history:${context.consumerId}`;
  useBackgroundOperationStore.getState().start({
    id: operationId,
    kind: "remoteHistory",
    titleKey: "backgroundOperations.remoteHistory.title",
    detailKey: "backgroundOperations.remoteHistory.loading",
    contextLabel: context.projectPaths[0] ?? context.configuredConfigRoot,
    retry: () => { void syncRemoteHistoryContext(context, options).catch(() => undefined); },
  });
  const promise = (async () => {
    try {
      const result = await invoke<SshRemoteHistorySyncResult>("history_remote_sync", {
        consumerId: context.consumerId,
        sshLaunch: context.launch,
        source: context.source,
        configuredConfigRoot: context.configuredConfigRoot,
        projectPaths: context.projectPaths,
        sourceInstanceId: context.sourceInstanceId || null,
        cursor: options.reset ? null : context.cursor || null,
        limit: options.limit ?? SESSION_PAGE_FETCH_LIMIT,
      });
      await useSshAgentIntegrationStore.getState().recordHistorySource(
        context.hostId,
        context.configuredConfigRoot,
        result,
        context.scopeKind,
      );
      useBackgroundOperationStore.getState().succeed(operationId);
      return {
        ...context,
        sourceInstanceId: result.sourceInstanceId,
        cursor: result.cursor,
        generation: result.generation,
        hasMore: result.hasMore,
      };
    } catch (error) {
      useBackgroundOperationStore.getState().fail(operationId, error);
      throw error;
    }
  })().finally(() => {
    if (remoteHistorySyncPromises.get(key) === promise) remoteHistorySyncPromises.delete(key);
  });
  remoteHistorySyncPromises.set(key, promise);
  return promise;
}

export const useHistoryStore = create<HistoryStore>((set, get) => ({
  isOpen: false,
  loadingSessions: false,
  loadingMoreSessions: false,
  loadingSessionDetail: false,
  searching: false,
  loadingPrompts: false,
  loadingStats: false,
  loadingStatsProjectOptions: false,
  statsError: null,
  statsProjectOptionsError: null,
  statsUpdatedAt: null,
  statsCacheKey: null,
  sourceFilter: "all",
  projectPathFilter: null,
  scopedProjectPathFilter: null,
  sessions: [],
  hasMoreSessions: false,
  sessionListOffset: 0,
  sessionsIndexGeneration: -1,
  activeSessionKey: null,
  activeSession: null,
  globalQuery: "",
  sessionQuery: "",
  searchHits: [],
  prompts: [],
  stats: null,
  statsProjectOptions: [],
  focusedMessageIndex: null,
  focusedMessageSeq: 0,
  metaMap: {},
  focusGlobalSearchSeq: 0,
  focusSessionSearchSeq: 0,
  indexStatus: { ...DEFAULT_HISTORY_INDEX_STATUS },
  remoteContext: null,

  ensureMetaTable: async () => {
    if (historyMetaReady) return;
    if (!historyMetaInitPromise) {
      historyMetaInitPromise = (async () => {
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
        await db.execute(`
      CREATE TABLE IF NOT EXISTS session_favorite_snapshots (
        session_key   TEXT PRIMARY KEY,
        session_id    TEXT NOT NULL,
        source        TEXT NOT NULL,
        project_key   TEXT NOT NULL,
        file_path     TEXT NOT NULL,
        title         TEXT NOT NULL,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        message_count INTEGER NOT NULL,
        branch        TEXT,
        detail_json   TEXT NOT NULL,
        snapshot_at   TEXT NOT NULL
      )
        `);
        await db.execute(
      "CREATE INDEX IF NOT EXISTS idx_session_favorite_snapshots_source ON session_favorite_snapshots(source)"
        );
        await db.execute(
      "CREATE INDEX IF NOT EXISTS idx_session_favorite_snapshots_updated ON session_favorite_snapshots(updated_at DESC)"
        );
        // 与 lib.rs migration v18 同构，双保险（老库升级顺序不确定时仍可用）。
        await db.execute(`
      CREATE TABLE IF NOT EXISTS history_edit_audit (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        session_key TEXT NOT NULL,
        session_id  TEXT NOT NULL,
        source      TEXT NOT NULL,
        file_path   TEXT NOT NULL,
        op          TEXT NOT NULL,
        line_index  INTEGER,
        role        TEXT,
        before_text TEXT,
        after_text  TEXT,
        backup_path TEXT,
        created_at  INTEGER NOT NULL
      )
        `);
        await db.execute(
      "CREATE INDEX IF NOT EXISTS idx_history_edit_audit_session ON history_edit_audit(session_key, created_at DESC)"
        );
      })()
        .then(() => {
          historyMetaReady = true;
        })
        .catch((error) => {
          historyMetaInitPromise = null;
          throw error;
        });
    }
    await historyMetaInitPromise;
  },

  openHistory: async (options) => {
    const openRequestSeq = ++historyOpenRequestSeq;
    globalSearchRequestSeq += 1;
    const isCurrentOpenRequest = () => openRequestSeq === historyOpenRequestSeq;
    const nextSourceFilter = options?.sourceFilter ?? get().sourceFilter;
    const nextProjectPathFilter = options?.projectPath?.trim() || null;
    const nextScopedProjectPathFilter = options?.scopedProjectPath?.trim() || null;
    const project = options?.projectId
      ? useProjectStore.getState().projects.find((item) => item.id === options.projectId)
      : undefined;
    const nextRemoteContext = project?.environment_type === "ssh"
      ? await buildSshAgentHistoryContext(project)
      : null;
    if (!isCurrentOpenRequest()) return;
    const previousRemoteContext = get().remoteContext;
    if (previousRemoteContext && previousRemoteContext.consumerId !== nextRemoteContext?.consumerId) {
      void invoke("history_remote_close", {
        hostId: previousRemoteContext.hostId,
        consumerId: previousRemoteContext.consumerId,
      }).catch(() => undefined);
    }
    const filterChanged =
      nextSourceFilter !== get().sourceFilter ||
      nextProjectPathFilter !== get().projectPathFilter ||
      nextScopedProjectPathFilter !== get().scopedProjectPathFilter ||
      nextRemoteContext?.consumerId !== previousRemoteContext?.consumerId;
    const hasSessions = get().sessions.length > 0;
    const stopPerf = createPerfMarker("history.open", {
      sourceFilter: nextSourceFilter,
      projectPathFilter: nextProjectPathFilter ?? "__all__",
      scopedProjectPathFilter: nextScopedProjectPathFilter ?? "__none__",
      fromCache: hasSessions && !filterChanged,
    });
    set({
      isOpen: true,
      sourceFilter: nextSourceFilter,
      projectPathFilter: nextProjectPathFilter,
      scopedProjectPathFilter: nextScopedProjectPathFilter,
      remoteContext: nextRemoteContext,
    });
    try {
      if (nextRemoteContext) {
        if (nextRemoteContext.sourceInstanceId) {
          await get().loadSessions();
          if (!isCurrentOpenRequest()) return;
        }
        try {
          const synced = await syncRemoteHistoryContext(nextRemoteContext);
          if (!isCurrentOpenRequest()) {
            if (get().remoteContext?.consumerId !== nextRemoteContext.consumerId) {
              void invoke("history_remote_close", {
                hostId: nextRemoteContext.hostId,
                consumerId: nextRemoteContext.consumerId,
              }).catch(() => undefined);
            }
            return;
          }
          set({
            remoteContext: synced,
            indexStatus: {
              rootsKey: synced.sourceInstanceId,
              phase: "ready",
              indexedFiles: 0,
              totalFiles: 0,
              generation: synced.generation,
              partial: false,
              lastCompletedAt: Date.now(),
              error: null,
            },
          });
          await get().loadSessions();
        } catch (error) {
          if (!isCurrentOpenRequest()) return;
          set((state) => ({
            indexStatus: {
              ...state.indexStatus,
              rootsKey: nextRemoteContext.sourceInstanceId,
              phase: "error",
              partial: true,
              error: String(error),
            },
          }));
          if (!nextRemoteContext.sourceInstanceId) throw error;
        }
        return;
      }
      await ensureHistoryIndexListener();
      await get().loadIndexStatus();
      if (!isCurrentOpenRequest()) return;
      if (!hasSessions || filterChanged || get().sessionsIndexGeneration !== get().indexStatus.generation) {
        await get().loadSessions();
      }
    } finally {
      stopPerf({ sessionCount: get().sessions.length });
    }
  },

  closeHistory: (options) => {
    historyOpenRequestSeq += 1;
    sessionListRequestSeq += 1;
    sessionDetailRequestSeq += 1;
    globalSearchRequestSeq += 1;
    const remoteContext = get().remoteContext;
    if (remoteContext && !options?.preserveRemoteConsumer) {
      void invoke("history_remote_close", {
        hostId: remoteContext.hostId,
        consumerId: remoteContext.consumerId,
      }).catch(() => undefined);
    }
    set({
      isOpen: false,
      remoteContext: null,
      loadingSessions: false,
      loadingMoreSessions: false,
    });
  },

  toggleHistory: async () => {
    if (get().isOpen) {
      get().closeHistory();
      return;
    }
    await get().openHistory();
  },

  setSourceFilter: async (filter) => {
    globalSearchRequestSeq += 1;
    set({ sourceFilter: filter });
    await get().loadSessions();
    if (!get().globalQuery.trim()) {
      set({ searchHits: [] });
    }
  },

  setProjectPathFilter: async (projectPath) => {
    globalSearchRequestSeq += 1;
    set({ projectPathFilter: projectPath?.trim() || null, scopedProjectPathFilter: null });
    await get().loadSessions();
    if (!get().globalQuery.trim()) {
      set({ searchHits: [] });
    }
  },

  loadSessions: async () => {
    const requestSeq = ++sessionListRequestSeq;
    const remoteContext = get().remoteContext;
    const remoteConsumerId = remoteContext?.consumerId ?? null;
    const sourceFilter = get().sourceFilter;
    const projectPath = effectiveProjectPathFilter(get());
    const stopPerf = createPerfMarker("history.sessions.load", {
      sourceFilter: get().sourceFilter,
      projectPathFilter: get().projectPathFilter ?? "__all__",
      scopedProjectPathFilter: get().scopedProjectPathFilter ?? "__none__",
    });
    set({ loadingSessions: true, loadingMoreSessions: false, hasMoreSessions: false, sessionListOffset: 0 });
    try {
      await get().ensureMetaTable();
      const source = normalizeSourceFilter(sourceFilter);
      const summariesRaw = remoteContext
        ? remoteSourceMatchesFilter(remoteContext, sourceFilter) && remoteContext.sourceInstanceId
          ? await invoke<unknown[]>("history_remote_list_cached", {
            sourceInstanceId: remoteContext.sourceInstanceId,
            projectPath,
            query: null,
            limit: SESSION_PAGE_FETCH_LIMIT,
            offset: 0,
          })
          : []
        : await invoke<unknown[]>("history_list_sessions", {
          source,
          ...(await getHistoryPathArgs()),
          projectPath,
          query: null,
          limit: SESSION_PAGE_FETCH_LIMIT,
          offset: 0,
        });
      const allSummaries = (summariesRaw ?? []).map((item) => normalizeSummary(item));
      const summaries = allSummaries.slice(0, SESSION_PAGE_SIZE);
      const metaMap = await readMetaMap();
      const sessions = await applyFavoriteSnapshots(summaries, metaMap, sourceFilter, projectPath);
      if (!isCurrentSessionListRequest(requestSeq, remoteConsumerId)) return;
      const activeSessionKey = get().activeSessionKey;
      const activeExists = activeSessionKey
        ? sessions.some((item) => item.sessionKey === activeSessionKey)
        : false;
      const nextActiveKey = activeExists ? activeSessionKey : sessions[0]?.sessionKey ?? null;
      set({
        sessions,
        metaMap,
        hasMoreSessions: allSummaries.length > SESSION_PAGE_SIZE,
        sessionListOffset: summaries.length,
        sessionsIndexGeneration: get().indexStatus.generation,
        activeSessionKey: nextActiveKey,
        activeSession: activeExists ? get().activeSession : null,
        focusedMessageIndex: null,
      });
    } finally {
      if (isCurrentSessionListRequest(requestSeq, remoteConsumerId)) {
        set({ loadingSessions: false });
      }
      stopPerf({
        sessionCount: get().sessions.length,
        activeSessionKey: get().activeSessionKey,
        hasMoreSessions: get().hasMoreSessions,
      });
    }
  },

  loadMoreSessions: async () => {
    if (get().loadingSessions || get().loadingMoreSessions || !get().hasMoreSessions) return;
    const requestSeq = ++sessionListRequestSeq;
    const initialRemoteContext = get().remoteContext;
    const remoteConsumerId = initialRemoteContext?.consumerId ?? null;
    const sourceFilter = get().sourceFilter;
    const offset = get().sessionListOffset;
    const projectPath = effectiveProjectPathFilter(get());
    const stopPerf = createPerfMarker("history.sessions.load", {
      sourceFilter: get().sourceFilter,
      projectPathFilter: get().projectPathFilter ?? "__all__",
      scopedProjectPathFilter: get().scopedProjectPathFilter ?? "__none__",
      mode: "loadMore",
      offset,
    });
    set({ loadingMoreSessions: true });
    try {
      await get().ensureMetaTable();
      const source = normalizeSourceFilter(sourceFilter);
      let remoteContext = initialRemoteContext;
      if (
        remoteContext
        && remoteSourceMatchesFilter(remoteContext, sourceFilter)
        && remoteContext.hasMore
      ) {
        try {
          const previousGeneration = remoteContext.generation;
          const synced = await syncRemoteHistoryContext(remoteContext);
          if (!isCurrentSessionListRequest(requestSeq, remoteConsumerId)) return;
          remoteContext = synced;
          set({ remoteContext: synced });
          if (previousGeneration > 0 && synced.generation !== previousGeneration) {
            await get().loadSessions();
            return;
          }
        } catch (error) {
          if (!isCurrentSessionListRequest(requestSeq, remoteConsumerId)) return;
          set((state) => ({
            indexStatus: {
              ...state.indexStatus,
              phase: "error",
              partial: true,
              error: String(error),
            },
          }));
        }
      }
      const summariesRaw = remoteContext
        ? remoteSourceMatchesFilter(remoteContext, sourceFilter) && remoteContext.sourceInstanceId
          ? await invoke<unknown[]>("history_remote_list_cached", {
            sourceInstanceId: remoteContext.sourceInstanceId,
            projectPath,
            query: null,
            limit: SESSION_PAGE_FETCH_LIMIT,
            offset,
          })
          : []
        : await invoke<unknown[]>("history_list_sessions", {
          source,
          ...(await getHistoryPathArgs()),
          projectPath,
          query: null,
          limit: SESSION_PAGE_FETCH_LIMIT,
          offset,
        });
      const allSummaries = (summariesRaw ?? []).map((item) => normalizeSummary(item));
      const nextSummaries = allSummaries.slice(0, SESSION_PAGE_SIZE);
      const summaryMap = new Map<string, HistorySessionSummary>();
      const sourceSessionKeys = new Set<string>();
      for (const session of get().sessions) {
        summaryMap.set(session.sessionKey, viewToSummary(session));
        if (!session.favoriteSnapshot) {
          sourceSessionKeys.add(session.sessionKey);
        }
      }
      for (const summary of nextSummaries) {
        const key = summarySessionKey(summary);
        summaryMap.set(key, summary);
        sourceSessionKeys.add(key);
      }
      const metaMap = get().metaMap;
      const sessions = await applyFavoriteSnapshots(Array.from(summaryMap.values()), metaMap, sourceFilter, projectPath, sourceSessionKeys);
      if (!isCurrentSessionListRequest(requestSeq, remoteConsumerId)) return;
      set({
        sessions,
        hasMoreSessions: allSummaries.length > SESSION_PAGE_SIZE,
        sessionListOffset: offset + nextSummaries.length,
      });
    } finally {
      if (isCurrentSessionListRequest(requestSeq, remoteConsumerId)) {
        set({ loadingMoreSessions: false });
      }
      stopPerf({
        sessionCount: get().sessions.length,
        hasMoreSessions: get().hasMoreSessions,
      });
    }
  },

  loadIndexStatus: async () => {
    const remoteContext = get().remoteContext;
    if (remoteContext) {
      set((state) => ({
        indexStatus: {
          ...state.indexStatus,
          rootsKey: remoteContext.sourceInstanceId,
          phase: state.indexStatus.error ? "error" : "ready",
          partial: Boolean(state.indexStatus.error),
        },
      }));
      return;
    }
    try {
      const raw = await invoke<unknown>("history_get_index_status", await getHistoryPathArgs());
      set({ indexStatus: normalizeIndexStatus(raw) });
    } catch (error) {
      logWarn("history.index.statusFailed", { error: String(error) });
      set((state) => ({
        indexStatus: {
          ...state.indexStatus,
          phase: "error",
          partial: true,
          error: String(error),
        },
      }));
    }
  },

  refreshIndex: async () => {
    const remoteContext = get().remoteContext;
    if (remoteContext) {
      const synced = await syncRemoteHistoryContext(remoteContext, { reset: true });
      set({
        remoteContext: synced,
        indexStatus: {
          rootsKey: synced.sourceInstanceId,
          phase: "ready",
          indexedFiles: 0,
          totalFiles: 0,
          generation: synced.generation,
          partial: false,
          lastCompletedAt: Date.now(),
          error: null,
        },
      });
      await get().loadSessions();
      if ([...get().globalQuery.trim()].length >= MIN_GLOBAL_SEARCH_CHARS) {
        await get().runGlobalSearch(get().globalQuery);
      }
      return;
    }
    await ensureHistoryIndexListener();
    const raw = await invoke<unknown>("history_refresh_index", {
      ...(await getHistoryPathArgs()),
      wait: true,
    });
    if (historyIndexReadyRefreshTimer !== null) {
      window.clearTimeout(historyIndexReadyRefreshTimer);
      historyIndexReadyRefreshTimer = null;
    }
    set({ indexStatus: normalizeIndexStatus(raw) });
    await get().loadSessions();
    const query = get().globalQuery;
    if ([...query.trim()].length >= MIN_GLOBAL_SEARCH_CHARS) {
      await get().runGlobalSearch(query);
    }
  },

  addConvertedSession: (summary) => {
    const normalized = normalizeSummary(summary);
    const sessionKey = summarySessionKey(normalized);
    const nextView = toView(normalized, get().metaMap[sessionKey]);
    set((state) => ({
      sessions: sortSessionViews([
        nextView,
        ...state.sessions.filter((item) => item.sessionKey !== sessionKey),
      ]),
      sourceFilter:
        state.sourceFilter !== "all" && state.sourceFilter !== normalized.source
          ? "all"
          : state.sourceFilter,
      activeSessionKey: sessionKey,
      focusedMessageIndex: null,
    }));
    return sessionKey;
  },

  openSession: async (sessionKey) => {
    const requestSeq = ++sessionDetailRequestSeq;
    const stopPerf = createPerfMarker("history.session.detail", { sessionKey });
    const target = get().sessions.find((item) => item.sessionKey === sessionKey);
    if (!target) {
      stopPerf({ skipped: true, reason: "missing-target" });
      return;
    }
    set({ activeSessionKey: sessionKey, loadingSessionDetail: true, focusedMessageIndex: null });
    try {
      try {
        const remoteContext = get().remoteContext;
        const detailRaw = target.session_ref?.transportKind === "ssh"
          ? remoteContext && remoteContext.sourceInstanceId === target.session_ref.sourceInstanceId
            ? await invoke<unknown>("history_remote_get_session", {
              consumerId: remoteContext.consumerId,
              sshLaunch: remoteContext.launch,
              source: remoteContext.source,
              configuredConfigRoot: remoteContext.configuredConfigRoot,
              projectPaths: remoteContext.projectPaths,
              sourceInstanceId: target.session_ref.sourceInstanceId,
              sourceSessionId: target.session_ref.sourceSessionId,
              remoteTranscriptRef: null,
            })
            : await Promise.reject(new Error("history_remote_online_required"))
          : await invoke<unknown>("history_get_session", {
            filePath: target.file_path,
            ...(await getHistoryPathArgs()),
            source: target.source,
            projectKey: target.project_key,
          });
        const detail = normalizeDetail(detailRaw);
        if (requestSeq === sessionDetailRequestSeq) set({ activeSession: detail });
      } catch (err) {
        const snapshot = await readFavoriteSnapshotDetail(sessionKey);
        if (!snapshot) throw err;
        logWarn("history.favoriteSnapshot.fallback", { sessionKey, error: String(err) });
        if (requestSeq === sessionDetailRequestSeq) set({ activeSession: snapshot });
      }
    } finally {
      if (requestSeq === sessionDetailRequestSeq) set({ loadingSessionDetail: false });
      stopPerf({
        messageCount: get().activeSession?.messages.length ?? 0,
      });
    }
  },

  openSearchHit: async (hit) => {
    const requestSeq = ++sessionDetailRequestSeq;
    const sessionKey = hitSessionKey(hit);
    const stopPerf = createPerfMarker("history.session.detail", { sessionKey, fromSearch: true });
    set({ activeSessionKey: sessionKey, loadingSessionDetail: true, focusedMessageIndex: null });
    try {
      const remoteContext = get().remoteContext;
      const detailRaw = hit.session_ref?.transportKind === "ssh"
        ? remoteContext && remoteContext.sourceInstanceId === hit.session_ref.sourceInstanceId
          ? await invoke<unknown>("history_remote_get_session", {
            consumerId: remoteContext.consumerId,
            sshLaunch: remoteContext.launch,
            source: remoteContext.source,
            configuredConfigRoot: remoteContext.configuredConfigRoot,
            projectPaths: remoteContext.projectPaths,
            sourceInstanceId: hit.session_ref.sourceInstanceId,
            sourceSessionId: hit.session_ref.sourceSessionId,
            remoteTranscriptRef: null,
          })
          : await Promise.reject(new Error("history_remote_online_required"))
        : await invoke<unknown>("history_get_session", {
          filePath: hit.file_path,
          ...(await getHistoryPathArgs()),
          source: hit.source,
          projectKey: hit.project_key,
        });
      const detail = normalizeDetail(detailRaw);
      const exists = get().sessions.some((item) => item.sessionKey === sessionKey);
      if (exists) {
        if (requestSeq !== sessionDetailRequestSeq) return;
        set({ activeSession: detail });
        return;
      }

      const summary: HistorySessionSummary = {
        session_id: hit.session_id,
        source: hit.source,
        project_key: hit.project_key,
        title: detail.title,
        file_path: hit.file_path,
        created_at: detail.created_at,
        updated_at: detail.updated_at,
        message_count: detail.message_count,
        branch: detail.branch,
        session_ref: hit.session_ref,
        materialization_level: detail.materialization_level,
        freshness_state: detail.freshness_state,
        as_of: detail.as_of,
        remote_identity: detail.remote_identity,
        read_only: hit.read_only,
      };
      const metaMap = get().metaMap;
      const summaries = [...get().sessions.map((item) => viewToSummary(item)), summary];
      if (requestSeq !== sessionDetailRequestSeq) return;
      set({
        activeSession: detail,
        sessions: applyMeta(summaries, metaMap),
      });
    } finally {
      if (requestSeq === sessionDetailRequestSeq) set({ loadingSessionDetail: false });
      stopPerf({
        messageCount: get().activeSession?.messages.length ?? 0,
      });
    }
  },

  deleteSession: async (sessionKey) => {
    const target = get().sessions.find((item) => item.sessionKey === sessionKey);
    if (!target) return;
    if (target.session_ref?.transportKind === "ssh" || target.read_only) {
      throw new Error("history_remote_read_only");
    }

    if (!target.favoriteSnapshot) {
      await invoke("history_delete_session", {
        filePath: target.file_path,
        ...(await getHistoryPathArgs()),
        source: target.source,
        projectKey: target.project_key,
      });
    }

    const db = await getDb();
    await db.execute("DELETE FROM session_meta WHERE session_key = $1", [sessionKey]);
    await deleteFavoriteSnapshot(sessionKey);

    const sessions = get().sessions.filter((item) => item.sessionKey !== sessionKey);
    const metaMap = { ...get().metaMap };
    delete metaMap[sessionKey];
    const activeWasDeleted = get().activeSessionKey === sessionKey;
    const nextActiveKey = activeWasDeleted ? sessions[0]?.sessionKey ?? null : get().activeSessionKey;
    set({
      sessions,
      metaMap,
      activeSessionKey: nextActiveKey,
      activeSession: activeWasDeleted ? null : get().activeSession,
      searchHits: get().searchHits.filter((hit) => hitSessionKey(hit) !== sessionKey),
      focusedMessageIndex: null,
    });
    if (nextActiveKey && activeWasDeleted) {
      await get().openSession(nextActiveKey);
    }
  },

  setGlobalQuery: (query) => {
    globalSearchRequestSeq += 1;
    set({ globalQuery: query });
  },

  runGlobalSearch: async (query) => {
    const normalized = query.trim();
    const requestSeq = ++globalSearchRequestSeq;
    set({ globalQuery: query });
    if ([...normalized].length < MIN_GLOBAL_SEARCH_CHARS) {
      set({ searchHits: [], searching: false });
      return;
    }

    const stopPerf = createPerfMarker("history.search", {
      queryLength: [...normalized].length,
      sourceFilter: get().sourceFilter,
      projectPathFilter: effectiveProjectPathFilter(get()) ?? "__all__",
    });
    set({ searching: true });
    try {
      const source = normalizeSourceFilter(get().sourceFilter);
      const remoteContext = get().remoteContext;
      let hitsRaw: unknown[];
      if (remoteContext) {
        if (!remoteContext.sourceInstanceId || !remoteSourceMatchesFilter(remoteContext, get().sourceFilter)) {
          hitsRaw = [];
        } else {
          try {
            hitsRaw = await invoke<unknown[]>("history_remote_search", {
              consumerId: remoteContext.consumerId,
              sshLaunch: remoteContext.launch,
              source: remoteContext.source,
              configuredConfigRoot: remoteContext.configuredConfigRoot,
              projectPaths: remoteContext.projectPaths,
              sourceInstanceId: remoteContext.sourceInstanceId,
              query: normalized,
              limit: DEFAULT_SEARCH_LIMIT,
            });
          } catch (error) {
            const cached = await invoke<unknown[]>("history_remote_list_cached", {
              sourceInstanceId: remoteContext.sourceInstanceId,
              projectPath: effectiveProjectPathFilter(get()),
              query: normalized,
              limit: DEFAULT_SEARCH_LIMIT,
              offset: 0,
            });
            hitsRaw = cached.map((item) => {
              const summary = normalizeSummary(item);
              return {
                sessionId: summary.session_id,
                source: summary.source,
                projectKey: summary.project_key,
                title: summary.title,
                filePath: "",
                role: "cachedSummary",
                snippet: summary.title,
                timestamp: null,
                sessionRef: summary.session_ref,
                readOnly: true,
              };
            });
            set((state) => ({
              indexStatus: {
                ...state.indexStatus,
                phase: "error",
                partial: true,
                error: String(error),
              },
            }));
          }
        }
      } else {
        hitsRaw = await invoke<unknown[]>("history_search", {
          query: normalized,
          source,
          ...(await getHistoryPathArgs()),
          projectPath: effectiveProjectPathFilter(get()),
          limit: DEFAULT_SEARCH_LIMIT,
        });
      }
      const hits = (hitsRaw ?? []).map((item) => normalizeHit(item));
      if (requestSeq === globalSearchRequestSeq) {
        set({ searchHits: hits });
      }
    } catch (error) {
      if (requestSeq === globalSearchRequestSeq) {
        set((state) => ({
          searchHits: [],
          indexStatus: {
            ...state.indexStatus,
            phase: "error",
            partial: true,
            error: String(error),
          },
        }));
      }
      logWarn("history.search.failed", { error: String(error) });
    } finally {
      if (requestSeq === globalSearchRequestSeq) {
        set({ searching: false });
      }
      stopPerf({ hitCount: get().searchHits.length, stale: requestSeq !== globalSearchRequestSeq });
    }
  },

  setSessionQuery: (query) => {
    set({ sessionQuery: query });
  },

  loadPrompts: async ({ scope, query, projectKey, sessionKey, limit }) => {
    set({ loadingPrompts: true });
    try {
      const source = normalizeSourceFilter(get().sourceFilter);
      const session = sessionKey
        ? get().sessions.find((item) => item.sessionKey === sessionKey) ?? null
        : null;
      const promptsRaw = await invoke<unknown[]>("history_list_prompts", {
        scope,
        source,
        ...(await getHistoryPathArgs()),
        query: query?.trim() || null,
        projectKey: projectKey?.trim() || null,
        filePath: session?.file_path ?? null,
        limit: limit ?? 300,
      });
      const prompts = (promptsRaw ?? []).map((item) => normalizePrompt(item));
      set({ prompts });
    } finally {
      set({ loadingPrompts: false });
    }
  },

  loadStatsProjectOptions: async (options) => {
    const force = options?.force ?? false;
    const sourceFilter = get().sourceFilter;
    await ensureHistorySourceSettingsLoaded();
    const historyPathKey = getHistoryPathCacheKey();
    const cacheKey = makeStatsProjectOptionsCacheKey(sourceFilter, historyPathKey);
    const now = Date.now();
    const cached = statsProjectOptionsCacheGet(cacheKey);

    if (!force && cached && now - cached.cachedAt <= STATS_CACHE_TTL_MS) {
      set({
        statsProjectOptions: cached.options,
        statsProjectOptionsError: null,
      });
      return cached.options;
    }

    set({ loadingStatsProjectOptions: true, statsProjectOptionsError: null });
    try {
      const projectOptions = await fetchHistoryStatsProjectOptions(sourceFilter);
      statsProjectOptionsCacheSet(cacheKey, {
        options: projectOptions,
        cachedAt: Date.now(),
      });
      set({
        statsProjectOptions: projectOptions,
        statsProjectOptionsError: null,
      });
      return projectOptions;
    } catch (err) {
      set({ statsProjectOptions: [], statsProjectOptionsError: String(err) });
      throw err;
    } finally {
      set({ loadingStatsProjectOptions: false });
    }
  },

  loadStats: async (options) => {
    const projectKey = options?.projectKey?.trim() || null;
    const projectPath = options?.projectPath?.trim() || null;
    const rangeDays = options?.rangeDays ?? 30;
    const startAt = typeof options?.startAt === "number" && Number.isFinite(options.startAt) ? options.startAt : null;
    const endAt = typeof options?.endAt === "number" && Number.isFinite(options.endAt) ? options.endAt : null;
    const force = options?.force ?? false;
    const sourceFilter = get().sourceFilter;
    await ensureHistorySourceSettingsLoaded();
    const historyPathKey = getHistoryPathCacheKey();
    const timeKey = makeStatsTimeKey(rangeDays, startAt, endAt);
    const cacheKey = makeStatsCacheKey(sourceFilter, projectKey, projectPath, timeKey, historyPathKey);
    const now = Date.now();
    const cached = statsCacheGet(cacheKey);
    const activeStats = get().stats;
    const activeStatsUpdatedAt = get().statsUpdatedAt;
    const activeCacheKey = get().statsCacheKey;
    const requestSeq = ++statsRequestSeq;
    const isLatestRequest = () => statsRequestSeq === requestSeq && get().statsCacheKey === cacheKey;
    const stopPerf = createPerfMarker("stats.load", {
      sourceFilter,
      projectKey: projectKey ?? "__all__",
      projectPath: projectPath ?? "__all__",
      rangeDays,
      startAt: startAt ?? "__range__",
      endAt: endAt ?? "__range__",
    });

    if (!force && cached) {
      const cacheIsFresh = now - cached.cachedAt <= STATS_CACHE_TTL_MS;
      set({
        loadingStats: !cacheIsFresh,
        stats: cached.payload,
        statsError: null,
        statsUpdatedAt: cached.cachedAt,
        statsCacheKey: cacheKey,
      });
      if (cacheIsFresh) {
        stopPerf({
          cacheHit: true,
          heatmapDays: cached.payload.heatmap.length,
        });
        return;
      }
    } else if (
      !force &&
      activeStats &&
      activeCacheKey === cacheKey &&
      activeStatsUpdatedAt &&
      now - activeStatsUpdatedAt <= STATS_CACHE_TTL_MS
    ) {
      set({ loadingStats: false, statsError: null, statsCacheKey: cacheKey });
      stopPerf({
        cacheHit: true,
        heatmapDays: activeStats.heatmap.length,
      });
      return;
    }

    const canKeepVisibleStats = activeStats !== null && activeCacheKey === cacheKey;
    const visibleStats = canKeepVisibleStats ? activeStats : !force && cached ? cached.payload : null;
    const visibleStatsUpdatedAt = canKeepVisibleStats
      ? activeStatsUpdatedAt
      : !force && cached
        ? cached.cachedAt
        : null;
    set({
      loadingStats: true,
      statsError: null,
      stats: visibleStats,
      statsUpdatedAt: visibleStatsUpdatedAt,
      statsCacheKey: cacheKey,
    });
    try {
      const payload = await fetchHistoryStatsPayload({
        sourceFilter,
        projectKey,
        projectPath,
        rangeDays,
        startAt,
        endAt,
        force,
      });
      const cachedAt = Date.now();
      statsCacheSet(cacheKey, {
        payload,
        cachedAt,
      });
      const isCurrent = isLatestRequest();
      if (isCurrent) {
        set({
          stats: payload,
          statsError: null,
          statsUpdatedAt: cachedAt,
          statsCacheKey: cacheKey,
        });
      }
      stopPerf({
        cacheHit: false,
        heatmapDays: payload.heatmap.length,
        ignored: !isCurrent,
      });
    } catch (err) {
      if (isLatestRequest()) {
        set({ statsError: String(err) });
      }
      stopPerf({
        cacheHit: false,
        error: String(err),
      });
      throw err;
    } finally {
      if (isLatestRequest()) {
        set({ loadingStats: false });
      }
    }
  },

  openSessionAtMessage: async (sessionKey, messageIndex) => {
    if (get().activeSessionKey !== sessionKey) {
      await get().openSession(sessionKey);
    }
    const normalizedIndex = Number.isFinite(messageIndex) && messageIndex >= 0 ? messageIndex : 0;
    set((state) => ({
      focusedMessageIndex: normalizedIndex,
      focusedMessageSeq: state.focusedMessageSeq + 1,
    }));
  },

  clearFocusedMessage: () => {
    set({ focusedMessageIndex: null });
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
    const snapshotDetail = patch.starred === true
      ? await loadDetailForSnapshot(sessionKey, session)
      : null;

    const db = await getDb();
    if (snapshotDetail) {
      await writeFavoriteSnapshot(sessionKey, snapshotDetail);
    }
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
    if (patch.starred === false) {
      await deleteFavoriteSnapshot(sessionKey);
    }

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
    const sourceSessionKeys = new Set<string>();
    const visibleSessions = get().sessions.filter((item) => !(patch.starred === false && item.sessionKey === sessionKey && item.favoriteSnapshot));
    const summaries: HistorySessionSummary[] = visibleSessions.map((item) => {
      if (!item.favoriteSnapshot) {
        sourceSessionKeys.add(item.sessionKey);
      }
      return {
        session_id: item.session_id,
        source: item.source,
        project_key: item.project_key,
        title: item.title,
        file_path: item.file_path,
        created_at: item.created_at,
        updated_at: item.updated_at,
        message_count: item.message_count,
        branch: item.branch,
      };
    });
    const sessions = await applyFavoriteSnapshots(summaries, nextMetaMap, get().sourceFilter, effectiveProjectPathFilter(get()), sourceSessionKeys);
    set({ metaMap: nextMetaMap, sessions });
  },

  updateMessage: async (sessionKey, message, newText) => {
    const { target, active } = requireActiveEditContext(sessionKey);
    const { lineIndex, expectedText } = requireMessageLocator(message);
    try {
      const raw = await invoke<unknown>("history_update_message", {
        filePath: active.file_path,
        ...(await getHistoryPathArgs()),
        source: active.source,
        projectKey: active.project_key,
        lineIndex,
        expectedRole: message.role,
        expectedText,
        newText,
        expectedUpdatedAt: active.updated_at,
      });
      await finalizeEditOutcome({
        sessionKey,
        target,
        op: "edit",
        lineIndex,
        role: message.role,
        outcome: normalizeEditOutcome(raw),
      });
    } catch (err) {
      await reloadAfterEditConflict(sessionKey, err);
    }
  },

  deleteMessage: async (sessionKey, message) => {
    const { target, active } = requireActiveEditContext(sessionKey);
    const { lineIndex, expectedText } = requireMessageLocator(message);
    try {
      const raw = await invoke<unknown>("history_delete_message", {
        filePath: active.file_path,
        ...(await getHistoryPathArgs()),
        source: active.source,
        projectKey: active.project_key,
        lineIndex,
        expectedRole: message.role,
        expectedText,
        expectedUpdatedAt: active.updated_at,
      });
      await finalizeEditOutcome({
        sessionKey,
        target,
        op: "delete",
        lineIndex,
        role: message.role,
        outcome: normalizeEditOutcome(raw),
      });
    } catch (err) {
      await reloadAfterEditConflict(sessionKey, err);
    }
  },

  deleteMessages: async (sessionKey, messages) => {
    const { target, active } = requireActiveEditContext(sessionKey);
    const targets = messages.map((message) => {
      const { lineIndex, expectedText } = requireMessageLocator(message);
      return { lineIndex, expectedRole: message.role, expectedText };
    });
    if (targets.length === 0) return;
    try {
      const raw = await invoke<unknown>("history_delete_messages", {
        filePath: active.file_path,
        ...(await getHistoryPathArgs()),
        source: active.source,
        projectKey: active.project_key,
        targets,
        expectedUpdatedAt: active.updated_at,
      });
      const outcome = normalizeBatchDeleteOutcome(raw);
      await applyEditedDetail(sessionKey, target, outcome.detail);
      for (const removed of outcome.removed) {
        try {
          await insertEditAuditRecord({
            sessionKey,
            sessionId: outcome.detail.session_id,
            source: outcome.detail.source,
            filePath: outcome.detail.file_path,
            op: "delete",
            lineIndex: removed.lineIndex,
            role: removed.role || null,
            beforeText: removed.text || null,
            afterText: null,
            backupPath: outcome.backupPath,
          });
        } catch (err) {
          logWarn("history.edit.auditWriteFailed", { sessionKey, op: "delete", error: String(err) });
        }
      }
    } catch (err) {
      await reloadAfterEditConflict(sessionKey, err);
    }
  },

  insertMessage: async (sessionKey, afterMessage, role, text) => {
    const { target, active } = requireActiveEditContext(sessionKey);
    const { lineIndex } = requireMessageLocator(afterMessage);
    try {
      const raw = await invoke<unknown>("history_insert_message", {
        filePath: active.file_path,
        ...(await getHistoryPathArgs()),
        source: active.source,
        projectKey: active.project_key,
        afterLineIndex: lineIndex,
        role,
        text,
        expectedUpdatedAt: active.updated_at,
      });
      await finalizeEditOutcome({
        sessionKey,
        target,
        op: "insert",
        lineIndex,
        role,
        outcome: normalizeEditOutcome(raw),
      });
    } catch (err) {
      await reloadAfterEditConflict(sessionKey, err);
    }
  },

  reinsertMessage: async (sessionKey, lineIndexHint, role, text) => {
    const { target, active } = requireActiveEditContext(sessionKey);
    try {
      const raw = await invoke<unknown>("history_reinsert_message", {
        filePath: active.file_path,
        ...(await getHistoryPathArgs()),
        source: active.source,
        projectKey: active.project_key,
        lineIndexHint,
        role,
        text,
        expectedUpdatedAt: active.updated_at,
      });
      await finalizeEditOutcome({
        sessionKey,
        target,
        op: "insert",
        lineIndex: lineIndexHint,
        role,
        outcome: normalizeEditOutcome(raw),
      });
    } catch (err) {
      await reloadAfterEditConflict(sessionKey, err);
    }
  },

  restoreSessionBackup: async (sessionKey) => {
    const { target, active } = requireActiveEditContext(sessionKey);
    const raw = await invoke<unknown>("history_restore_session_backup", {
      filePath: active.file_path,
      ...(await getHistoryPathArgs()),
      source: active.source,
      projectKey: active.project_key,
    });
    await finalizeEditOutcome({
      sessionKey,
      target,
      op: "restore",
      lineIndex: null,
      role: null,
      outcome: normalizeEditOutcome(raw),
    });
  },

  fetchBackupStatus: async (sessionKey) => {
    const { active } = requireActiveEditContext(sessionKey);
    const raw = await invoke<unknown>("history_get_backup_status", {
      filePath: active.file_path,
      ...(await getHistoryPathArgs()),
      source: active.source,
      projectKey: active.project_key,
    });
    return normalizeBackupStatus(raw);
  },

  listEditAudit: async (sessionKey, limit) => {
    await get().ensureMetaTable();
    const db = await getDb();
    return db.select<HistoryEditAuditEntry[]>(
      `SELECT * FROM history_edit_audit
       WHERE session_key = $1
       ORDER BY created_at DESC, id DESC
       LIMIT $2`,
      [sessionKey, limit ?? 200]
    );
  },

  triggerGlobalSearchFocus: () => {
    set((state) => ({ focusGlobalSearchSeq: state.focusGlobalSearchSeq + 1 }));
  },

  triggerSessionSearchFocus: () => {
    set((state) => ({ focusSessionSearchSeq: state.focusSessionSearchSeq + 1 }));
  },
}));
