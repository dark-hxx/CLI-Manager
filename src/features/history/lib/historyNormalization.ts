import { resolveHistoryProjectPath } from "../api/historyProjectPaths";
import { type SshAgentHistoryContext } from "../../remote/api/sshAgentHistory";
import { getHistoryPathArgsSync } from "../api/historyPathArgs";
import type {
  HistoryBackupStatus,
  HistoryGeneratedTitleMeta,
  HistoryGeneratedTitleState,
  HistoryFileChangeOperation,
  HistoryFileChangeSummary,
  HistoryIndexStatus,
  HistoryMessage,
  HistoryPromptItem,
  HistorySearchHit,
  HistorySessionDetail,
  HistorySessionSummary,
  HistorySessionRef,
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
  RequestLogStatsModelItem,
  RequestLogStatsPayload,
  RequestLogStatsSourceItem,
  RequestLogStatsTrendItem,
  Project,
  HistorySource,
  HistorySourceFilter,
  SessionFavoriteSnapshot,
} from "../../../shared/types/index";
import { type HistoryStore, type HistoryEditOutcome, type HistoryBatchDeleteOutcome } from "../types/historyStoreTypes";

export function effectiveProjectPathFilter(state: Pick<HistoryStore, "projectPathFilter" | "scopedProjectPathFilter">): string | null {
  return state.scopedProjectPathFilter ?? state.projectPathFilter;
}

export function findHistoryProject(projects: Project[], projectId: string | null, projectPath: string | null): Project | undefined {
  if (projectId) {
    const byId = projects.find((item) => item.id === projectId);
    if (byId) return byId;
  }
  const normalizedPath = projectPath?.trim();
  if (!normalizedPath) return undefined;
  return projects.find((item) => {
    const historyPath = resolveHistoryProjectPath(item);
    return historyPath === normalizedPath || item.path.trim() === normalizedPath || item.remote_path.trim() === normalizedPath;
  });
}

export function remoteSourceMatchesFilter(
  context: SshAgentHistoryContext,
  filter: HistorySourceFilter,
): boolean {
  return filter === "all" || filter === context.source;
}

export function asString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return String(value);
}

