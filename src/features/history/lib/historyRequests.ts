import { invoke } from "@tauri-apps/api/core";
import { logInfo, logWarn } from "../../../lib/logger";
import { queryClient } from "../../../lib/queryClient";
import { normalizeHistoryProjectPaths } from "../../../lib/historyProjectPaths";
import { buildSshAgentHistoryContext, type SshAgentHistoryContext } from "../../../lib/sshAgentHistory";
import { getHistoryPathArgs } from "../../../lib/historyPathArgs";
import { useSshAgentIntegrationStore } from "../../../stores/sshAgentIntegrationStore";
import { useBackgroundOperationStore } from "../../../stores/backgroundOperationStore";
import type {
  HistorySessionDetail,
  HistorySessionSummary,
  HistoryStatsPayload,
  RequestLogStatsPayload,
  RequestLogSyncResult,
  Project,
  HistorySource,
  HistorySourceFilter,
  SshRemoteHistorySyncResult,
} from "../../../lib/types";
import {
  type TodayProjectStats,
  type FetchHistoryStatsOptions,
  type FetchHistoryRequestLogStatsOptions,
  type RemoteHistorySyncOptions,
} from "../types/historyStoreTypes";
import {
  normalizeSummary,
  normalizeDetail,
  normalizeStats,
  normalizeStatsProjectOptions,
  normalizeSourceFilter,
  normalizeRequestLogStats,
} from "./historyNormalization";
import { SESSION_PAGE_FETCH_LIMIT } from "./historyCache";

export let requestLogSyncPromise: Promise<RequestLogSyncResult> | null = null;

export function requestLogSyncChanged(result: RequestLogSyncResult): boolean {
  return result.changed_files > 0 || result.removed_files > 0 || result.written_rows > 0;
}

export function invalidateRequestLogQueries(): void {
  void queryClient.invalidateQueries({ queryKey: ["historyRequestLogs"] });
  void queryClient.invalidateQueries({ queryKey: ["historyRequestLogStats"] });
}

export function invalidateHistoryStatsQueries(): void {
  void queryClient.invalidateQueries({ queryKey: ["historyStats"] });
}

export async function syncHistoryRequestLogs(force = false): Promise<RequestLogSyncResult> {
  if (requestLogSyncPromise && !force) {
    return requestLogSyncPromise;
  }
  const pathArgs = await getHistoryPathArgs();
  const promise = invoke<RequestLogSyncResult>("history_sync_request_logs", {
    ...pathArgs,
    force,
  });
  requestLogSyncPromise = promise;
  try {
    const result = await promise;
    if (requestLogSyncChanged(result)) invalidateRequestLogQueries();
    invalidateHistoryStatsQueries();
    return result;
  } finally {
    if (requestLogSyncPromise === promise) requestLogSyncPromise = null;
  }
}

export async function fetchHistoryRequestLogStats(
  options: FetchHistoryRequestLogStatsOptions,
): Promise<RequestLogStatsPayload> {
  const filters = {
    source: normalizeSourceFilter(options.sourceFilter),
    project_key: options.projectKey?.trim() || null,
    project_path: options.projectPath?.trim() || null,
    model: options.model?.trim() || null,
    start_at: typeof options.startAt === "number" && Number.isFinite(options.startAt) ? options.startAt : null,
    end_at: typeof options.endAt === "number" && Number.isFinite(options.endAt) ? options.endAt : null,
  };
  const raw = await invoke<unknown>("history_get_request_log_stats", {
    filters,
    ...(await getHistoryPathArgs()),
  });
  return normalizeRequestLogStats(raw);
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
    const force = options.force ?? false;
    context = await syncRemoteHistoryContext(context, { limit: 1000, forceRefresh: force });
    return await fetchHistoryStatsPayload({
      ...options,
      projectKey: null,
      projectPath: project.remote_path,
      sourceInstanceId: context.sourceInstanceId,
      force,
    });
  } finally {
    void invoke("history_remote_close", {
      hostId: context.hostId,
      consumerId: context.consumerId,
    }).catch(() => undefined);
  }
}

