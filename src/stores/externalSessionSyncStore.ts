import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { Store } from "@tauri-apps/plugin-store";
import { toast } from "sonner";
import { useProjectStore } from "./projectStore";
import { getCliManagerDataPaths } from "../lib/appPaths";
import { getHistoryPathArgs } from "../lib/historyPathArgs";
import { logInfo, logWarn } from "../lib/logger";
import { translateCurrent } from "../lib/i18n";
import type { HistorySource, Project } from "../lib/types";

export type ExternalSessionSource = Extract<HistorySource, "claude" | "codex">;

interface HistorySessionSummaryLike {
  session_id?: unknown;
  sessionId?: unknown;
  source?: unknown;
  project_key?: unknown;
  projectKey?: unknown;
  title?: unknown;
  file_path?: unknown;
  filePath?: unknown;
  cwd?: unknown;
  created_at?: unknown;
  createdAt?: unknown;
  updated_at?: unknown;
  updatedAt?: unknown;
  message_count?: unknown;
  messageCount?: unknown;
}

export interface ExternalSessionCandidate {
  key: string;
  source: ExternalSessionSource;
  sessionId: string;
  projectKey: string;
  filePath: string;
  projectName: string;
  cwd: string;
  title: string;
  startupCmd: string;
  updatedAt: number;
}

export interface SyncedExternalSession extends ExternalSessionCandidate {
  syncedAt: number;
}

export interface ExternalSessionProjectCandidate {
  key: string;
  source: ExternalSessionSource;
  name: string;
  cwd: string;
  updatedAt: number;
  sessionCount: number;
  sessions: ExternalSessionCandidate[];
}

type ExternalSessionSyncDialogMode = "initial" | "manual";

interface ExternalSessionSyncStore {
  loaded: boolean;
  initialSyncPromptHandled: boolean;
  acceptedKeys: string[];
  ignoredKeys: string[];
  ignoredProjectKeys: string[];
  pendingKeys: string[];
  syncedSessions: SyncedExternalSession[];
  projectCandidates: ExternalSessionProjectCandidate[];
  dialogOpen: boolean;
  dialogMode: ExternalSessionSyncDialogMode;
  scanningProjects: boolean;
  syncingProjects: boolean;
  load: () => Promise<void>;
  scanAndPrompt: () => Promise<void>;
  startMonitor: () => void;
  stopMonitor: () => void;
  openInitialDialog: () => Promise<void>;
  openManualDialog: () => Promise<void>;
  closeProjectDialog: () => Promise<void>;
  syncProjectCandidates: (keys: string[], shell?: string) => Promise<void>;
  ignoreProjectCandidates: (keys: string[]) => Promise<void>;
  accept: (candidate: ExternalSessionCandidate) => Promise<void>;
  ignore: (candidate: ExternalSessionCandidate) => Promise<void>;
  removeSyncedSessions: (keys: string[]) => Promise<void>;
}

const INITIAL_PROJECT_SCAN_LIMIT = 60;
const MANUAL_PROJECT_SCAN_LIMIT = 240;
const STORE_SCHEMA_VERSION = 3;

let store: Store | null = null;
let initialCheckStarted = false;
let projectScanInFlight: Promise<ExternalSessionProjectCandidate[]> | null = null;
const deletedKeysThisSession = new Set<string>();

async function getStore() {
  if (!store) {
    const paths = await getCliManagerDataPaths();
    store = await Store.load(paths.externalSessionSyncStorePath, { autoSave: 0, defaults: {} });
  }
  return store;
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

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const item of value) {
    const text = asString(item).trim();
    if (text && !result.includes(text)) result.push(text);
  }
  return result;
}

function isCliManagerSyncArtifactText(value: string): boolean {
  const text = value.toLowerCase();
  return (
    text.includes("cli-manager 同步聚合会话")
    || text.includes(".cli-manager/synced-history/")
    || text.includes("同步记录已加载")
  );
}