export function asNumber(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

export function normalizeRole(raw: unknown): string {
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

export function normalizeSessionRef(raw: unknown): HistorySessionRef | null {
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

export function normalizeSummary(raw: unknown): HistorySessionSummary {
  const rec = (raw ?? {}) as Record<string, unknown>;
  const remoteIdentityRaw = rec.remote_identity ?? rec.remoteIdentity;
  return {
    session_id: asString(rec.session_id ?? rec.sessionId),
    source: asString(rec.source) as HistorySource,
    project_key: asString(rec.project_key ?? rec.projectKey),
    title: asString(rec.title),
    file_path: asString(rec.file_path ?? rec.filePath),
    parent_session_id: asString(rec.parent_session_id ?? rec.parentSessionId ?? "") || null,
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

export function normalizeDetail(raw: unknown): HistorySessionDetail {
  const rec = (raw ?? {}) as Record<string, unknown>;
  const summary = normalizeSummary(rec);
  const messagesRaw = Array.isArray(rec.messages) ? rec.messages : [];
  const messages = messagesRaw.map((msg) => {
    const m = msg as Record<string, unknown>;
    const rawLineIndex = m.line_index ?? m.lineIndex;
    const rawEditableText = m.editable_text ?? m.editableText;
    const rawParts = Array.isArray(m.parts) ? m.parts : [];
    const parts = rawParts.flatMap((part) => {
      if (!part || typeof part !== "object") return [];
      const value = part as Record<string, unknown>;
      const kind = asString(value.kind);
      if (!["text", "tool_call", "tool_result", "reasoning", "system", "metadata", "unknown"].includes(kind)) {
        return [];
      }
      const content = asString(value.content);
      if (!content.trim()) return [];
      return [{
        kind: kind as NonNullable<HistoryMessage["parts"]>[number]["kind"],
        content,
        tool_name: asString(value.tool_name ?? value.toolName) || undefined,
        call_id: asString(value.call_id ?? value.callId) || undefined,
      }];
    });
    return {
      role: normalizeRole(m.role),
      content: asString(m.content),
      parts: parts.length > 0 ? parts : undefined,
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

export function normalizeSessionUsage(raw: unknown): HistorySessionDetail["usage"] {
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

export function normalizeTokenTrend(raw: unknown): HistoryTokenTrendPoint[] {
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

export function normalizeToolCounts(raw: unknown): HistoryToolCount[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      const rec = (item ?? {}) as Record<string, unknown>;
      return { name: asString(rec.name), count: asNumber(rec.count) };
    })
    .filter((item) => item.name.length > 0 && item.count > 0);
}

function normalizeToolEvidence(raw: unknown): HistoryToolEvent["evidence"] {
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as Record<string, unknown>;
  if (value.kind !== "inferred") return undefined;
  return { kind: "inferred",
    parent_call_id: asString(value.parent_call_id ?? value.parentCallId ?? "") || null,
    source_position: typeof (value.source_position ?? value.sourcePosition) === "number"
      ? asNumber(value.source_position ?? value.sourcePosition) : null };
}

export function normalizeToolEvents(raw: unknown): HistoryToolEvent[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      const rec = (item ?? {}) as Record<string, unknown>;
      return {
        evidence: normalizeToolEvidence(rec.evidence),
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

export function normalizeFileChangeOperations(raw: unknown): HistoryFileChangeOperation[] {
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

export function normalizeFileChanges(raw: unknown): HistoryFileChangeSummary[] {
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

export function normalizeHit(raw: unknown): HistorySearchHit {
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

export function normalizeIndexStatus(raw: unknown): HistoryIndexStatus {
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

export function normalizePrompt(raw: unknown): HistoryPromptItem {
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

export function normalizeStatsProject(raw: unknown): HistoryStatsProjectItem {
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

export function normalizeStatsModel(raw: unknown): HistoryStatsModelItem {
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

export function normalizeHeatmapDay(raw: unknown): HistoryStatsHeatmapDay {
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

export function normalizeDailySeries(raw: unknown): HistoryStatsDailySeriesItem {
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

export function normalizeSourceDistribution(raw: unknown): HistoryStatsSourceItem {
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

export function normalizeProjectEfficiency(raw: unknown): HistoryStatsProjectEfficiencyItem {
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

export function normalizeHourlyActivity(raw: unknown): HistoryStatsHourlyActivityItem {
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

export function normalizeStats(raw: unknown): HistoryStatsPayload {
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
    data_quality: (() => {
      const quality = (rec.data_quality ?? rec.dataQuality ?? {}) as Record<string, unknown>;
      return {
        route_records: asNumber(quality.route_records ?? quality.routeRecords),
        session_fallback_records: asNumber(quality.session_fallback_records ?? quality.sessionFallbackRecords),
        unattributed_records: asNumber(quality.unattributed_records ?? quality.unattributedRecords),
        missing_usage_records: asNumber(quality.missing_usage_records ?? quality.missingUsageRecords),
      };
    })(),
  };
}

export function normalizeStatsProjectOptions(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const projectSet = new Set<string>();
  for (const item of raw) {
    const project = asString(item).trim();
    if (project) projectSet.add(project);
  }
  return Array.from(projectSet).sort((a, b) => a.localeCompare(b));
}

export function normalizeSourceFilter(filter: HistorySourceFilter): Exclude<HistorySourceFilter, "all"> | null {
  if (filter === "all") return null;
  return filter;
}

export function normalizeRequestLogStatsTrend(raw: unknown): RequestLogStatsTrendItem {
  const rec = (raw ?? {}) as Record<string, unknown>;
  return {
    bucket_start_ms: asNumber(rec.bucket_start_ms ?? rec.bucketStartMs),
    requests: asNumber(rec.requests),
    input_tokens: asNumber(rec.input_tokens ?? rec.inputTokens),
    output_tokens: asNumber(rec.output_tokens ?? rec.outputTokens),
    cache_read_tokens: asNumber(rec.cache_read_tokens ?? rec.cacheReadTokens),
    cache_creation_tokens: asNumber(rec.cache_creation_tokens ?? rec.cacheCreationTokens),
    total_tokens: asNumber(rec.total_tokens ?? rec.totalTokens),
    total_cost_usd: asNumber(rec.total_cost_usd ?? rec.totalCostUsd ?? rec.totalCostUSD),
    unpriced_tokens: asNumber(rec.unpriced_tokens ?? rec.unpricedTokens),
  };
}

export function normalizeRequestLogStatsSource(raw: unknown): RequestLogStatsSourceItem {
  const rec = (raw ?? {}) as Record<string, unknown>;
  return {
    source: asString(rec.source) as RequestLogStatsSourceItem["source"],
    requests: asNumber(rec.requests),
    input_tokens: asNumber(rec.input_tokens ?? rec.inputTokens),
    output_tokens: asNumber(rec.output_tokens ?? rec.outputTokens),
    cache_read_tokens: asNumber(rec.cache_read_tokens ?? rec.cacheReadTokens),
    cache_creation_tokens: asNumber(rec.cache_creation_tokens ?? rec.cacheCreationTokens),
    total_tokens: asNumber(rec.total_tokens ?? rec.totalTokens),
    ratio: asNumber(rec.ratio),
    total_cost_usd: asNumber(rec.total_cost_usd ?? rec.totalCostUsd ?? rec.totalCostUSD),
    unpriced_tokens: asNumber(rec.unpriced_tokens ?? rec.unpricedTokens),
  };
}

export function normalizeRequestLogStatsModel(raw: unknown): RequestLogStatsModelItem {
  const rec = (raw ?? {}) as Record<string, unknown>;
  return {
    model: asString(rec.model),
    requests: asNumber(rec.requests),
    input_tokens: asNumber(rec.input_tokens ?? rec.inputTokens),
    output_tokens: asNumber(rec.output_tokens ?? rec.outputTokens),
    cache_read_tokens: asNumber(rec.cache_read_tokens ?? rec.cacheReadTokens),
    cache_creation_tokens: asNumber(rec.cache_creation_tokens ?? rec.cacheCreationTokens),
    total_tokens: asNumber(rec.total_tokens ?? rec.totalTokens),
    ratio: asNumber(rec.ratio),
    total_cost_usd: asNumber(rec.total_cost_usd ?? rec.totalCostUsd ?? rec.totalCostUSD),
    unpriced_tokens: asNumber(rec.unpriced_tokens ?? rec.unpricedTokens),
  };
}

export function normalizeRequestLogStats(raw: unknown): RequestLogStatsPayload {
  const rec = (raw ?? {}) as Record<string, unknown>;
  const trendRaw = rec.trend;
  const sourceRaw = rec.source_distribution ?? rec.sourceDistribution;
  const modelRaw = rec.model_distribution ?? rec.modelDistribution;
  return {
    range_start_at: asNumber(rec.range_start_at ?? rec.rangeStartAt),
    range_end_at: asNumber(rec.range_end_at ?? rec.rangeEndAt),
    granularity: asString(rec.granularity) === "hour" ? "hour" : "day",
    total_requests: asNumber(rec.total_requests ?? rec.totalRequests),
    total_input_tokens: asNumber(rec.total_input_tokens ?? rec.totalInputTokens),
    total_output_tokens: asNumber(rec.total_output_tokens ?? rec.totalOutputTokens),
    total_cache_read_tokens: asNumber(rec.total_cache_read_tokens ?? rec.totalCacheReadTokens),
    total_cache_creation_tokens: asNumber(rec.total_cache_creation_tokens ?? rec.totalCacheCreationTokens),
    total_tokens: asNumber(rec.total_tokens ?? rec.totalTokens),
    cache_hit_rate: asNumber(rec.cache_hit_rate ?? rec.cacheHitRate),
    total_cost_usd: asNumber(rec.total_cost_usd ?? rec.totalCostUsd ?? rec.totalCostUSD),
    total_unpriced_tokens: asNumber(rec.total_unpriced_tokens ?? rec.totalUnpricedTokens),
    trend: Array.isArray(trendRaw) ? trendRaw.map((item) => normalizeRequestLogStatsTrend(item)) : [],
    source_distribution: Array.isArray(sourceRaw) ? sourceRaw.map((item) => normalizeRequestLogStatsSource(item)) : [],
    model_distribution: Array.isArray(modelRaw) ? modelRaw.map((item) => normalizeRequestLogStatsModel(item)) : [],
  };
}

export function getHistoryPathCacheKey(): string {
  const { claudeConfigDir, codexConfigDir, grokSessionRoot, kimiConfigDir } = getHistoryPathArgsSync();
  return `${claudeConfigDir ?? "__default__"}|${codexConfigDir ?? "__default__"}|${grokSessionRoot ?? "__default__"}|${kimiConfigDir ?? "__default__"}`;
}

export function makeSessionKey(
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

export function summarySessionKey(summary: HistorySessionSummary): string {
  return makeSessionKey(summary.source, summary.session_id, summary.file_path, summary.session_ref);
}

export function hitSessionKey(hit: HistorySearchHit): string {
  return makeSessionKey(hit.source, hit.session_id, hit.file_path, hit.session_ref);
}

export function claudeProjectKeyFromPath(path: string): string {
  return path.trim().replace(/:/g, "-").replace(/[\\/]/g, "-").replace(/-+$/g, "").toLowerCase();
}

export function projectLastSegment(path: string): string {
  return normalizeMetaPath(path).replace(/\/+$/g, "").split("/").filter(Boolean).pop()?.toLowerCase() ?? "";
}

export function normalizeMetaPath(path: string): string {
  let normalized = path.trim().replace(/\\/g, "/");
  if (normalized.startsWith("//?/UNC/")) {
    normalized = `//${normalized.slice("//?/UNC/".length)}`;
  } else if (normalized.startsWith("//?/")) {
    normalized = normalized.slice("//?/".length);
  }
  return normalized;
}

export function snapshotMatchesFilters(
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

export function makeStatsProjectOptionsCacheKey(
  source: HistorySourceFilter,
  historyPathKey: string
): string {
  return `${source}|${historyPathKey}`;
}

export function makeStatsCacheKey(
  source: HistorySourceFilter,
  projectKey: string | null,
  projectPath: string | null,
  timeKey: string,
  historyPathKey: string
): string {
  return `${source}|key=${projectKey ?? "__all__"}|path=${projectPath ?? "__all__"}|${timeKey}|${historyPathKey}`;
}

export function makeStatsTimeKey(rangeDays: number, startAt: number | null, endAt: number | null): string {
  if (startAt !== null && endAt !== null) {
    return `absolute:${startAt}:${endAt}`;
  }
  return `range:${rangeDays}`;
}

export function parseTags(tagsJson: string): string[] {
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

export function normalizeGeneratedTitleState(value: unknown): HistoryGeneratedTitleState {
  return value === "pending" || value === "succeeded" || value === "failed" ? value : "idle";
}

export function normalizeGeneratedTitleMeta(raw: unknown): HistoryGeneratedTitleMeta | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  const sessionKey = asString(rec.sessionKey ?? rec.session_key).trim();
  const sourceId = asString(rec.sourceId ?? rec.source_id).trim() as HistorySource;
  const sourceInstanceId = asString(rec.sourceInstanceId ?? rec.source_instance_id);
  const sourceSessionId = asString(rec.sourceSessionId ?? rec.source_session_id);
  if (!sessionKey || !sourceId || !sourceInstanceId || !sourceSessionId) return null;
  const triggerRaw = asString(rec.triggerKind ?? rec.trigger_kind);
  return {
    sessionKey,
    sourceId,
    sourceInstanceId,
    sourceSessionId,
    transportKind: asString(rec.transportKind ?? rec.transport_kind) || "local",
    title: (rec.title ?? rec.generatedTitle ?? rec.generated_title) == null
      ? null
      : asString(rec.title ?? rec.generatedTitle ?? rec.generated_title),
    state: normalizeGeneratedTitleState(rec.state ?? rec.generationState ?? rec.generation_state),
    revision: asNumber(rec.revision ?? rec.generationRevision ?? rec.generation_revision),
    triggerKind: triggerRaw === "automatic" || triggerRaw === "manual" ? triggerRaw : null,
    sourceMessageIdentity: (rec.sourceMessageIdentity ?? rec.source_message_identity) == null
      ? null
      : asString(rec.sourceMessageIdentity ?? rec.source_message_identity),
    sourceContentSha256: (rec.sourceContentSha256 ?? rec.source_content_sha256) == null
      ? null
      : asString(rec.sourceContentSha256 ?? rec.source_content_sha256),
    providerAppType: (rec.providerAppType ?? rec.provider_app_type) == null
      ? null
      : asString(rec.providerAppType ?? rec.provider_app_type),
    providerId: (rec.providerId ?? rec.provider_id) == null
      ? null
      : asString(rec.providerId ?? rec.provider_id),
    modelId: (rec.modelId ?? rec.model_id) == null
      ? null
      : asString(rec.modelId ?? rec.model_id),
    failureCode: (rec.failureCode ?? rec.failure_code) == null
      ? null
      : asString(rec.failureCode ?? rec.failure_code),
    autoSuppressed: rec.autoSuppressed === true || rec.auto_suppressed === 1 || rec.auto_suppressed === "1",
    suppressedFingerprint: (rec.suppressedFingerprint ?? rec.suppressed_fingerprint) == null
      ? null
      : asString(rec.suppressedFingerprint ?? rec.suppressed_fingerprint),
    requestedAt: (rec.requestedAt ?? rec.requested_at) == null
      ? null
      : asNumber(rec.requestedAt ?? rec.requested_at),
    completedAt: (rec.completedAt ?? rec.completed_at) == null
      ? null
      : asNumber(rec.completedAt ?? rec.completed_at),
    updatedAt: asNumber(rec.updatedAt ?? rec.updated_at),
  };
}

export function normalizeEditOutcome(raw: unknown): HistoryEditOutcome {
  const rec = (raw ?? {}) as Record<string, unknown>;
  return {
    detail: normalizeDetail(rec.detail),
    beforeText: asString(rec.beforeText ?? rec.before_text ?? "") || null,
    afterText: asString(rec.afterText ?? rec.after_text ?? "") || null,
    backupPath: asString(rec.backupPath ?? rec.backup_path ?? "") || null,
  };
}

export function normalizeBatchDeleteOutcome(raw: unknown): HistoryBatchDeleteOutcome {
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

export function normalizeBackupStatus(raw: unknown): HistoryBackupStatus {
  const rec = (raw ?? {}) as Record<string, unknown>;
  const backupAtRaw = rec.backupAt ?? rec.backup_at;
  return {
    hasBackup: rec.hasBackup === true || rec.has_backup === true,
    backupPath: asString(rec.backupPath ?? rec.backup_path ?? "") || null,
    backupAt: typeof backupAtRaw === "number" && Number.isFinite(backupAtRaw) ? backupAtRaw : null,
  };
}

export function normalizeGeneratedTitleResponse(raw: unknown): HistoryGeneratedTitleMeta | null {
  const rec = raw && typeof raw === "object" && "meta" in raw
    ? (raw as Record<string, unknown>).meta
    : raw;
  return normalizeGeneratedTitleMeta(rec);
}
