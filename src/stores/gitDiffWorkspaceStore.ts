import { create } from "zustand";
import type { Project } from "../lib/types";

export interface GitDiffWorkspaceContext {
  key: string;
  projectId: string;
  projectPath: string;
}

export interface GitDiffWorkspaceTab {
  id: string;
  contextKey: string;
  projectId: string;
  projectPath: string;
  repositoryId: string;
  repositoryRelativePath: string;
  filePath: string;
  sourcePath: string;
  fileName: string;
  status: string;
  additions: number;
  deletions: number;
  revision: number;
}

export interface ProjectGitDiffWorkspace {
  tabs: GitDiffWorkspaceTab[];
  activeId: string | null;
}

type GitDiffTabInput = Omit<
  GitDiffWorkspaceTab,
  "id" | "contextKey" | "projectId" | "projectPath" | "revision"
>;
type GitDiffTabUpdate = Partial<Pick<
  GitDiffWorkspaceTab,
  "status" | "additions" | "deletions" | "revision"
>>;

interface GitDiffWorkspaceStore {
  workspaces: Record<string, ProjectGitDiffWorkspace>;
  openTab: (context: GitDiffWorkspaceContext, tab: GitDiffTabInput) => string;
  activateTab: (contextKey: string, tabId: string | null) => void;
  updateTab: (contextKey: string, tabId: string, patch: GitDiffTabUpdate) => void;
  closeTab: (contextKey: string, tabId: string) => void;
  clearWorkspace: (contextKey: string) => void;
}

export const EMPTY_GIT_DIFF_WORKSPACE: ProjectGitDiffWorkspace = {
  tabs: [],
  activeId: null,
};

function normalizePosixLikePath(path: string): string {
  const normalized = path.trim().replace(/\\/g, "/");
  if (normalized === "/") return normalized;
  if (/^[A-Za-z]:\/+$/u.test(normalized)) return `${normalized.slice(0, 2)}/`;
  return normalized.replace(/\/+$/gu, "");
}

function normalizeLocalProjectPath(path: string): string {
  const normalized = normalizePosixLikePath(path);
  return /^[A-Za-z]:\//u.test(normalized) ? normalized.toLowerCase() : normalized;
}

function normalizeRelativePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+|\/+$/gu, "");
}

function normalizeRepositoryId(repositoryId: string): string {
  const normalized = normalizePosixLikePath(repositoryId);
  return /^[A-Za-z]:\//u.test(normalized) ? normalized.toLowerCase() : normalized;
}

export function createGitDiffWorkspaceContext(project: Project): GitDiffWorkspaceContext {
  const projectPath = project.environment_type === "ssh"
    ? normalizePosixLikePath(project.remote_path) || "/"
    : normalizeLocalProjectPath(project.path);
  const key = JSON.stringify([
    project.id,
    project.environment_type,
    project.environment_type === "ssh" ? project.ssh_host_id ?? "" : "",
    projectPath,
  ]);
  return { key, projectId: project.id, projectPath };
}

export function resolveGitDiffProject(
  openedProject: Project,
  latestProject: Project | null | undefined,
): Project {
  if (!latestProject || latestProject.id !== openedProject.id) return openedProject;
  if (latestProject.environment_type === "ssh" || openedProject.environment_type === "ssh") {
    return latestProject;
  }
  return {
    ...latestProject,
    name: openedProject.name,
    path: openedProject.path,
  };
}

export function createGitDiffTabId(
  contextKey: string,
  repositoryId: string,
  filePath: string,
): string {
  return JSON.stringify([
    contextKey,
    normalizeRepositoryId(repositoryId),
    normalizeRelativePath(filePath),
  ]);
}

function fallbackActiveId(tabs: GitDiffWorkspaceTab[], closedIndex: number): string | null {
  return tabs[Math.min(closedIndex, tabs.length - 1)]?.id ?? null;
}

export const useGitDiffWorkspaceStore = create<GitDiffWorkspaceStore>((set) => ({
  workspaces: {},

  openTab: (context, tab) => {
    const id = createGitDiffTabId(context.key, tab.repositoryId, tab.filePath);
    set((state) => {
      const workspace = state.workspaces[context.key] ?? EMPTY_GIT_DIFF_WORKSPACE;
      const currentTab = workspace.tabs.find((candidate) => candidate.id === id);
      const nextTab: GitDiffWorkspaceTab = {
        ...tab,
        id,
        contextKey: context.key,
        projectId: context.projectId,
        projectPath: context.projectPath,
        repositoryId: normalizeRepositoryId(tab.repositoryId),
        repositoryRelativePath: normalizeRelativePath(tab.repositoryRelativePath),
        filePath: normalizeRelativePath(tab.filePath),
        sourcePath: normalizeRelativePath(tab.sourcePath),
        revision: (currentTab?.revision ?? -1) + 1,
      };
      const tabs = currentTab
        ? workspace.tabs.map((candidate) => candidate.id === id ? nextTab : candidate)
        : [...workspace.tabs, nextTab];
      return {
        workspaces: {
          ...state.workspaces,
          [context.key]: { tabs, activeId: id },
        },
      };
    });
    return id;
  },

  activateTab: (contextKey, tabId) => set((state) => {
    const workspace = state.workspaces[contextKey];
    if (!workspace || (tabId !== null && !workspace.tabs.some((tab) => tab.id === tabId))) return state;
    return {
      workspaces: {
        ...state.workspaces,
        [contextKey]: { ...workspace, activeId: tabId },
      },
    };
  }),

  updateTab: (contextKey, tabId, patch) => set((state) => {
    const workspace = state.workspaces[contextKey];
    if (!workspace) return state;
    return {
      workspaces: {
        ...state.workspaces,
        [contextKey]: {
          ...workspace,
          tabs: workspace.tabs.map((tab) => tab.id === tabId ? { ...tab, ...patch } : tab),
        },
      },
    };
  }),

  closeTab: (contextKey, tabId) => set((state) => {
    const workspace = state.workspaces[contextKey];
    if (!workspace) return state;
    const closedIndex = workspace.tabs.findIndex((tab) => tab.id === tabId);
    if (closedIndex < 0) return state;
    const tabs = workspace.tabs.filter((tab) => tab.id !== tabId);
    const activeId = workspace.activeId === tabId
      ? fallbackActiveId(tabs, closedIndex)
      : workspace.activeId;
    return {
      workspaces: {
        ...state.workspaces,
        [contextKey]: { tabs, activeId },
      },
    };
  }),

  clearWorkspace: (contextKey) => set((state) => {
    if (!(contextKey in state.workspaces)) return state;
    const workspaces = { ...state.workspaces };
    delete workspaces[contextKey];
    return { workspaces };
  }),
}));

export function activateProjectFileSurface(project: Project): void {
  const context = createGitDiffWorkspaceContext(project);
  useGitDiffWorkspaceStore.getState().activateTab(context.key, null);
}