function normalizeSyncedSessions(value: unknown): SyncedExternalSession[] {
  if (!Array.isArray(value)) return [];
  const result: SyncedExternalSession[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const rec = (raw ?? {}) as Partial<Record<keyof SyncedExternalSession, unknown>>;
    const source = normalizeSource(rec.source);
    const key = asString(rec.key).trim();
    const sessionId = asString(rec.sessionId).trim();
    const filePath = asString(rec.filePath).trim();
    const cwd = asString(rec.cwd).trim();
    const rawTitle = asString(rec.title);
    if (isCliManagerSyncArtifactText(rawTitle)) continue;
    const projectKey = asString(rec.projectKey).trim() || inferProjectKey(source, cwd, filePath);
    const startupCmd = normalizeStoredResumeCommand(source, sessionId, asString(rec.startupCmd).trim());
    if (!source || !key || !sessionId || !projectKey || !filePath || !cwd || !startupCmd || seen.has(key)) continue;
    seen.add(key);
    const fallbackTitle = basenameFromPath(cwd) || sourceLabel(source);
    const title = cleanTitle(rawTitle);
    result.push({
      key,
      source,
      sessionId,
      projectKey,
      filePath,
      projectName: asString(rec.projectName).trim() || basenameFromPath(cwd) || sourceLabel(source),
      cwd,
      title: isInternalTitle(title) ? fallbackTitle : title,
      startupCmd,
      updatedAt: asNumber(rec.updatedAt),
      syncedAt: asNumber(rec.syncedAt) || Date.now(),
    });
  }
  return result.sort((a, b) => b.updatedAt - a.updatedAt);
}

function normalizeSource(value: unknown): ExternalSessionSource | null {
  const source = asString(value).trim().toLowerCase();
  return source === "codex" || source === "claude" ? source : null;
}

function normalizePathForKey(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/\/+$/g, "").toLowerCase();
}

function pathDepth(path: string): number {
  return normalizePathForKey(path).split("/").filter(Boolean).length;
}

function isSameOrChildPath(path: string, root: string): boolean {
  const normalizedPath = normalizePathForKey(path);
  const normalizedRoot = normalizePathForKey(root);
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
}

function matchesProjectSource(project: Project, source: ExternalSessionSource): boolean {
  const cliTool = project.cli_tool.trim().toLowerCase();
  if (!cliTool) return true;
  return source === "codex" ? cliTool.includes("codex") : cliTool.includes("claude");
}

function findContainingProject(projects: Project[], candidate: ExternalSessionCandidate): Project | undefined {
  const matches = projects
    .filter((project) => project.path && isSameOrChildPath(candidate.cwd, project.path))
    .sort((a, b) => normalizePathForKey(b.path).length - normalizePathForKey(a.path).length);
  return matches.find((project) => matchesProjectSource(project, candidate.source));
}

function findAncestorCandidate(candidates: ExternalSessionCandidate[], candidate: ExternalSessionCandidate): ExternalSessionCandidate | undefined {
  return candidates
    .filter((item) => {
      if (!item.cwd || item.key === candidate.key) return false;
      if (pathDepth(item.cwd) < 3) return false;
      return isSameOrChildPath(candidate.cwd, item.cwd);
    })
    .sort((a, b) => normalizePathForKey(b.cwd).length - normalizePathForKey(a.cwd).length)[0];
}

function makeSessionCandidateKey(source: ExternalSessionSource, sessionId: string, filePath: string): string {
  return `${source}:${sessionId}:${normalizePathForKey(filePath)}`;
}

