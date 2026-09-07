import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getDb } from "../../../shared/platform/db";
import { createPerfMarker, logWarn } from "../../../shared/platform/logger";
import { resolveHistoryProjectPath } from "../api/historyProjectPaths";
import { buildSshAgentHistoryContext } from "../../remote/api/sshAgentHistory";
import { ensureHistorySourceSettingsLoaded, getHistoryPathArgs } from "../api/historyPathArgs";
import { inferSubagentParentSessionId } from "../lib/historySubagents";
import { sameHistorySessionIdentity } from "../lib/historySessionIdentity";
import { extractHistoryTitleCandidate, resolveHistoryDisplayTitle } from "../lib/historyTitle";
import { useProjectStore } from "../../projects/api/projectStore";
import { useSettingsStore } from "../../../shared/preferences/settingsStore";
import type {
  HistoryGeneratedTitleTrigger,
  HistoryEditAuditEntry,
  HistoryMessage,
  HistorySessionDetail,
  HistorySessionSummary,
  HistorySessionView,
  HistoryTitleCandidate,
  SessionMeta,
} from "../../../shared/types/index";
import { type HistoryStore, type HistoryEditOp, type HistoryEditOutcome } from "../types/historyStoreTypes";
import {
  effectiveProjectPathFilter,
  findHistoryProject,
  remoteSourceMatchesFilter,
  normalizeSummary,
  normalizeDetail,
  normalizeHit,
  normalizeIndexStatus,
  normalizePrompt,
  normalizeSourceFilter,
  getHistoryPathCacheKey,
  summarySessionKey,
  hitSessionKey,
  makeStatsProjectOptionsCacheKey,
  makeStatsCacheKey,
  makeStatsTimeKey,
  parseTags,
  normalizeEditOutcome,
  normalizeBatchDeleteOutcome,
  normalizeBackupStatus,
  normalizeGeneratedTitleResponse,
} from "../lib/historyNormalization";
import {
  SESSION_PAGE_SIZE,
  SESSION_PAGE_FETCH_LIMIT,
  DEFAULT_SEARCH_LIMIT,
  MIN_GLOBAL_SEARCH_CHARS,
  DEFAULT_HISTORY_INDEX_STATUS,
  STATS_CACHE_TTL_MS,
  statsCacheGet,
  statsCacheSet,
  statsProjectOptionsCacheGet,
  statsProjectOptionsCacheSet,
} from "../lib/historyCache";
import {
  fetchHistoryStatsProjectOptions,
  fetchHistoryStatsPayload,
  syncRemoteHistoryContext,
} from "../lib/historyRequests";
import {
  toViewWithGeneratedTitle,
  applyMeta,
  sortSessionViews,
  viewToSummary,
  readMetaMap,
  readGeneratedTitleMap,
  readFavoriteSnapshotDetail,
  writeFavoriteSnapshot,
  deleteFavoriteSnapshot,
  deleteFavoriteSnapshotsForSession,
  insertEditAuditRecord,
  mergeDetailIntoSessions,
  applyFavoriteSnapshots,
  titleSourceIdentity,
  generatedTitleView,
} from "../lib/historyMetadata";

export let statsRequestSeq = 0;

export let historyMetaReady = false;

export let historyMetaInitPromise: Promise<void> | null = null;

