import { create } from "zustand";
import type { LiveServerClient, LiveServerOpenResult, LiveServerSession } from "../lib/liveServerClient";

export type LiveServerPendingAction = "status" | "start" | "stop";

export interface LiveServerProjectState {
  readonly session: LiveServerSession | null;
  readonly pending: LiveServerPendingAction | null;
  readonly hydrated: boolean;
}

export interface LiveServerStore {
  readonly projects: Readonly<Record<string, LiveServerProjectState>>;
  readonly hydrate: (projectPath: string) => Promise<LiveServerSession | null>;
  readonly startAndOpen: (projectPath: string, relativePath: string) => Promise<LiveServerOpenResult>;
  readonly stop: (projectPath: string) => Promise<boolean>;
}

const EMPTY_PROJECT_STATE: LiveServerProjectState = Object.freeze({
  session: null,
  pending: null,
  hydrated: false,
});

type ProjectStateUpdater = (current: LiveServerProjectState) => LiveServerProjectState;

function updateProject(
  projects: Readonly<Record<string, LiveServerProjectState>>,
  projectPath: string,
  updater: ProjectStateUpdater,
): Readonly<Record<string, LiveServerProjectState>> {
  const current = projects[projectPath] ?? EMPTY_PROJECT_STATE;
  const next = updater(current);
  if (next === current) return projects;
  return { ...projects, [projectPath]: next };
}

function setPending(
  projects: Readonly<Record<string, LiveServerProjectState>>,
  projectPath: string,
  pending: LiveServerPendingAction,
) {
  return updateProject(projects, projectPath, (current) => ({ ...current, pending }));
}

function clearPending(
  projects: Readonly<Record<string, LiveServerProjectState>>,
  projectPath: string,
  pending: LiveServerPendingAction,
) {
  return updateProject(projects, projectPath, (current) => (
    current.pending === pending ? { ...current, pending: null } : current
  ));
}

function setSession(
  projects: Readonly<Record<string, LiveServerProjectState>>,
  projectPath: string,
  session: LiveServerSession | null,
) {
  return updateProject(projects, projectPath, (current) => ({ ...current, session, hydrated: true }));
}

function setStatusSession(
  projects: Readonly<Record<string, LiveServerProjectState>>,
  projectPath: string,
  session: LiveServerSession | null,
) {
  return updateProject(projects, projectPath, (current) => (
    current.pending === "status" ? { ...current, session, hydrated: true } : current
  ));
}

export function createLiveServerStore(client: LiveServerClient) {
  return create<LiveServerStore>((set, get) => ({
    projects: {},
    hydrate: async (projectPath) => {
      const current = get().projects[projectPath];
      if (current && (current.hydrated || current.pending !== null)) return current.session;
      set((state) => ({ projects: setPending(state.projects, projectPath, "status") }));
      try {
        const session = await client.status(projectPath);
        set((state) => ({ projects: setStatusSession(state.projects, projectPath, session) }));
        return session;
      } finally {
        set((state) => ({ projects: clearPending(state.projects, projectPath, "status") }));
      }
    },
    startAndOpen: async (projectPath, relativePath) => {
      set((state) => ({ projects: setPending(state.projects, projectPath, "start") }));
      try {
        const result = await client.start(projectPath, relativePath);
        set((state) => ({ projects: setSession(state.projects, projectPath, result.session) }));
        await client.openUrl(result.url);
        return result;
      } finally {
        set((state) => ({ projects: clearPending(state.projects, projectPath, "start") }));
      }
    },
    stop: async (projectPath) => {
      set((state) => ({ projects: setPending(state.projects, projectPath, "stop") }));
      try {
        const stopped = await client.stop(projectPath);
        set((state) => ({ projects: setSession(state.projects, projectPath, null) }));
        return stopped;
      } finally {
        set((state) => ({ projects: clearPending(state.projects, projectPath, "stop") }));
      }
    },
  }));
}