function basenameFromPath(path: string): string {
  const normalized = path.trim().replace(/\\/g, "/").replace(/\/+$/g, "");
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

function inferProjectKey(source: ExternalSessionSource | null, cwd: string, filePath: string): string {
  if (cwd.trim()) return basenameFromPath(cwd);
  const normalized = filePath.trim().replace(/\\/g, "/").replace(/\/+$/g, "");
  const parts = normalized.split("/").filter(Boolean);
  if (source === "claude") {
    const projectsIndex = parts.findIndex((part) => part === "projects");
    if (projectsIndex >= 0 && parts[projectsIndex + 1]) return parts[projectsIndex + 1];
    return parts.length >= 2 ? parts[parts.length - 2] : "default";
  }
  const sessionsIndex = parts.findIndex((part) => part === "sessions");
  if (sessionsIndex >= 0 && parts[parts.length - 2]) return parts[parts.length - 2];
  return parts.length >= 2 ? parts[parts.length - 2] : "sessions";
}

function cleanTitle(value: string): string {
  return value
    .replace(/^\s{0,3}#{1,6}\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isInternalTitle(value: string): boolean {
  const title = cleanTitle(value);
  if (!title) return true;
  if (isCliManagerSyncArtifactText(title)) return true;
  if (/^AGENTS\.md instructions\b/i.test(title)) return true;
  if (/^<[^>]+>$/.test(title)) return true;
  if (/^(system|developer|user)_instructions$/i.test(title)) return true;
  if (/^(system|developer) instructions$/i.test(title)) return true;
  return false;
}

function normalizeSummary(raw: unknown) {
  const rec = (raw ?? {}) as HistorySessionSummaryLike;
  const source = normalizeSource(rec.source);
  if (!source) return null;
  return {
    sessionId: asString(rec.session_id ?? rec.sessionId),
    source,
    projectKey: asString(rec.project_key ?? rec.projectKey),
    title: asString(rec.title),
    filePath: asString(rec.file_path ?? rec.filePath),
    cwd: asString(rec.cwd).trim(),
    updatedAt: asNumber(rec.updated_at ?? rec.updatedAt),
    messageCount: asNumber(rec.message_count ?? rec.messageCount),
  };
}

function resolveResumeCommand(source: ExternalSessionSource, sessionId: string): string | null {
  const trimmed = sessionId.trim();
  if (!trimmed || /\s/.test(trimmed) || /[\r\n]/.test(trimmed)) return null;
  return source === "claude" ? `claude --resume ${trimmed}` : `codex resume --no-alt-screen ${trimmed}`;
}

function normalizeStoredResumeCommand(source: ExternalSessionSource | null, sessionId: string, startupCmd: string): string {
  if (!source) return startupCmd;
  const fallback = resolveResumeCommand(source, sessionId);
  if (!startupCmd) return fallback ?? "";
  if (source !== "codex" || !fallback) return startupCmd;
  return startupCmd === `codex resume ${sessionId.trim()}` ? fallback : startupCmd;
}

function isAbsolutePathLike(path: string): boolean {
  const value = path.trim();
  return value.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

function normalizeCandidate(summary: NonNullable<ReturnType<typeof normalizeSummary>>): ExternalSessionCandidate | null {
  if (isCliManagerSyncArtifactText(summary.title)) return null;
  const cwd = summary.cwd || (isAbsolutePathLike(summary.projectKey) ? summary.projectKey.trim() : "");
  if (!cwd) return null;
  const startupCmd = resolveResumeCommand(summary.source, summary.sessionId);
  if (!startupCmd) return null;
  const projectName = basenameFromPath(cwd) || summary.projectKey || summary.title || summary.source;
  const summaryTitle = isInternalTitle(summary.title) ? "" : cleanTitle(summary.title);
  const title = summaryTitle || projectName;
  return {
    key: makeSessionCandidateKey(summary.source, summary.sessionId, summary.filePath),
    source: summary.source,
    sessionId: summary.sessionId,
    projectKey: summary.projectKey,
    filePath: summary.filePath,
    projectName,
    cwd,
    title,
    startupCmd,
    updatedAt: summary.updatedAt,
  };
}

function sourceLabel(source: ExternalSessionSource): string {
  return source === "codex" ? "Codex" : "Claude";
}

function stripSourceSuffix(name: string): string {
  return name.replace(/\s+·\s+(?:Codex|Claude)$/i, "").trim() || name;
}

function uniqueStrings(values: string[]): string[] {
  const result: string[] = [];
  for (const value of values) {
    if (value && !result.includes(value)) result.push(value);
  }
  return result;
}

function upsertManySyncedSessions(
  sessions: SyncedExternalSession[],
  candidates: ExternalSessionCandidate[]
): SyncedExternalSession[] {
  let next = sessions;
  for (const candidate of candidates) {
    next = upsertSyncedSession(next, candidate);
  }
  return next;
}

function candidateProjectRoot(candidate: ExternalSessionCandidate, rootCandidates: ExternalSessionCandidate[], projects: Project[]) {
  const project = findContainingProject(projects, candidate);
  if (project) {
    return {
      key: `project:${project.id}`,
      name: stripSourceSuffix(project.name),
      cwd: project.path,
    };
  }
  const ancestor = findAncestorCandidate(rootCandidates, candidate);
  if (ancestor) {
    return {
      key: `cwd:${normalizePathForKey(ancestor.cwd)}`,
      name: ancestor.projectName || basenameFromPath(ancestor.cwd) || sourceLabel(ancestor.source),
      cwd: ancestor.cwd,
    };
  }
  return {
    key: `cwd:${normalizePathForKey(candidate.cwd)}`,
    name: candidate.projectName || basenameFromPath(candidate.cwd) || sourceLabel(candidate.source),
    cwd: candidate.cwd,
  };
}

function groupProjectCandidates(
  candidates: ExternalSessionCandidate[],
  projects: Project[],
  rootCandidates = candidates
): ExternalSessionProjectCandidate[] {
  const sourcesByProject = new Map<string, Set<ExternalSessionSource>>();
  for (const candidate of candidates) {
    const root = candidateProjectRoot(candidate, rootCandidates, projects);
    const sources = sourcesByProject.get(root.key) ?? new Set<ExternalSessionSource>();
    sources.add(candidate.source);
    sourcesByProject.set(root.key, sources);
  }

  const map = new Map<string, ExternalSessionProjectCandidate>();
  for (const candidate of candidates) {
    const root = candidateProjectRoot(candidate, rootCandidates, projects);
    const splitBySource = (sourcesByProject.get(root.key)?.size ?? 0) > 1;
    const key = `${root.key}:${candidate.source}`;
    const rootName = stripSourceSuffix(root.name);
    const name = splitBySource ? `${rootName} · ${sourceLabel(candidate.source)}` : rootName;
    const group = map.get(key);
    if (group) {
      group.sessions.push(candidate);
      group.sessionCount += 1;
      group.updatedAt = Math.max(group.updatedAt, candidate.updatedAt);
      continue;
    }
    map.set(key, {
      key,
      source: candidate.source,
      name,
      cwd: root.cwd,
      updatedAt: candidate.updatedAt,
      sessionCount: 1,
      sessions: [candidate],
    });
  }

  return Array.from(map.values())
    .map((group) => ({
      ...group,
      sessions: [...group.sessions].sort((a, b) => b.updatedAt - a.updatedAt),
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function upsertSyncedSession(sessions: SyncedExternalSession[], candidate: ExternalSessionCandidate): SyncedExternalSession[] {
  const next: SyncedExternalSession = {
    ...candidate,
    syncedAt: sessions.find((item) => item.key === candidate.key)?.syncedAt ?? Date.now(),
  };
  return [next, ...sessions.filter((item) => item.key !== candidate.key)]
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function sourceCliTool(source: ExternalSessionSource): string {
  return source === "codex" ? "codex" : "claude";
}

async function ensureExternalSessionGroup(name: string) {
  const trimmed = name.trim();
  const existing = useProjectStore
    .getState()
    .groups
    .find((group) => group.parent_id === null && group.name === trimmed);
  if (existing) return existing;
  return useProjectStore.getState().createGroup({ name: trimmed });
}

function parseProjectGroupKey(key: string): string | null {
  return key.match(/^project:([^:]+)/)?.[1] ?? null;
}

async function ensureProjectsForExternalSessionGroups(
  groups: ExternalSessionProjectCandidate[],
  shell?: string
): Promise<number> {
  if (groups.length === 0) return 0;
  // 项目列表未加载完成时禁止物化：此时 findContainingProject 会把已有项目误判为
  // 孤儿会话，导致重复创建分组/项目（如崩溃重启后 SQLite 尚未就绪的场景）。
  if (!useProjectStore.getState().loaded) {
    logWarn("Skip materializing external sessions: project store not loaded yet");
    return 0;
  }

  const projectStore = useProjectStore.getState();
  let projects = projectStore.projects;
  let createdCount = 0;

  for (const group of groups) {
    if (!group.cwd.trim()) continue;
    const cliTool = sourceCliTool(group.source);
    const sourceName = sourceLabel(group.source);
    const existingProjectId = parseProjectGroupKey(group.key);
    const existingProject = existingProjectId
      ? projects.find((project) => project.id === existingProjectId)
      : null;

    if (existingProject && matchesProjectSource(existingProject, group.source)) continue;

    const representative = group.sessions[0] ?? {
      key: group.key,
      source: group.source,
      sessionId: "",
      projectKey: "",
      filePath: "",
      projectName: group.name,
      cwd: group.cwd,
      title: group.name,
      startupCmd: "",
      updatedAt: group.updatedAt,
    };
    const existing = findContainingProject(projects, {
      ...representative,
      cwd: group.cwd,
      source: group.source,
    });
    if (existing) continue;
    const externalGroup = await ensureExternalSessionGroup(group.name);

    const created = await useProjectStore.getState().createProject({
      name: sourceName,
      path: group.cwd,
      group_id: externalGroup.id,
      cli_tool: cliTool,
      startup_cmd: "",
      env_vars: "{}",
      shell,
      provider_overrides: "{}",
    });
    projects = [...useProjectStore.getState().projects, created];
    createdCount += 1;
  }

  return createdCount;
}

async function ensureProjectsForSyncedSessions(sessions: SyncedExternalSession[]): Promise<number> {
  if (sessions.length === 0) return 0;
  const groups = groupProjectCandidates(
    sessions,
    useProjectStore.getState().projects,
    sessions
  );
  return ensureProjectsForExternalSessionGroups(groups);
}

async function persistState(
  acceptedKeys: string[],
  ignoredKeys: string[],
  ignoredProjectKeys: string[],
  syncedSessions: SyncedExternalSession[],
  initialSyncPromptHandled: boolean
): Promise<void> {
  const s = await getStore();
  await Promise.all([
    s.set("schemaVersion", STORE_SCHEMA_VERSION),
    s.set("initialSyncPromptHandled", initialSyncPromptHandled),
    s.set("acceptedKeys", acceptedKeys),
    s.set("ignoredKeys", ignoredKeys),
    s.set("ignoredProjectKeys", ignoredProjectKeys),
    s.set("syncedSessions", syncedSessions),
  ]);
}

async function persistCurrentState(state: ExternalSessionSyncStore): Promise<void> {
  await persistState(
    state.acceptedKeys,
    state.ignoredKeys,
    state.ignoredProjectKeys,
    state.syncedSessions,
    state.initialSyncPromptHandled
  );
}

function handledSessionKeys(state: ExternalSessionSyncStore): Set<string> {
  return new Set([
    ...state.acceptedKeys,
    ...state.ignoredKeys,
    ...state.pendingKeys,
    ...state.syncedSessions.map((session) => session.key),
    ...deletedKeysThisSession,
  ]);
}

async function scanProjectCandidates(
  handledKeys: Set<string>,
  ignoredProjectKeys: Set<string>,
  limit: number
): Promise<ExternalSessionProjectCandidate[]> {
  if (projectScanInFlight) return projectScanInFlight;
  projectScanInFlight = (async () => {
    const startedAt = Date.now();
    logInfo("External session project scan started", { limit });
    const projects = useProjectStore.getState().projects;
    const summariesRaw = await invoke<unknown[]>("history_list_sessions", {
      source: null,
      ...(await getHistoryPathArgs()),
      projectPath: null,
      query: null,
      limit,
      offset: 0,
    });
    const summaries = (summariesRaw ?? [])
      .map((item) => normalizeSummary(item))
      .filter((item): item is NonNullable<ReturnType<typeof normalizeSummary>> => Boolean(item))
      .filter((item) => item.sessionId && item.filePath)
      .sort((a, b) => b.updatedAt - a.updatedAt);

    const allCandidates = summaries
      .map((summary) => normalizeCandidate(summary))
      .filter((candidate): candidate is ExternalSessionCandidate => Boolean(candidate));

    const missingProjectCandidates = allCandidates.filter((candidate) => !findContainingProject(projects, candidate));
    const unsyncedCandidates = missingProjectCandidates.filter((candidate) => !handledKeys.has(candidate.key));
    const projectCandidates = groupProjectCandidates(unsyncedCandidates, projects, missingProjectCandidates)
      .filter((project) => !ignoredProjectKeys.has(project.key));
    logInfo("External session project scan finished", {
      durationMs: Date.now() - startedAt,
      summaries: summaries.length,
      candidates: allCandidates.length,
      missingProjects: missingProjectCandidates.length,
      unsynced: unsyncedCandidates.length,
      projects: projectCandidates.length,
    });
    return projectCandidates;
  })().finally(() => {
    projectScanInFlight = null;
  });
  return projectScanInFlight;
}

async function ensureProjectStoreLoaded(reason: "startup" | "interactive"): Promise<void> {
  if (!useProjectStore.getState().loaded) {
    await useProjectStore.getState().fetchAll(reason);
  }
}

export const useExternalSessionSyncStore = create<ExternalSessionSyncStore>((set, get) => ({
  loaded: false,
  initialSyncPromptHandled: false,
  acceptedKeys: [],
  ignoredKeys: [],
  ignoredProjectKeys: [],
  pendingKeys: [],
  syncedSessions: [],
  projectCandidates: [],
  dialogOpen: false,
  dialogMode: "manual",
  scanningProjects: false,
  syncingProjects: false,

  load: async () => {
    const s = await getStore();
    const schemaVersion = asNumber(await s.get("schemaVersion"));
    const acceptedKeys = normalizeStringList(await s.get("acceptedKeys"));
    const syncedSessions = normalizeSyncedSessions(await s.get("syncedSessions"));
    let ignoredKeys = normalizeStringList(await s.get("ignoredKeys"));
    const storedIgnoredProjectKeys = normalizeStringList(await s.get("ignoredProjectKeys"));
    const initialSyncPromptHandled = Boolean(await s.get("initialSyncPromptHandled"));
    const ignoredProjectKeys = uniqueStrings([
      ...storedIgnoredProjectKeys,
      ...groupProjectCandidates(syncedSessions, [], syncedSessions).map((project) => project.key),
    ]);
    if (schemaVersion < STORE_SCHEMA_VERSION) {
      ignoredKeys = [];
    }
    if (schemaVersion < STORE_SCHEMA_VERSION || ignoredProjectKeys.length !== storedIgnoredProjectKeys.length) {
      await persistState(acceptedKeys, ignoredKeys, ignoredProjectKeys, syncedSessions, initialSyncPromptHandled);
    }
    set({
      loaded: true,
      initialSyncPromptHandled,
      acceptedKeys,
      ignoredKeys,
      ignoredProjectKeys,
      syncedSessions,
    });
    void (async () => {
      // 先确保项目列表加载完成，再把已同步的外部会话物化为分组/项目，
      // 否则空项目列表会让所有会话被当作孤儿而重复建组。
      await ensureProjectStoreLoaded("startup");
      await ensureProjectsForSyncedSessions(syncedSessions);
    })().catch((err) => {
      logWarn("Failed to materialize synced external sessions as projects", err);
    });
  },

  scanAndPrompt: async () => {
    await get().openInitialDialog();
  },

  startMonitor: () => {
    if (typeof window === "undefined" || initialCheckStarted) return;
    initialCheckStarted = true;
    void get().openInitialDialog();
  },

  stopMonitor: () => {
    initialCheckStarted = false;
  },

  openInitialDialog: async () => {
    if (!get().loaded) await get().load();
    if (get().initialSyncPromptHandled) return;
    try {
      await ensureProjectStoreLoaded("startup");
      if (useProjectStore.getState().projects.length > 0) {
        set({ initialSyncPromptHandled: true, scanningProjects: false, projectCandidates: [] });
        await persistCurrentState(get());
        return;
      }
      set({ scanningProjects: true, dialogMode: "initial" });
      const projectCandidates = await scanProjectCandidates(
        handledSessionKeys(get()),
        new Set(get().ignoredProjectKeys),
        INITIAL_PROJECT_SCAN_LIMIT
      );
      if (projectCandidates.length === 0) {
        set({ initialSyncPromptHandled: true, scanningProjects: false, projectCandidates: [] });
        await persistCurrentState(get());
        return;
      }
      set({
        projectCandidates,
        dialogMode: "initial",
        dialogOpen: true,
        scanningProjects: false,
      });
    } catch (err) {
      set({ scanningProjects: false });
      logWarn("External session project scan failed", err);
    }
  },

  openManualDialog: async () => {
    if (!get().loaded) await get().load();
    set({ scanningProjects: true, dialogMode: "manual", dialogOpen: false, projectCandidates: [] });
    try {
      await ensureProjectStoreLoaded("interactive");
      const projectCandidates = await scanProjectCandidates(
        handledSessionKeys(get()),
        new Set(get().ignoredProjectKeys),
        MANUAL_PROJECT_SCAN_LIMIT
      );
      set({
        projectCandidates,
        dialogMode: "manual",
        dialogOpen: projectCandidates.length > 0,
        scanningProjects: false,
      });
      if (projectCandidates.length === 0) {
        toast.info(translateCurrent("notifications.externalSessionSync.noSyncableProjects"));
      }
    } catch (err) {
      set({ scanningProjects: false, dialogOpen: false });
      toast.error(translateCurrent("notifications.externalSessionSync.scanFailed"), { description: String(err) });
    }
  },

  closeProjectDialog: async () => {
    const nextInitialHandled = get().dialogMode === "initial" ? true : get().initialSyncPromptHandled;
    set({
      dialogOpen: false,
      scanningProjects: false,
      syncingProjects: false,
      initialSyncPromptHandled: nextInitialHandled,
    });
    await persistCurrentState(get());
  },

  syncProjectCandidates: async (keys, shell) => {
    if (get().syncingProjects) return;

    const selectedKeys = new Set(keys.map((key) => key.trim()).filter(Boolean));
    const selectedProjects = get().projectCandidates.filter((project) => selectedKeys.has(project.key));
    const candidates = selectedProjects.flatMap((project) => project.sessions);
    const nextInitialHandled = get().dialogMode === "initial" ? true : get().initialSyncPromptHandled;

    if (candidates.length === 0) {
      set({ dialogOpen: false, initialSyncPromptHandled: nextInitialHandled });
      await persistCurrentState(get());
      toast.info(translateCurrent("notifications.externalSessionSync.noSelectedProjects"));
      return;
    }

    set({ syncingProjects: true });
    try {
      const createdProjects = await ensureProjectsForExternalSessionGroups(selectedProjects, shell);
      const candidateKeys = candidates.map((candidate) => candidate.key);
      candidateKeys.forEach((key) => deletedKeysThisSession.delete(key));
      const nextAccepted = uniqueStrings([
        ...get().acceptedKeys.filter((key) => !candidateKeys.includes(key)),
        ...candidateKeys,
      ]);
      const nextIgnored = get().ignoredKeys.filter((key) => !candidateKeys.includes(key));
      const nextIgnoredProjects = uniqueStrings([
        ...get().ignoredProjectKeys,
        ...selectedProjects.map((project) => project.key),
      ]);
      const nextSessions = upsertManySyncedSessions(get().syncedSessions, candidates);
      set({
        acceptedKeys: nextAccepted,
        ignoredKeys: nextIgnored,
        ignoredProjectKeys: nextIgnoredProjects,
        pendingKeys: get().pendingKeys.filter((key) => !candidateKeys.includes(key)),
        syncedSessions: nextSessions,
        initialSyncPromptHandled: nextInitialHandled,
        dialogOpen: false,
        syncingProjects: false,
      });
      await persistCurrentState(get());
      toast.success(
        createdProjects > 0
          ? translateCurrent("notifications.externalSessionSync.projectSyncSuccessCreated", {
              projectCount: createdProjects,
              sessionCount: candidates.length,
            })
          : translateCurrent("notifications.externalSessionSync.projectSyncSuccess", {
              projectCount: selectedProjects.length,
              sessionCount: candidates.length,
            })
      );
    } catch (err) {
      set({ syncingProjects: false });
      toast.error(translateCurrent("notifications.externalSessionSync.projectSyncFailed"), { description: String(err) });
    }
  },

  ignoreProjectCandidates: async (keys) => {
    const keySet = new Set(keys.map((key) => key.trim()).filter(Boolean));
    if (keySet.size === 0) return;

    const ignoredProjects = get().projectCandidates.filter((project) => keySet.has(project.key));
    if (ignoredProjects.length === 0) return;

    const ignoredSessionKeys = ignoredProjects.flatMap((project) => project.sessions.map((session) => session.key));
    const remainingProjects = get().projectCandidates.filter((project) => !keySet.has(project.key));
    const nextIgnored = uniqueStrings([...get().ignoredKeys, ...ignoredSessionKeys]);
    const nextIgnoredProjects = uniqueStrings([...get().ignoredProjectKeys, ...ignoredProjects.map((project) => project.key)]);
    const nextInitialHandled = remainingProjects.length === 0 && get().dialogMode === "initial"
      ? true
      : get().initialSyncPromptHandled;

    set({
      ignoredKeys: nextIgnored,
      ignoredProjectKeys: nextIgnoredProjects,
      pendingKeys: get().pendingKeys.filter((key) => !ignoredSessionKeys.includes(key)),
      projectCandidates: remainingProjects,
      dialogOpen: remainingProjects.length > 0,
      initialSyncPromptHandled: nextInitialHandled,
    });
    await persistCurrentState(get());
  },

  accept: async (candidate) => {
    try {
      deletedKeysThisSession.delete(candidate.key);
      const nextAccepted = [...get().acceptedKeys.filter((key) => key !== candidate.key), candidate.key];
      const nextPending = get().pendingKeys.filter((key) => key !== candidate.key);
      const nextSessions = upsertSyncedSession(get().syncedSessions, candidate);
      set({ acceptedKeys: nextAccepted, pendingKeys: nextPending, syncedSessions: nextSessions });
      await persistState(nextAccepted, get().ignoredKeys, get().ignoredProjectKeys, nextSessions, get().initialSyncPromptHandled);
      toast.success(translateCurrent("notifications.externalSessionSync.success", {
        source: sourceLabel(candidate.source),
        name: candidate.title,
      }));
    } catch (err) {
      set((state) => ({ pendingKeys: state.pendingKeys.filter((key) => key !== candidate.key) }));
      toast.error(translateCurrent("notifications.externalSessionSync.failed"), { description: String(err) });
    }
  },

  ignore: async (candidate) => {
    deletedKeysThisSession.delete(candidate.key);
    const nextIgnored = [...get().ignoredKeys.filter((key) => key !== candidate.key), candidate.key];
    const nextPending = get().pendingKeys.filter((key) => key !== candidate.key);
    set({ ignoredKeys: nextIgnored, pendingKeys: nextPending });
    await persistState(get().acceptedKeys, nextIgnored, get().ignoredProjectKeys, get().syncedSessions, get().initialSyncPromptHandled);
  },

  removeSyncedSessions: async (keys) => {
    const keySet = new Set(keys.map((key) => key.trim()).filter(Boolean));
    if (keySet.size === 0) return;

    const nextSessions = get().syncedSessions.filter((session) => !keySet.has(session.key));
    const nextAccepted = get().acceptedKeys.filter((key) => !keySet.has(key));
    const nextPending = get().pendingKeys.filter((key) => !keySet.has(key));
    const nextIgnored = get().ignoredKeys.filter((key) => !keySet.has(key));
    keySet.forEach((key) => deletedKeysThisSession.add(key));

    set({
      acceptedKeys: nextAccepted,
      ignoredKeys: nextIgnored,
      pendingKeys: nextPending,
      syncedSessions: nextSessions,
    });
    await persistState(nextAccepted, nextIgnored, get().ignoredProjectKeys, nextSessions, get().initialSyncPromptHandled);
  },
}));
