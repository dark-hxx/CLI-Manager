import { historyPathsMatch, historySourceWslPath } from "./historyResumeEnvironment";
import { resolveCliToolHistorySourceId } from "../../../shared/lib/cliTools";
import { getProviderSwitchAppType } from "../../providers/api/providerSwitching";
import type { HistorySessionSummary, Project, WorktreeRecord } from "../../../shared/types/index";

function normalizePathKey(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/\/+$/g, "");
}

export function findLocalHistoryCwdProjects(
  session: Pick<HistorySessionSummary, "cwd"> & Partial<HistorySessionSummary>,
  projects: Project[]
): Project[] {
  const cwd = session.cwd?.trim();
  if (!cwd) return [];

  return projects.filter((project) => historyPathsMatch(session, project));
}

function projectPathName(path: string): string {
  return normalizePathKey(path).split("/").filter(Boolean).pop() ?? "";
}

function claudeProjectKeyFromPath(path: string): string {
  return path.trim().replace(/:/g, "-").replace(/[\\/]/g, "-").replace(/-+$/g, "").toLowerCase();
}

export function matchesHistoryProjectSource(project: Project, source: string): boolean {
  const registeredSource = resolveCliToolHistorySourceId(project.cli_tool);
  return registeredSource ? registeredSource === source : getProviderSwitchAppType(project) === source;
}

export function findLocalHistoryResumeProjects(
  session: Pick<HistorySessionSummary, "cwd" | "project_key" | "source"> & Partial<HistorySessionSummary>,
  projects: Project[],
): Project[] {
  const sourceProjects = projects.filter((project) => (
    project.environment_type !== "ssh" && matchesHistoryProjectSource(project, session.source)
  ));
  const cwdProjects = findLocalHistoryCwdProjects(session, sourceProjects);
  if (cwdProjects.length > 0) return cwdProjects;

  // WSL identity must never fall back to matching an unrelated project name.
  if (historySourceWslPath(session) || session.session_ref?.transportKind === "wsl") return [];
  const normalizedProjectKey = normalizePathKey(session.project_key);
  if (!normalizedProjectKey) return [];
  const normalizedProjectKeyLower = normalizedProjectKey.toLowerCase();
  return sourceProjects.filter((project) => {
    const projectPath = normalizePathKey(project.path);
    return projectPath === normalizedProjectKey
      || claudeProjectKeyFromPath(project.path) === normalizedProjectKeyLower
      || projectPathName(project.path).toLowerCase() === normalizedProjectKeyLower
      || project.name.trim().toLowerCase() === normalizedProjectKeyLower;
  });
}

export interface LocalHistoryResumeSelection {
  project: Project | null;
  worktree: WorktreeRecord | null;
  candidates: Project[];
}

export function selectLocalHistoryResumeProject(
  session: Pick<HistorySessionSummary, "cwd" | "project_key" | "source"> & Partial<HistorySessionSummary>,
  projects: Project[],
  worktree: WorktreeRecord | null,
  projectIdFilter: string | null,
): LocalHistoryResumeSelection {
  const worktreeProject = worktree
    ? projects.find((project) => project.id === worktree.project_id) ?? null
    : null;
  if (worktreeProject && worktree && matchesHistoryProjectSource(worktreeProject, session.source)
    && historyPathsMatch({ ...session, cwd: session.cwd || session.project_key }, { ...worktreeProject, path: worktree.path })) {
    return { project: worktreeProject, worktree, candidates: [worktreeProject] };
  }

  const candidates = findLocalHistoryResumeProjects(session, projects);
  const filteredProject = projectIdFilter
    ? candidates.find((project) => project.id === projectIdFilter) ?? null
    : null;
  if (filteredProject) return { project: filteredProject, worktree: null, candidates };
  if (candidates.length === 1) return { project: candidates[0], worktree: null, candidates };
  return { project: null, worktree: null, candidates };
}
