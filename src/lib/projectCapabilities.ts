import type { Project } from "./types";

export type ProjectCapability =
  | "terminal"
  | "splitTerminal"
  | "commandTemplates"
  | "files"
  | "git"
  | "worktree"
  | "history"
  | "hooks"
  | "statistics"
  | "providerSwitch"
  | "externalTerminal";

export interface ProjectCapabilities {
  environment: "local" | "wsl" | "ssh";
  terminal: boolean;
  splitTerminal: boolean;
  commandTemplates: boolean;
  files: boolean;
  git: boolean;
  worktree: boolean;
  history: boolean;
  hooks: boolean;
  statistics: boolean;
  providerSwitch: boolean;
  externalTerminal: boolean;
}

const LOCAL_CAPABILITIES: Omit<ProjectCapabilities, "environment"> = {
  terminal: true,
  splitTerminal: true,
  commandTemplates: true,
  files: true,
  git: true,
  worktree: true,
  history: true,
  hooks: true,
  statistics: true,
  providerSwitch: true,
  externalTerminal: true,
};

const SSH_CAPABILITIES: Omit<ProjectCapabilities, "environment"> = {
  terminal: true,
  splitTerminal: true,
  commandTemplates: true,
  files: true,
  git: true,
  worktree: false,
  history: true,
  hooks: false,
  statistics: true,
  providerSwitch: false,
  externalTerminal: false,
};

export function isSshProject(project: Project | null | undefined): boolean {
  return project?.environment_type === "ssh";
}

export function resolveProjectCapabilities(project: Project | null | undefined): ProjectCapabilities {
  const environment = project?.environment_type ?? "local";
  return {
    environment,
    ...(environment === "ssh" ? SSH_CAPABILITIES : LOCAL_CAPABILITIES),
  };
}

export function projectSupportsCapability(
  project: Project | null | undefined,
  capability: ProjectCapability
): boolean {
  return resolveProjectCapabilities(project)[capability];
}
