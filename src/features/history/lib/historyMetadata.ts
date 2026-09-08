import { getDb } from "../../../shared/platform/db";
import { logWarn } from "../../../shared/platform/logger";
import { resolveHistoryDisplayTitle } from "./historyTitle";
import type {
  HistoryGeneratedTitleMeta,
  HistorySessionDetail,
  HistorySessionSummary,
  HistorySessionRef,
  HistorySessionView,
  HistorySource,
  HistorySourceFilter,
  SessionFavoriteSnapshot,
  SessionMeta,
} from "../../../shared/types/index";
import { type SessionMetaMap, type GeneratedTitleMap, type HistoryEditOp } from "../types/historyStoreTypes";
import {
  normalizeSessionRef,
  normalizeDetail,
  summarySessionKey,
  normalizeMetaPath,
  snapshotMatchesFilters,
  parseTags,
  normalizeGeneratedTitleMeta,
} from "./historyNormalization";

export function toViewWithGeneratedTitle(
  summary: HistorySessionSummary,
  meta?: SessionMeta,
  generatedTitle?: HistoryGeneratedTitleMeta,
): HistorySessionView {
  const alias = meta?.alias ?? "";
  const starred = meta ? meta.starred === 1 : false;
  const tags = meta ? parseTags(meta.tags_json) : [];
  const displayTitle = resolveHistoryDisplayTitle(alias, generatedTitle?.title, summary.title, summary.session_id);
  return {
    ...summary,
    sessionKey: summarySessionKey(summary),
    alias,
    starred,
    tags,
    displayTitle,
    generatedTitle,
  };
}

export function applyMeta(
  summaries: HistorySessionSummary[],
  metaMap: SessionMetaMap,
  generatedTitleMap: GeneratedTitleMap = {},
): HistorySessionView[] {
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
    return toViewWithGeneratedTitle(summary, meta, generatedTitleMap[key]);
  });
  return sortSessionViews(views);
}

export function sortSessionViews(views: HistorySessionView[]): HistorySessionView[] {
  return [...views].sort((a, b) => {
    if (a.starred !== b.starred) {
      return a.starred ? -1 : 1;
    }
    return b.updated_at - a.updated_at;
  });
}

export function viewToSummary(view: HistorySessionView): HistorySessionSummary {
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

export async function readMetaMap(): Promise<SessionMetaMap> {
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

export async function readGeneratedTitleMap(): Promise<GeneratedTitleMap> {
  const db = await getDb();
  const rows = await db.select<unknown[]>(
    "SELECT * FROM history_generated_titles ORDER BY updated_at DESC",
  );
  const result: GeneratedTitleMap = {};
  for (const row of rows) {
    const meta = normalizeGeneratedTitleMeta(row);
    if (meta) result[meta.sessionKey] = meta;
  }
  return result;
}

export function snapshotToSummary(snapshot: SessionFavoriteSnapshot): HistorySessionSummary {
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

export async function readFavoriteSnapshots(
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

export async function readFavoriteSnapshotDetail(sessionKey: string): Promise<HistorySessionDetail | null> {
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

export async function writeFavoriteSnapshot(sessionKey: string, detail: HistorySessionDetail): Promise<void> {
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

export async function deleteFavoriteSnapshot(sessionKey: string): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM session_favorite_snapshots WHERE session_key = $1", [sessionKey]);
}

export async function deleteFavoriteSnapshotsForSession(source: HistorySource, sessionId: string): Promise<void> {
  const db = await getDb();
  await db.execute(
    "DELETE FROM session_favorite_snapshots WHERE source = $1 AND session_id = $2",
    [source, sessionId]
  );
}

export async function insertEditAuditRecord(entry: {
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

export function mergeDetailIntoSessions(
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
            displayTitle: resolveHistoryDisplayTitle(
              item.alias,
              item.generatedTitle?.title,
              detail.title,
              detail.session_id,
            ),
          }
        : item
    )
  );
}

export async function applyFavoriteSnapshots(
  summaries: HistorySessionSummary[],
  metaMap: SessionMetaMap,
  sourceFilter: HistorySourceFilter,
  projectPathFilter: string | null,
  sourceSessionKeys?: Set<string>,
  generatedTitleMap: GeneratedTitleMap = {},
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

  return applyMeta(Array.from(summaryMap.values()), metaMap, generatedTitleMap).map((session) =>
    snapshotKeys.has(session.sessionKey) && !sourceKeys.has(session.sessionKey)
      ? { ...session, favoriteSnapshot: true }
      : session
  );
}

export function titleSourceIdentity(session: HistorySessionView): {
  sourceId: string;
  sourceInstanceId: string;
  sourceSessionId: string;
  transportKind: string;
} {
  const ref = session.session_ref;
  return {
    sourceId: ref?.sourceId ?? session.source,
    sourceInstanceId: ref?.sourceInstanceId ?? session.file_path,
    sourceSessionId: ref?.sourceSessionId ?? session.session_id,
    transportKind: ref?.transportKind ?? "local",
  };
}

export function generatedTitleView(
  view: HistorySessionView,
  generatedTitle: HistoryGeneratedTitleMeta | undefined,
): HistorySessionView {
  return {
    ...view,
    generatedTitle,
    displayTitle: resolveHistoryDisplayTitle(
      view.alias,
      generatedTitle?.title,
      view.title,
      view.session_id,
    ),
  };
}