export async function applyEditedDetail(
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

export async function finalizeEditOutcome(options: {
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

export async function reloadAfterEditConflict(sessionKey: string, err: unknown): Promise<never> {
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

export function requireActiveEditContext(sessionKey: string): {
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

export function requireMessageLocator(message: HistoryMessage): { lineIndex: number; expectedText: string } {
  if (!message.editable || message.line_index === null || message.line_index === undefined) {
    throw new Error("message_not_editable");
  }
  return {
    lineIndex: message.line_index,
    expectedText: message.editable_text ?? message.content,
  };
}

export async function loadDetailForSnapshot(sessionKey: string, session: HistorySessionView): Promise<HistorySessionDetail> {
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

export let globalSearchRequestSeq = 0;

export let historyOpenRequestSeq = 0;

export let sessionListRequestSeq = 0;

export let sessionDetailRequestSeq = 0;

export let historyIndexListenerPromise: Promise<void> | null = null;

export let historyIndexReadyRefreshTimer: number | null = null;

export function isCurrentSessionListRequest(requestSeq: number, remoteConsumerId: string | null): boolean {
  if (requestSeq !== sessionListRequestSeq) return false;
  return (useHistoryStore.getState().remoteContext?.consumerId ?? null) === remoteConsumerId;
}

export function ensureHistoryIndexListener(): Promise<void> {
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
      void state.loadSessions({ background: true }).then(() => {
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

export const automaticTitleQueueKeys = new Set<string>();

export let automaticTitleQueue: Promise<void> = Promise.resolve();

export const smartTitleRequestKinds = new Map<string, HistoryGeneratedTitleTrigger>();

export const MAX_AUTOMATIC_TITLE_QUEUE_LENGTH = 32;

export function historyTimestampMs(value: number): number {
  return value > 0 && value < 100_000_000_000 ? value * 1000 : value;
}

export function queueAutomaticTitle(session: HistorySessionView): void {
  const settings = useSettingsStore.getState().historySmartTitle;
  if (!settings.enabled || !settings.enabledAt || historyTimestampMs(session.created_at) < settings.enabledAt) return;
  if (session.read_only && session.session_ref?.transportKind !== "ssh") return;
  if (automaticTitleQueueKeys.has(session.sessionKey)) return;
  if (automaticTitleQueueKeys.size >= MAX_AUTOMATIC_TITLE_QUEUE_LENGTH) {
    logWarn("history.smartTitle.queueFull", { limit: MAX_AUTOMATIC_TITLE_QUEUE_LENGTH });
    return;
  }
  automaticTitleQueueKeys.add(session.sessionKey);
  automaticTitleQueue = automaticTitleQueue
    .then(async () => {
      try {
        if (!automaticTitleQueueKeys.has(session.sessionKey)) return;
        await useHistoryStore.getState().generateSmartTitle(session.sessionKey, "automatic");
      } catch (error) {
        // 自动触发失败不打扰用户；后端已把失败与 revision 持久化，避免重复请求。
        logWarn("history.smartTitle.autoFailed", { sessionKey: session.sessionKey, error: String(error) });
      } finally {
        automaticTitleQueueKeys.delete(session.sessionKey);
      }
    })
    .catch((error) => {
      automaticTitleQueueKeys.delete(session.sessionKey);
      logWarn("history.smartTitle.queueFailed", { sessionKey: session.sessionKey, error: String(error) });
    });
}

export async function cancelAutomaticTitle(sessionKey: string): Promise<void> {
  const activeAutomaticRequest = smartTitleRequestKinds.get(sessionKey) === "automatic";
  const queued = automaticTitleQueueKeys.delete(sessionKey);
  if (!queued && !activeAutomaticRequest) return;
  try {
    await invoke("history_title_cancel", { sessionKey });
  } catch (error) {
    if (queued) automaticTitleQueueKeys.add(sessionKey);
    logWarn("history.smartTitle.cancelFailed", { sessionKey, error: String(error) });
    throw new Error("history_title_cancel_failed");
  }
}

export function cancelAutomaticTitleQueue(): void {
  const sessionKeys = [...automaticTitleQueueKeys];
  automaticTitleQueueKeys.clear();
  for (const sessionKey of sessionKeys) {
    void invoke("history_title_cancel", { sessionKey }).catch((error) => {
      logWarn("history.smartTitle.cancelFailed", { sessionKey, error: String(error) });
    });
  }
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
  projectIdFilter: null,
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
  generatedTitleMap: {},
  smartTitleInFlightSessionKeys: new Set(),
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
      CREATE TABLE IF NOT EXISTS history_generated_titles (
        session_key             TEXT PRIMARY KEY,
        source_id               TEXT NOT NULL,
        source_instance_id      TEXT NOT NULL DEFAULT '',
        source_session_id       TEXT NOT NULL,
        transport_kind          TEXT NOT NULL DEFAULT 'local',
        generated_title         TEXT,
        generation_state        TEXT NOT NULL DEFAULT 'idle'
                                CHECK (generation_state IN ('idle','pending','succeeded','failed')),
        generation_revision     INTEGER NOT NULL DEFAULT 0,
        trigger_kind            TEXT
                                CHECK (trigger_kind IS NULL OR trigger_kind IN ('automatic','manual')),
        source_message_identity TEXT,
        source_content_sha256   TEXT,
        provider_app_type       TEXT,
        provider_id             TEXT,
        model_id                TEXT,
        failure_code            TEXT,
        auto_suppressed         INTEGER NOT NULL DEFAULT 0 CHECK (auto_suppressed IN (0,1)),
        suppressed_fingerprint  TEXT,
        requested_at            INTEGER,
        completed_at            INTEGER,
        updated_at              INTEGER NOT NULL
      )
        `);
        await db.execute(
      "CREATE INDEX IF NOT EXISTS idx_history_generated_titles_source_identity ON history_generated_titles(source_id, source_instance_id, source_session_id)"
        );
        await db.execute(
      "CREATE INDEX IF NOT EXISTS idx_history_generated_titles_state ON history_generated_titles(generation_state, updated_at DESC)"
        );
        // 应用异常退出后不允许把未完成请求当作可自动重试任务。
        await db.execute(
      "UPDATE history_generated_titles SET generation_state = 'failed', failure_code = 'interrupted', updated_at = $1 WHERE generation_state = 'pending'",
          [Date.now()]
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
    const requestedProjectPath = options?.projectPath?.trim() || null;
    const requestedProjectId = options?.projectId?.trim() || null;
    const projectStore = useProjectStore.getState();
    if (!projectStore.loaded && (requestedProjectId || requestedProjectPath)) {
      await projectStore.fetchAll("interactive");
    }
    const project = findHistoryProject(
      useProjectStore.getState().projects,
      requestedProjectId,
      requestedProjectPath,
    );
    const resolvedProjectPath = resolveHistoryProjectPath(project);
    const nextProjectPathFilter = resolvedProjectPath || requestedProjectPath;
    const nextProjectIdFilter = nextProjectPathFilter
      ? (project?.id ?? requestedProjectId)
      : null;
    const nextScopedProjectPathFilter = options?.scopedProjectPath?.trim() || null;
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
      nextProjectIdFilter !== get().projectIdFilter ||
      nextScopedProjectPathFilter !== get().scopedProjectPathFilter ||
      nextRemoteContext?.consumerId !== previousRemoteContext?.consumerId;
    const hasSessions = get().sessions.length > 0;
    const stopPerf = createPerfMarker("history.open", {
      sourceFilter: nextSourceFilter,
      projectPathFilter: nextProjectPathFilter ?? "__all__",
      projectIdFilter: nextProjectIdFilter ?? "__none__",
      scopedProjectPathFilter: nextScopedProjectPathFilter ?? "__none__",
      fromCache: hasSessions && !filterChanged,
    });
    set({
      isOpen: true,
      sourceFilter: nextSourceFilter,
      projectPathFilter: nextProjectPathFilter,
      projectIdFilter: nextProjectIdFilter,
      scopedProjectPathFilter: nextScopedProjectPathFilter,
      remoteContext: nextRemoteContext,
    });
    try {
      if (nextRemoteContext) {
        const refreshRemote = async (forceRefresh: boolean) => {
          const synced = await syncRemoteHistoryContext(nextRemoteContext, { forceRefresh });
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
          await get().loadSessions({ background: true });
        };
        const markRemoteRefreshError = (error: unknown) => {
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
        };
        if (nextRemoteContext.sourceInstanceId) {
          await get().loadSessions();
          if (!isCurrentOpenRequest()) return;
          if (get().sessions.length > 0) {
            void refreshRemote(true).catch(markRemoteRefreshError);
            return;
          }
        }
        try {
          await refreshRemote(false);
          if (get().sessions.length === 0) {
            await refreshRemote(true);
          }
        } catch (error) {
          markRemoteRefreshError(error);
          throw error;
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

  setProjectPathFilter: async (projectPath, projectId) => {
    globalSearchRequestSeq += 1;
    const nextProjectPath = projectPath?.trim() || null;
    set({
      projectPathFilter: nextProjectPath,
      projectIdFilter: nextProjectPath ? (projectId?.trim() || null) : null,
      scopedProjectPathFilter: null,
    });
    await get().loadSessions();
    if (!get().globalQuery.trim()) {
      set({ searchHits: [] });
    }
  },

  loadSessions: async (options) => {
    const requestSeq = ++sessionListRequestSeq;
    const remoteContext = get().remoteContext;
    const remoteConsumerId = remoteContext?.consumerId ?? null;
    const sourceFilter = get().sourceFilter;
    const projectPath = effectiveProjectPathFilter(get());
    const background = options?.background === true && get().sessions.length > 0;
    const sessionLimit = background
      ? Math.max(SESSION_PAGE_SIZE, get().sessionListOffset)
      : SESSION_PAGE_SIZE;
    const fetchLimit = sessionLimit + 1;
    const stopPerf = createPerfMarker("history.sessions.load", {
      sourceFilter: get().sourceFilter,
      projectPathFilter: get().projectPathFilter ?? "__all__",
      scopedProjectPathFilter: get().scopedProjectPathFilter ?? "__none__",
      mode: background ? "background" : "foreground",
      limit: sessionLimit,
    });
    if (background) {
      set({ loadingSessions: false, loadingMoreSessions: false });
    } else {
      set({ loadingSessions: true, loadingMoreSessions: false, hasMoreSessions: false, sessionListOffset: 0 });
    }
    try {
      await get().ensureMetaTable();
      const source = normalizeSourceFilter(sourceFilter);
      const summariesRaw = remoteContext
        ? remoteSourceMatchesFilter(remoteContext, sourceFilter) && remoteContext.sourceInstanceId
          ? await invoke<unknown[]>("history_remote_list_cached", {
            sourceInstanceId: remoteContext.sourceInstanceId,
            projectPath,
            query: null,
            limit: fetchLimit,
            offset: 0,
          })
          : []
        : await invoke<unknown[]>("history_list_sessions", {
          source,
          ...(await getHistoryPathArgs()),
          projectPath,
          query: null,
          limit: fetchLimit,
          offset: 0,
        });
      const allSummaries = (summariesRaw ?? []).map((item) => normalizeSummary(item));
      const summaries = allSummaries.slice(0, sessionLimit);
      const metaMap = await readMetaMap();
      const generatedTitleMap = await readGeneratedTitleMap();
      const sessions = remoteContext
        ? applyMeta(summaries, metaMap, generatedTitleMap)
        : await applyFavoriteSnapshots(summaries, metaMap, sourceFilter, projectPath, undefined, generatedTitleMap);
      if (!isCurrentSessionListRequest(requestSeq, remoteConsumerId)) return;
      const activeSessionKey = get().activeSessionKey;
      const activeExists = activeSessionKey
        ? sessions.some((item) => item.sessionKey === activeSessionKey)
        : false;
      const nextActiveKey = activeExists ? activeSessionKey : sessions[0]?.sessionKey ?? null;
      set({
        sessions,
        metaMap,
        generatedTitleMap,
        hasMoreSessions: allSummaries.length > sessionLimit,
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
            await get().loadSessions({ background: true });
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
      const generatedTitleMap = get().generatedTitleMap;
      const sessions = remoteContext
        ? applyMeta(Array.from(summaryMap.values()), metaMap, generatedTitleMap)
        : await applyFavoriteSnapshots(
          Array.from(summaryMap.values()),
          metaMap,
          sourceFilter,
          projectPath,
          sourceSessionKeys,
          generatedTitleMap,
        );
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
      const synced = await syncRemoteHistoryContext(remoteContext, { reset: true, forceRefresh: true });
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
      await get().loadSessions({ background: true });
      if ([...get().globalQuery.trim()].length >= MIN_GLOBAL_SEARCH_CHARS) {
        await get().runGlobalSearch(get().globalQuery);
      }
      return;
    }
    await ensureHistoryIndexListener();
    const activeSessionKey = get().activeSessionKey;
    const raw = await invoke<unknown>("history_refresh_index", {
      ...(await getHistoryPathArgs()),
      wait: true,
    });
    if (historyIndexReadyRefreshTimer !== null) {
      window.clearTimeout(historyIndexReadyRefreshTimer);
      historyIndexReadyRefreshTimer = null;
    }
    set({ indexStatus: normalizeIndexStatus(raw) });
    await get().loadSessions({ background: true });
    // Refreshing the index must also replace the currently open detail; otherwise
    // the editor can keep rendering the pre-delete snapshot until another session
    // is opened.
    if (activeSessionKey) {
      if (get().sessions.some((session) => session.sessionKey === activeSessionKey)) {
        await get().openSession(activeSessionKey);
      } else {
        set({ activeSessionKey: null, activeSession: null });
      }
    }
    const query = get().globalQuery;
    if ([...query.trim()].length >= MIN_GLOBAL_SEARCH_CHARS) {
      await get().runGlobalSearch(query);
    }
  },

  addConvertedSession: (summary, detail) => {
    const normalized = normalizeSummary(summary);
    const normalizedDetail = normalizeDetail(detail);
    if (!sameHistorySessionIdentity(normalized, normalizedDetail)) {
      throw new Error("history_conversion_detail_mismatch");
    }
    const sessionKey = summarySessionKey(normalized);
    const nextView = toViewWithGeneratedTitle(
      normalized,
      get().metaMap[sessionKey],
      get().generatedTitleMap[sessionKey],
    );
    sessionDetailRequestSeq += 1;
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
      activeSession: normalizedDetail,
      loadingSessionDetail: false,
      focusedMessageIndex: null,
    }));
    return sessionKey;
  },

  openSession: async (sessionKey, options = {}) => {
    const requestSeq = ++sessionDetailRequestSeq;
    const stopPerf = createPerfMarker("history.session.detail", { sessionKey });
    const target = get().sessions.find((item) => item.sessionKey === sessionKey);
    if (!target) {
      stopPerf({ skipped: true, reason: "missing-target" });
      return;
    }
    set({
      activeSessionKey: sessionKey,
      activeSession: null,
      loadingSessionDetail: true,
      focusedMessageIndex: null,
    });
    let detailFromSnapshot = false;
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
        if (!sameHistorySessionIdentity(target, detail)) {
          throw new Error("history_session_identity_mismatch");
        }
        if (requestSeq === sessionDetailRequestSeq) {
          set({ activeSession: detail });
          const currentView = get().sessions.find((item) => item.sessionKey === sessionKey);
          if (currentView && !detailFromSnapshot) queueAutomaticTitle(currentView);
        }
      } catch (err) {
        if (options.requireLiveDetail) throw err;
        const snapshot = await readFavoriteSnapshotDetail(sessionKey);
        if (!snapshot) throw err;
        logWarn("history.favoriteSnapshot.fallback", { sessionKey, error: String(err) });
        if (!sameHistorySessionIdentity(target, snapshot)) throw err;
        detailFromSnapshot = true;
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
    set({
      activeSessionKey: sessionKey,
      activeSession: null,
      loadingSessionDetail: true,
      focusedMessageIndex: null,
    });
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
      if (!sameHistorySessionIdentity(hit, detail)) {
        throw new Error("history_session_identity_mismatch");
      }
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
        sessions: applyMeta(summaries, metaMap, get().generatedTitleMap),
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

    // 后端删除会话时会连带删除其 subagents/ 子转录，本地状态需同步移除对应子行。
    const removedSessionKeys = new Set([sessionKey]);
    if (!target.favoriteSnapshot) {
      await invoke("history_delete_session", {
        filePath: target.file_path,
        ...(await getHistoryPathArgs()),
        source: target.source,
        projectKey: target.project_key,
      });
      for (const item of get().sessions) {
        if (
          item.source === target.source &&
          item.project_key === target.project_key &&
          inferSubagentParentSessionId(item) === target.session_id
        ) {
          removedSessionKeys.add(item.sessionKey);
        }
      }
    }

    const db = await getDb();
    for (const key of removedSessionKeys) {
      await db.execute("DELETE FROM session_meta WHERE session_key = $1", [key]);
      await db.execute("DELETE FROM history_generated_titles WHERE session_key = $1", [key]);
      await deleteFavoriteSnapshot(key);
    }

    const sessions = get().sessions.filter((item) => !removedSessionKeys.has(item.sessionKey));
    const metaMap = { ...get().metaMap };
    const generatedTitleMap = { ...get().generatedTitleMap };
    for (const key of removedSessionKeys) delete metaMap[key];
    for (const key of removedSessionKeys) delete generatedTitleMap[key];
    const currentActiveKey = get().activeSessionKey;
    const activeWasDeleted = currentActiveKey !== null && removedSessionKeys.has(currentActiveKey);
    const nextActiveKey = activeWasDeleted ? sessions[0]?.sessionKey ?? null : currentActiveKey;
    set({
      sessions,
      metaMap,
      generatedTitleMap,
      activeSessionKey: nextActiveKey,
      activeSession: activeWasDeleted ? null : get().activeSession,
      searchHits: get().searchHits.filter((hit) => !removedSessionKeys.has(hitSessionKey(hit))),
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
      const hits = (hitsRaw ?? []).map((item) => normalizeHit(item)).map((hit) => {
        const sessionKey = hitSessionKey(hit);
        const meta = get().metaMap[sessionKey];
        const generated = get().generatedTitleMap[sessionKey];
        return {
          ...hit,
          title: resolveHistoryDisplayTitle(meta?.alias, generated?.title, hit.title, hit.session_id),
        };
      });
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
      await deleteFavoriteSnapshotsForSession(session.source, session.session_id);
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
      await db.execute(
        "UPDATE session_meta SET starred = 0, updated_at = $3 WHERE source = $1 AND session_id = $2",
        [session.source, session.session_id, updatedAt]
      );
      await deleteFavoriteSnapshotsForSession(session.source, session.session_id);
    }
    if (alias) {
      await invoke("history_title_cancel", { sessionKey });
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

    const nextMetaMap = patch.starred === false ? await readMetaMap() : { ...get().metaMap, [sessionKey]: nextMeta };
    const generatedTitleMap = get().generatedTitleMap;
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
    const sessions = await applyFavoriteSnapshots(
      summaries,
      nextMetaMap,
      get().sourceFilter,
      effectiveProjectPathFilter(get()),
      sourceSessionKeys,
      generatedTitleMap,
    );
    set({ metaMap: nextMetaMap, sessions });
  },

  cancelAutomaticSmartTitles: () => {
    cancelAutomaticTitleQueue();
  },

  generateSmartTitle: async (sessionKey, triggerKind = "manual") => {
    if (triggerKind === "automatic" && !useSettingsStore.getState().historySmartTitle.enabled) {
      throw new Error("history_title_auto_disabled");
    }
    const activeTrigger = smartTitleRequestKinds.get(sessionKey);
    if (triggerKind === "manual" && activeTrigger === "automatic") {
      await cancelAutomaticTitle(sessionKey);
      smartTitleRequestKinds.delete(sessionKey);
    } else if (activeTrigger) {
      throw new Error("history_title_pending");
    }
    smartTitleRequestKinds.set(sessionKey, triggerKind);
    set((state) => ({
      smartTitleInFlightSessionKeys: new Set(state.smartTitleInFlightSessionKeys).add(sessionKey),
    }));
    try {
      const target = get().sessions.find((item) => item.sessionKey === sessionKey);
      if (!target) throw new Error("history_title_session_missing");
      const identity = titleSourceIdentity(target);
      if (identity.transportKind !== "ssh" && target.read_only) {
        throw new Error("history_title_remote_not_supported");
      }
      if (
        identity.transportKind === "ssh"
        && (!get().remoteContext || get().remoteContext?.sourceInstanceId !== identity.sourceInstanceId)
      ) {
        throw new Error("history_title_remote_online_required");
      }
      const requireLiveDetail = identity.transportKind === "ssh";
      if (requireLiveDetail || get().activeSessionKey !== sessionKey || !get().activeSession) {
        await get().openSession(sessionKey, { requireLiveDetail });
      }
      const detail = get().activeSessionKey === sessionKey ? get().activeSession : null;
      if (!detail) throw new Error("history_title_detail_missing");
      const candidate: HistoryTitleCandidate | null = await extractHistoryTitleCandidate(detail, sessionKey);
      if (!candidate) throw new Error("history_title_candidate_missing");

      const selection = useSettingsStore.getState().historySmartTitle;
      if (triggerKind === "automatic" && !selection.enabled) {
        throw new Error("history_title_auto_disabled");
      }
      if (!selection.providerAppType || !selection.providerId || !selection.modelId) {
        throw new Error("history_title_provider_not_selected");
      }
      const raw = await invoke<unknown>("history_title_generate", {
        request: {
          sessionKey,
          sourceId: identity.sourceId,
          sourceInstanceId: identity.sourceInstanceId,
          sourceSessionId: identity.sourceSessionId,
          transportKind: identity.transportKind,
          sourceMessageIdentity: candidate.identity,
          sourceContentSha256: candidate.contentSha256,
          candidateTextSha256: candidate.inputContentSha256,
          candidateText: candidate.text,
          triggerKind,
          providerAppType: selection.providerAppType,
          providerId: selection.providerId,
          modelId: selection.modelId,
        },
      });
      const meta = normalizeGeneratedTitleResponse(raw);
      if (!meta) throw new Error("history_title_invalid_response");
      set((state) => ({
        generatedTitleMap: { ...state.generatedTitleMap, [sessionKey]: meta },
        sessions: state.sessions.map((view) =>
          view.sessionKey === sessionKey ? generatedTitleView(view, meta) : view
        ),
      }));
    } finally {
      if (smartTitleRequestKinds.get(sessionKey) === triggerKind) {
        smartTitleRequestKinds.delete(sessionKey);
        set((state) => {
          if (!state.smartTitleInFlightSessionKeys.has(sessionKey)) return {};
          const smartTitleInFlightSessionKeys = new Set(state.smartTitleInFlightSessionKeys);
          smartTitleInFlightSessionKeys.delete(sessionKey);
          return { smartTitleInFlightSessionKeys };
        });
      }
    }
  },

  clearSmartTitle: async (sessionKey) => {
    const target = get().sessions.find((item) => item.sessionKey === sessionKey);
    if (!target) throw new Error("history_title_session_missing");
    const identity = titleSourceIdentity(target);
    const raw = await invoke<unknown>("history_title_clear", {
      request: {
        sessionKey,
        sourceId: identity.sourceId,
        sourceInstanceId: identity.sourceInstanceId,
        sourceSessionId: identity.sourceSessionId,
        transportKind: identity.transportKind,
        sourceContentSha256: get().generatedTitleMap[sessionKey]?.sourceContentSha256 ?? null,
      },
    });
    const meta = normalizeGeneratedTitleResponse(raw);
    if (!meta) throw new Error("history_title_invalid_response");
    set((state) => ({
      generatedTitleMap: { ...state.generatedTitleMap, [sessionKey]: meta },
      sessions: state.sessions.map((view) =>
        view.sessionKey === sessionKey ? generatedTitleView(view, meta) : view
      ),
    }));
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
