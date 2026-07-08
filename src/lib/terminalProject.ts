import type { Project, TerminalSession, WorktreeRecord } from "./types";

export function normalizeProjectPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function findProjectByPath(projects: Project[], path: string | null | undefined): Project | null {
  const normalizedPath = path?.trim() ? normalizeProjectPath(path) : "";
  if (!normalizedPath) return null;

  let bestMatch: Project | null = null;
  let bestMatchLength = -1;

  for (const project of projects) {
    const normalizedProjectPath = normalizeProjectPath(project.path);
    const matches = normalizedPath === normalizedProjectPath || normalizedPath.startsWith(`${normalizedProjectPath}/`);
    if (!matches || normalizedProjectPath.length <= bestMatchLength) continue;
    bestMatch = project;
    bestMatchLength = normalizedProjectPath.length;
  }

  return bestMatch;
}

export function isSameProjectFileContext(
  left: Pick<Project, "id" | "path"> | null | undefined,
  right: Pick<Project, "id" | "path"> | null | undefined
): boolean {
  return Boolean(
    left &&
      right &&
      left.id === right.id &&
      normalizeProjectPath(left.path) === normalizeProjectPath(right.path)
  );
}

export function findWorktreeByPath(worktrees: WorktreeRecord[], path: string | null | undefined): WorktreeRecord | null {
  const normalizedPath = path?.trim() ? normalizeProjectPath(path) : "";
  if (!normalizedPath) return null;

  let bestMatch: WorktreeRecord | null = null;
  let bestMatchLength = -1;
  for (const worktree of worktrees) {
    const normalizedWorktreePath = normalizeProjectPath(worktree.path);
    const matches = normalizedPath === normalizedWorktreePath || normalizedPath.startsWith(`${normalizedWorktreePath}/`);
    if (!matches || normalizedWorktreePath.length <= bestMatchLength) continue;
    bestMatch = worktree;
    bestMatchLength = normalizedWorktreePath.length;
  }
  return bestMatch;
}

export function findWorktreeForSession(
  session: TerminalSession | null,
  sessions: TerminalSession[],
  worktrees: WorktreeRecord[],
  seenSessionIds: Set<string> = new Set()
): WorktreeRecord | null {
  if (!session || seenSessionIds.has(session.id)) return null;
  seenSessionIds.add(session.id);

  if (session.kind === "subagent-transcript" && session.subagent?.parentSessionId) {
    const parentSession = sessions.find((item) => item.id === session.subagent?.parentSessionId) ?? null;
    return findWorktreeForSession(parentSession, sessions, worktrees, seenSessionIds);
  }

  if (session.worktreeId) {
    return worktrees.find((worktree) => worktree.id === session.worktreeId) ?? null;
  }

  if (session.kind === "file-editor") {
    return findWorktreeByPath(worktrees, session.fileEditor?.projectPath);
  }

  return findWorktreeByPath(worktrees, session.cwd);
}

export function projectWithWorktreePath(project: Project, worktree: WorktreeRecord): Project {
  if (normalizeProjectPath(project.path) === normalizeProjectPath(worktree.path)) return project;
  return {
    ...project,
    name: `${project.name} · ${worktree.name}`,
    path: worktree.path,
  };
}

export function projectWithWorktreeProviderOverrides(project: Project, worktree: WorktreeRecord): Project {
  const providerOverrides = worktree.provider_overrides.trim();
  if (!providerOverrides || providerOverrides === "{}") return project;
  return {
    ...project,
    provider_overrides: providerOverrides,
  };
}

export function resolveProjectForSession(
  session: TerminalSession | null,
  sessions: TerminalSession[],
  projects: Project[],
  projectById: Map<string, Project>,
  seenSessionIds: Set<string> = new Set()
): Project | null {
  if (!session || seenSessionIds.has(session.id)) return null;
  seenSessionIds.add(session.id);

  if (session.kind === "subagent-transcript" && session.subagent?.parentSessionId) {
    const parentSession = sessions.find((item) => item.id === session.subagent?.parentSessionId) ?? null;
    return resolveProjectForSession(parentSession, sessions, projects, projectById, seenSessionIds);
  }

  if (session.kind === "file-editor") {
    return session.fileEditor?.project
      ?? projectById.get(session.fileEditor?.projectId ?? "")
      ?? findProjectByPath(projects, session.fileEditor?.projectPath)
      ?? null;
  }

  if (session.projectId) {
    const project = projectById.get(session.projectId);
    if (project) return project;
  }

  return findProjectByPath(projects, session.cwd);
}

export function resolveProjectForSessionFileContext(
  session: TerminalSession | null,
  sessions: TerminalSession[],
  projects: Project[],
  projectById: Map<string, Project>,
  worktrees: WorktreeRecord[]
): Project | null {
  const project = resolveProjectForSession(session, sessions, projects, projectById);
  if (!project) return null;
  const worktree = findWorktreeForSession(session, sessions, worktrees);
  return worktree ? projectWithWorktreePath(project, worktree) : project;
}