export async function fetchLatestProjectSessionDetail(
  projectPath: string,
  prev?: { filePath: string; updatedAt: number },
  source?: HistorySource | null,
  cliSessionId?: string | null,
  options?: { forceCatalogRefresh?: boolean; freshDetail?: boolean; waitForCatalogRefresh?: boolean }
): Promise<HistorySessionDetail | "unchanged" | null> {
  try {
    const forceCatalogRefresh = Boolean(options?.forceCatalogRefresh);
    const freshDetail = Boolean(options?.freshDetail);
    const waitForCatalogRefresh = Boolean(options?.waitForCatalogRefresh);
    logInfo("history.realtime.lookup.start", {
      source: source ?? null,
      projectPath,
      cliSessionId: cliSessionId ?? null,
      forceCatalogRefresh,
      freshDetail,
      waitForCatalogRefresh,
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
    // 仍 miss 时后台刷新 catalog 再试一次；Grok 精确 sessionId 可由后端绕过 catalog 直接命中。
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
        await invoke("history_refresh_index", { ...pathArgs, wait: waitForCatalogRefresh });
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
    const summaryChanged =
      !prev || summary.file_path !== prev.filePath || summary.updated_at !== prev.updatedAt;
    if (prev && !summaryChanged && !freshDetail) {
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
      fresh: freshDetail || summaryChanged,
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
      routeRecords: stats.data_quality?.route_records ?? 0,
      sessionFallbackRecords: stats.data_quality?.session_fallback_records ?? 0,
      unattributedRecords: stats.data_quality?.unattributed_records ?? 0,
      missingUsageRecords: stats.data_quality?.missing_usage_records ?? 0,
    };
  } catch {
    return null;
  }
}

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
    force: false,
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
      routeRecords: stats.data_quality?.route_records ?? 0,
      sessionFallbackRecords: stats.data_quality?.session_fallback_records ?? 0,
      unattributedRecords: stats.data_quality?.unattributed_records ?? 0,
      missingUsageRecords: stats.data_quality?.missing_usage_records ?? 0,
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

export async function fetchRemoteProjectSessionSummaries(
  project: Project,
  limit = 100,
): Promise<{ context: SshAgentHistoryContext; summaries: HistorySessionSummary[] }> {
  const initial = await buildSshAgentHistoryContext(project);
  const context = await syncRemoteHistoryContext(initial, {
    reset: true,
    limit,
    forceRefresh: true,
  });
  if (!context.sourceInstanceId) return { context, summaries: [] };
  const raw = await invoke<unknown[]>("history_remote_list_cached", {
    sourceInstanceId: context.sourceInstanceId,
    projectPath: context.projectPaths[0] ?? null,
    query: null,
    limit,
    offset: 0,
  });
  return {
    context,
    summaries: (raw ?? []).map((item) => normalizeSummary(item)),
  };
}

export const remoteHistorySyncRequests = new Map<string, Promise<SshRemoteHistorySyncResult>>();

export async function requestRemoteHistorySync(
  context: SshAgentHistoryContext,
  options: RemoteHistorySyncOptions,
): Promise<SshRemoteHistorySyncResult> {
  const limit = options.limit ?? SESSION_PAGE_FETCH_LIMIT;
  const cursor = options.reset ? null : context.cursor || null;
  const forceRefresh = options.forceRefresh ?? false;
  const key = JSON.stringify({
    hostId: context.hostId,
    source: context.source,
    configuredConfigRoot: context.configuredConfigRoot,
    projectPaths: [...context.projectPaths].sort(),
    sourceInstanceId: context.sourceInstanceId || null,
    cursor,
    limit,
    forceRefresh,
    scopeKind: context.scopeKind,
    installationId: context.launch.agentInstallationId,
    remoteMachineId: context.launch.agentRemoteMachineId,
    sshUser: context.launch.username,
  });
  const existing = remoteHistorySyncRequests.get(key);
  if (existing) return existing;
  const requestConsumerId = `history-sync:${crypto.randomUUID()}`;
  const args = {
    consumerId: requestConsumerId,
    sshLaunch: context.launch,
    source: context.source,
    configuredConfigRoot: context.configuredConfigRoot,
    projectPaths: context.projectPaths,
    sourceInstanceId: context.sourceInstanceId || null,
    cursor,
    limit,
    forceRefresh,
  };
  const operationId = `remote-history:${context.consumerId}`;
  useBackgroundOperationStore.getState().start({
    id: operationId,
    kind: "remoteHistory",
    titleKey: "backgroundOperations.remoteHistory.title",
    detailKey: "backgroundOperations.remoteHistory.loading",
    contextLabel: context.projectPaths[0] ?? context.configuredConfigRoot,
    retry: () => { void syncRemoteHistoryContext(context, options).catch(() => undefined); },
  });
  const request = invoke<SshRemoteHistorySyncResult>("history_remote_sync", args).then(async (result) => {
    if (result.applied !== false) {
      await useSshAgentIntegrationStore.getState().recordHistorySource(
        context.hostId,
        context.configuredConfigRoot,
        result,
        context.scopeKind,
      );
    }
    useBackgroundOperationStore.getState().succeed(operationId);
    return result;
  }).catch((error) => {
    useBackgroundOperationStore.getState().fail(operationId, error);
    throw error;
  });
  remoteHistorySyncRequests.set(key, request);
  void request.finally(() => {
    if (remoteHistorySyncRequests.get(key) === request) remoteHistorySyncRequests.delete(key);
    void invoke("history_remote_close", {
      hostId: context.hostId,
      consumerId: requestConsumerId,
    }).catch(() => undefined);
  }).catch(() => undefined);
  return request;
}

export async function syncRemoteHistoryContext(
  context: SshAgentHistoryContext,
  options: RemoteHistorySyncOptions = {},
): Promise<SshAgentHistoryContext> {
  const result = await requestRemoteHistorySync(context, options);
  if (result.applied === false) return context;
  return {
    ...context,
    sourceInstanceId: result.sourceInstanceId,
    cursor: result.cursor,
    generation: result.generation,
    hasMore: result.hasMore,
  };
}
