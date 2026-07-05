import type { HistorySource, Project, TerminalSession } from "./types";
import type { SyncedExternalSession } from "../stores/externalSessionSyncStore";

export interface SyncedHistoryGroup {
  key: string;
  name: string;
  cwd: string;
  updatedAt: number;
  sessions: SyncedExternalSession[];
}

export interface SyncedHistoryGrouping {
  byProjectId: Map<string, SyncedHistoryGroup[]>;
  orphanGroups: SyncedHistoryGroup[];
}

interface SyncedLaunchTarget {
  projectId?: string;
  cwd?: string;
  title?: string;
  startupCmd?: string;
}

export function sourceLabel(source: HistorySource): string {
  return source === "codex" ? "Codex" : "Claude";
}

export function sourceTool(source: HistorySource): string {
  return source === "codex" ? "codex" : "claude";
}

export function formatRelativeTime(ms: number): string {
  if (!ms) return "";
  const diff = Math.max(0, Date.now() - ms);
  const minute = 60_000;
  const hour = minute * 60;
  const day = hour * 24;
  const week = day * 7;
  const month = day * 30;
  if (diff < minute) return "刚刚";
  if (diff < hour) return `${Math.max(1, Math.floor(diff / minute))} 分`;
  if (diff < day) return `${Math.max(1, Math.floor(diff / hour))} 小时`;
  if (diff < week) return `${Math.max(1, Math.floor(diff / day))} 天`;
  if (diff < month) return `${Math.max(1, Math.floor(diff / week))} 周`;
  return `${Math.max(1, Math.floor(diff / month))} 个月`;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/g, "").toLowerCase();
}

function normalizeText(value?: string | null): string {
  return value?.trim() ?? "";
}

function isSameOrChildPath(path: string, root: string): boolean {
  const normalizedPath = normalizePath(path);
  const normalizedRoot = normalizePath(root);
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
}

function pathDepth(path: string): number {
  return normalizePath(path).split("/").filter(Boolean).length;
}

