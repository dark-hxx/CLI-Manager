import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { getDb } from "../lib/db";
import { createPerfMarker } from "../lib/logger";
import { useSettingsStore } from "./settingsStore";
import type {
  HistoryPromptItem,
  HistorySearchHit,
  HistorySessionDetail,
  HistorySessionSummary,
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
  HistoryToolCount,
  PromptScope,
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

interface OpenHistoryOptions {
  sourceFilter?: HistorySourceFilter;
  projectPath?: string | null;
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
  sessions: HistorySessionView[];
  hasMoreSessions: boolean;
  sessionListOffset: number;
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
  ensureMetaTable: () => Promise<void>;
  openHistory: (options?: OpenHistoryOptions) => Promise<void>;
  closeHistory: () => void;
  toggleHistory: () => Promise<void>;
  setSourceFilter: (filter: HistorySourceFilter) => Promise<void>;
  setProjectPathFilter: (projectPath: string | null) => Promise<void>;
  loadSessions: () => Promise<void>;
  loadMoreSessions: () => Promise<void>;
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
    rangeDays?: number;
    startAt?: number | null;
    endAt?: number | null;
    force?: boolean;
  }) => Promise<void>;
  openSessionAtMessage: (sessionKey: string, messageIndex: number) => Promise<void>;
  clearFocusedMessage: () => void;
  updateMeta: (sessionKey: string, patch: MetaPatchInput) => Promise<void>;
  triggerGlobalSearchFocus: () => void;
  triggerSessionSearchFocus: () => void;
}

const SESSION_PAGE_SIZE = 100;
const SESSION_PAGE_FETCH_LIMIT = SESSION_PAGE_SIZE + 1;
const DEFAULT_SEARCH_LIMIT = 120;
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

const statsCache = new Map<string, StatsCacheEntry>();
const statsProjectOptionsCache = new Map<string, StatsProjectOptionsCacheEntry>();
let statsRequestSeq = 0;

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
      model: asString(m.model ?? "") || undefined,
      input_tokens: asNumber(m.input_tokens ?? m.inputTokens),
      output_tokens: asNumber(m.output_tokens ?? m.outputTokens),
      cache_creation_tokens: asNumber(m.cache_creation_tokens ?? m.cacheCreationTokens),
      cache_read_tokens: asNumber(m.cache_read_tokens ?? m.cacheReadTokens),
    };
  });
  return {
    ...summary,
    usage: normalizeSessionUsage(rec.usage),
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
    context_window: asNumber(rec.context_window ?? rec.contextWindow) || null,
    last_context_tokens: asNumber(rec.last_context_tokens ?? rec.lastContextTokens) || null,
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

function normalizeSourceFilter(filter: HistorySourceFilter): HistorySource | null {
  if (filter === "all") return null;
  return filter;
}

function getHistoryPathArgs(): { claudeConfigDir: string | null; codexConfigDir: string | null } {
  const settings = useSettingsStore.getState();
  return {
    claudeConfigDir: settings.claudeHookConfigDir?.trim() || null,
    codexConfigDir: settings.codexHookConfigDir?.trim() || null,
  };
}

export interface TodayProjectStats {
  sessions: number;
  totalTokens: number;
  totalCostUsd: number;
}

// 供终端统计面板使用：按项目路径取最近一次 CLI 会话详情，不改动历史工作区的选中状态。
// source 非空时只匹配对应 CLI（claude/codex），供按终端工具区分的场景使用。
// 传入 prev（上次结果的 file_path/updated_at）时，若最近会话未变化则返回 "unchanged"，
// 跳过整个 jsonl 的重新解析，供轮询场景使用。
export async function fetchLatestProjectSessionDetail(
  projectPath: string,
  prev?: { filePath: string; updatedAt: number },
  source?: HistorySource | null,
  cliSessionId?: string | null
): Promise<HistorySessionDetail | "unchanged" | null> {
  try {
    const loadSummary = async (query: string | null): Promise<HistorySessionSummary | null> => {
      const summariesRaw = await invoke<unknown[]>("history_list_sessions", {
        source: source ?? null,
        ...getHistoryPathArgs(),
        projectPath,
        query,
        limit: 1,
        offset: 0,
      });
      return (summariesRaw ?? []).map((item) => normalizeSummary(item))[0] ?? null;
    };
    const sessionQuery = cliSessionId?.trim() || null;
    // 有 CLI 会话 ID 时优先按该会话查找；命中不到时回退项目最近会话，
    // 让会话信息卡/今日用量等「非 token 类」数据仍能正常展示。
    // token 类卡片的串显由调用方按 session_id 与 cliSessionId 比对门控，
    // 此处回退不会造成 token 数据泄漏。
    const summary = (sessionQuery ? await loadSummary(sessionQuery) : null) ?? await loadSummary(null);
    if (!summary) return null;
    if (prev && summary.file_path === prev.filePath && summary.updated_at === prev.updatedAt) {
      return "unchanged";
    }
    const detailRaw = await invoke<unknown>("history_get_session", {
      filePath: summary.file_path,
      ...getHistoryPathArgs(),
      source: summary.source,
      projectKey: summary.project_key,
    });
    return normalizeDetail(detailRaw);
  } catch {
    return prev ? "unchanged" : null;
  }
}

export async function fetchTodayProjectStats(
  projectKey: string,
  source?: HistorySource | null
): Promise<TodayProjectStats | null> {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  try {
    const raw = await invoke<unknown>("history_get_stats", {
      source: source ?? null,
      ...getHistoryPathArgs(),
      projectKey,
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
    };
  } catch {
    return null;
  }
}

function getHistoryPathCacheKey(): string {
  const { claudeConfigDir, codexConfigDir } = getHistoryPathArgs();
  return `${claudeConfigDir ?? "__default__"}|${codexConfigDir ?? "__default__"}`;
}

function makeSessionKey(source: HistorySource, sessionId: string, filePath: string): string {
  return `${source}:${sessionId}:${filePath}`;
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
  timeKey: string,
  historyPathKey: string
): string {
  return `${source}|${projectKey ?? "__all__"}|${timeKey}|${historyPathKey}`;
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

function viewToSummary(view: HistorySessionView): HistorySessionSummary {
  return {
    session_id: view.session_id,
    source: view.source,
    project_key: view.project_key,
    title: view.title,
    file_path: view.file_path,
    created_at: view.created_at,
    updated_at: view.updated_at,
    message_count: view.message_count,
    branch: view.branch,
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
  sessions: [],
  hasMoreSessions: false,
  sessionListOffset: 0,
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

  openHistory: async (options) => {
    const nextSourceFilter = options?.sourceFilter ?? get().sourceFilter;
    const nextProjectPathFilter = options?.projectPath?.trim() || null;
    const filterChanged = nextSourceFilter !== get().sourceFilter || nextProjectPathFilter !== get().projectPathFilter;
    const hasSessions = get().sessions.length > 0;
    const stopPerf = createPerfMarker("history.open", {
      sourceFilter: nextSourceFilter,
      projectPathFilter: nextProjectPathFilter ?? "__all__",
      fromCache: hasSessions && !filterChanged,
    });
    set({ isOpen: true, sourceFilter: nextSourceFilter, projectPathFilter: nextProjectPathFilter });
    try {
      if (!hasSessions || filterChanged) {
        await get().loadSessions();
      }
    } finally {
      stopPerf({ sessionCount: get().sessions.length });
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
    if (!get().globalQuery.trim()) {
      set({ searchHits: [] });
    }
  },

  setProjectPathFilter: async (projectPath) => {
    set({ projectPathFilter: projectPath?.trim() || null });
    await get().loadSessions();
    if (!get().globalQuery.trim()) {
      set({ searchHits: [] });
    }
  },

  loadSessions: async () => {
    const stopPerf = createPerfMarker("history.sessions.load", {
      sourceFilter: get().sourceFilter,
      projectPathFilter: get().projectPathFilter ?? "__all__",
    });
    set({ loadingSessions: true, loadingMoreSessions: false, hasMoreSessions: false, sessionListOffset: 0 });
    try {
      await get().ensureMetaTable();
      const source = normalizeSourceFilter(get().sourceFilter);
      const historyPathArgs = getHistoryPathArgs();
      const summariesRaw = await invoke<unknown[]>("history_list_sessions", {
        source,
        ...historyPathArgs,
        projectPath: get().projectPathFilter,
        query: null,
        limit: SESSION_PAGE_FETCH_LIMIT,
        offset: 0,
      });
      const allSummaries = (summariesRaw ?? []).map((item) => normalizeSummary(item));
      const summaries = allSummaries.slice(0, SESSION_PAGE_SIZE);
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
        hasMoreSessions: allSummaries.length > SESSION_PAGE_SIZE,
        sessionListOffset: summaries.length,
        activeSessionKey: nextActiveKey,
        activeSession: activeExists ? get().activeSession : null,
        focusedMessageIndex: null,
      });
      if (nextActiveKey && !activeExists) {
        await get().openSession(nextActiveKey);
      }
    } finally {
      set({ loadingSessions: false });
      stopPerf({
        sessionCount: get().sessions.length,
        activeSessionKey: get().activeSessionKey,
        hasMoreSessions: get().hasMoreSessions,
      });
    }
  },

  loadMoreSessions: async () => {
    if (get().loadingSessions || get().loadingMoreSessions || !get().hasMoreSessions) return;
    const offset = get().sessionListOffset;
    const stopPerf = createPerfMarker("history.sessions.load", {
      sourceFilter: get().sourceFilter,
      projectPathFilter: get().projectPathFilter ?? "__all__",
      mode: "loadMore",
      offset,
    });
    set({ loadingMoreSessions: true });
    try {
      await get().ensureMetaTable();
      const source = normalizeSourceFilter(get().sourceFilter);
      const historyPathArgs = getHistoryPathArgs();
      const summariesRaw = await invoke<unknown[]>("history_list_sessions", {
        source,
        ...historyPathArgs,
        projectPath: get().projectPathFilter,
        query: null,
        limit: SESSION_PAGE_FETCH_LIMIT,
        offset,
      });
      const allSummaries = (summariesRaw ?? []).map((item) => normalizeSummary(item));
      const nextSummaries = allSummaries.slice(0, SESSION_PAGE_SIZE);
      const summaryMap = new Map<string, HistorySessionSummary>();
      for (const session of get().sessions) {
        summaryMap.set(session.sessionKey, viewToSummary(session));
      }
      for (const summary of nextSummaries) {
        summaryMap.set(makeSessionKey(summary.source, summary.session_id, summary.file_path), summary);
      }
      const metaMap = await readMetaMap();
      const sessions = applyMeta(Array.from(summaryMap.values()), metaMap);
      set({
        sessions,
        metaMap,
        hasMoreSessions: allSummaries.length > SESSION_PAGE_SIZE,
        sessionListOffset: offset + nextSummaries.length,
      });
    } finally {
      set({ loadingMoreSessions: false });
      stopPerf({
        sessionCount: get().sessions.length,
        hasMoreSessions: get().hasMoreSessions,
      });
    }
  },

  openSession: async (sessionKey) => {
    const stopPerf = createPerfMarker("history.session.detail", { sessionKey });
    const target = get().sessions.find((item) => item.sessionKey === sessionKey);
    if (!target) {
      stopPerf({ skipped: true, reason: "missing-target" });
      return;
    }
    set({ activeSessionKey: sessionKey, loadingSessionDetail: true, focusedMessageIndex: null });
    try {
      const detailRaw = await invoke<unknown>("history_get_session", {
        filePath: target.file_path,
        ...getHistoryPathArgs(),
        source: target.source,
        projectKey: target.project_key,
      });
      const detail = normalizeDetail(detailRaw);
      set({ activeSession: detail });
    } finally {
      set({ loadingSessionDetail: false });
      stopPerf({
        messageCount: get().activeSession?.messages.length ?? 0,
      });
    }
  },

  openSearchHit: async (hit) => {
    const sessionKey = makeSessionKey(hit.source, hit.session_id, hit.file_path);
    const stopPerf = createPerfMarker("history.session.detail", { sessionKey, fromSearch: true });
    set({ activeSessionKey: sessionKey, loadingSessionDetail: true, focusedMessageIndex: null });
    try {
      const detailRaw = await invoke<unknown>("history_get_session", {
        filePath: hit.file_path,
        ...getHistoryPathArgs(),
        source: hit.source,
        projectKey: hit.project_key,
      });
      const detail = normalizeDetail(detailRaw);
      const exists = get().sessions.some((item) => item.sessionKey === sessionKey);
      if (exists) {
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
      };
      const metaMap = get().metaMap;
      const summaries = [...get().sessions.map((item) => viewToSummary(item)), summary];
      set({
        activeSession: detail,
        sessions: applyMeta(summaries, metaMap),
      });
    } finally {
      set({ loadingSessionDetail: false });
      stopPerf({
        messageCount: get().activeSession?.messages.length ?? 0,
      });
    }
  },

  deleteSession: async (sessionKey) => {
    const target = get().sessions.find((item) => item.sessionKey === sessionKey);
    if (!target) return;

    await invoke("history_delete_session", {
      filePath: target.file_path,
      ...getHistoryPathArgs(),
      source: target.source,
      projectKey: target.project_key,
    });

    const db = await getDb();
    await db.execute("DELETE FROM session_meta WHERE session_key = $1", [sessionKey]);

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
      searchHits: get().searchHits.filter((hit) => makeSessionKey(hit.source, hit.session_id, hit.file_path) !== sessionKey),
      focusedMessageIndex: null,
    });
    if (nextActiveKey && activeWasDeleted) {
      await get().openSession(nextActiveKey);
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
        ...getHistoryPathArgs(),
        projectPath: get().projectPathFilter,
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
        ...getHistoryPathArgs(),
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
    const historyPathArgs = getHistoryPathArgs();
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
      const source = normalizeSourceFilter(sourceFilter);
      const raw = await invoke<unknown>("history_list_stats_projects", {
        source,
        ...historyPathArgs,
      });
      const projectOptions = normalizeStatsProjectOptions(raw);
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
    const rangeDays = options?.rangeDays ?? 30;
    const startAt = typeof options?.startAt === "number" && Number.isFinite(options.startAt) ? options.startAt : null;
    const endAt = typeof options?.endAt === "number" && Number.isFinite(options.endAt) ? options.endAt : null;
    const force = options?.force ?? false;
    const sourceFilter = get().sourceFilter;
    const historyPathArgs = getHistoryPathArgs();
    const historyPathKey = getHistoryPathCacheKey();
    const timeKey = makeStatsTimeKey(rangeDays, startAt, endAt);
    const cacheKey = makeStatsCacheKey(sourceFilter, projectKey, timeKey, historyPathKey);
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
      const source = normalizeSourceFilter(sourceFilter);
      const statsRaw = await invoke<unknown>("history_get_stats", {
        source,
        ...historyPathArgs,
        projectKey,
        rangeDays,
        startAt,
        endAt,
        force,
      });
      const payload = normalizeStats(statsRaw);
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