function basenameFromPath(path: string): string {
  const parts = normalizePath(path).split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

function matchesProjectSource(project: Project, source: HistorySource): boolean {
  const cliTool = project.cli_tool.trim().toLowerCase();
  if (!cliTool) return true;
  return source === "codex" ? cliTool.includes("codex") : cliTool.includes("claude");
}

function findContainingProject(projects: Project[], session: SyncedExternalSession): Project | undefined {
  const matches = projects
    .filter((project) => project.path && isSameOrChildPath(session.cwd, project.path))
    .sort((a, b) => normalizePath(b.path).length - normalizePath(a.path).length);
  return matches.find((project) => matchesProjectSource(project, session.source));
}

function findSyncedAncestorSession(
  sessions: SyncedExternalSession[],
  session: SyncedExternalSession
): SyncedExternalSession | undefined {
  return sessions
    .filter((candidate) => {
      if (!candidate.cwd || candidate.key === session.key) return false;
      if (pathDepth(candidate.cwd) < 3) return false;
      return isSameOrChildPath(session.cwd, candidate.cwd);
    })
    .sort((a, b) => normalizePath(b.cwd).length - normalizePath(a.cwd).length)[0];
}

function getOrphanProjectGroup(session: SyncedExternalSession, orphanSessions: SyncedExternalSession[]) {
  const ancestor = findSyncedAncestorSession(orphanSessions, session);
  if (ancestor) {
    return {
      key: `cwd:${normalizePath(ancestor.cwd)}`,
      name: ancestor.projectName || basenameFromPath(ancestor.cwd),
      cwd: ancestor.cwd,
    };
  }
  return {
    key: `cwd:${normalizePath(session.cwd)}`,
    name: session.projectName || basenameFromPath(session.cwd),
    cwd: session.cwd,
  };
}

function pushGroup(map: Map<string, SyncedHistoryGroup>, key: string, name: string, cwd: string, session: SyncedExternalSession) {
  const group = map.get(key);
  if (group) {
    group.sessions.push(session);
    group.updatedAt = Math.max(group.updatedAt, session.updatedAt);
    return;
  }
  map.set(key, {
    key,
    name,
    cwd,
    updatedAt: session.updatedAt,
    sessions: [session],
  });
}

function finalizeGroups(groups: Iterable<SyncedHistoryGroup>): SyncedHistoryGroup[] {
  return Array.from(groups)
    .map((group) => ({
      ...group,
      sessions: [...group.sessions].sort((a, b) => b.updatedAt - a.updatedAt),
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function groupSyncedExternalSessions(
  sessions: SyncedExternalSession[],
  projects: Project[]
): SyncedHistoryGrouping {
  const sessionsByProjectId = new Map<string, SyncedExternalSession[]>();
  const orphanSessions: SyncedExternalSession[] = [];

  for (const session of sessions) {
    const project = findContainingProject(projects, session);
    if (!project) {
      orphanSessions.push(session);
      continue;
    }
    const bucket = sessionsByProjectId.get(project.id) ?? [];
    bucket.push(session);
    sessionsByProjectId.set(project.id, bucket);
  }

  const byProjectId = new Map<string, SyncedHistoryGroup[]>();
  for (const project of projects) {
    const projectSessions = sessionsByProjectId.get(project.id);
    if (!projectSessions?.length) continue;
    const sources = new Set(projectSessions.map((session) => session.source));
    const shouldSplitBySource = sources.size > 1;
    const map = new Map<string, SyncedHistoryGroup>();
    for (const session of projectSessions) {
      const key = shouldSplitBySource ? `project:${project.id}:${session.source}` : `project:${project.id}`;
      const name = shouldSplitBySource ? `${project.name} · ${sourceLabel(session.source)}` : project.name;
      pushGroup(map, key, name, project.path || session.cwd, session);
    }
    byProjectId.set(project.id, finalizeGroups(map.values()));
  }

  const orphanSourcesByProject = new Map<string, Set<HistorySource>>();
  for (const session of orphanSessions) {
    const projectKey = getOrphanProjectGroup(session, orphanSessions).key;
    const sources = orphanSourcesByProject.get(projectKey) ?? new Set<HistorySource>();
    sources.add(session.source);
    orphanSourcesByProject.set(projectKey, sources);
  }

  const orphanMap = new Map<string, SyncedHistoryGroup>();
  for (const session of orphanSessions) {
    const projectGroup = getOrphanProjectGroup(session, orphanSessions);
    const shouldSplitBySource = (orphanSourcesByProject.get(projectGroup.key)?.size ?? 0) > 1;
    const key = shouldSplitBySource ? `${projectGroup.key}:${session.source}` : projectGroup.key;
    const name = shouldSplitBySource ? `${projectGroup.name} · ${sourceLabel(session.source)}` : projectGroup.name;
    pushGroup(orphanMap, key, name, projectGroup.cwd, session);
  }

  return {
    byProjectId,
    orphanGroups: finalizeGroups(orphanMap.values()),
  };
}

export function findMatchingSyncedTerminalSession(
  sessions: TerminalSession[],
  target: SyncedLaunchTarget
): TerminalSession | undefined {
  const startupCmd = normalizeText(target.startupCmd);
  if (!startupCmd) return undefined;

  const projectId = normalizeText(target.projectId);
  const cwd = normalizePath(normalizeText(target.cwd));
  const title = normalizeText(target.title);

  return sessions.find((session) => {
    if (session.kind && session.kind !== "pty") return false;
    return (
      normalizeText(session.projectId) === projectId &&
      normalizePath(normalizeText(session.cwd)) === cwd &&
      (!title || normalizeText(session.title) === title) &&
      normalizeText(session.startupCmd) === startupCmd
    );
  });
}

const pendingSyncedLaunchKeys = new Set<string>();

export function claimPendingSyncedLaunch(key: string): boolean {
  if (pendingSyncedLaunchKeys.has(key)) return false;
  pendingSyncedLaunchKeys.add(key);
  return true;
}

export function releasePendingSyncedLaunch(key: string): void {
  pendingSyncedLaunchKeys.delete(key);
}
