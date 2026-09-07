export type WorkspaceDockSide = "left" | "right";
export type WorkspanTabBarPosition = "top" | "bottom";

export interface WorkspaceLayoutSettings {
  version: 3;
  projectSidebarSide: WorkspaceDockSide;
  terminalSidePanelSide: WorkspaceDockSide;
  terminalSidePanelVisible: boolean;
  workspanTabBarPosition: WorkspanTabBarPosition;
  workspanTabBarVisible: boolean;
}

export const WORKSPACE_LAYOUT_DEFAULTS: WorkspaceLayoutSettings = {
  version: 3,
  projectSidebarSide: "left",
  terminalSidePanelSide: "right",
  terminalSidePanelVisible: true,
  workspanTabBarPosition: "top",
  workspanTabBarVisible: true,
};

export type WorkspaceLayoutPatch = Partial<
  Pick<WorkspaceLayoutSettings, "projectSidebarSide" | "terminalSidePanelSide" | "terminalSidePanelVisible" | "workspanTabBarPosition" | "workspanTabBarVisible">
>;

export function updateWorkspaceLayout(
  current: WorkspaceLayoutSettings,
  patch: WorkspaceLayoutPatch,
): WorkspaceLayoutSettings {
  return {
    ...current,
    ...patch,
    version: WORKSPACE_LAYOUT_DEFAULTS.version,
  };
}

export function migrateWorkspaceLayout(value: unknown): WorkspaceLayoutSettings {
  const raw = typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : {};

  return {
    version: WORKSPACE_LAYOUT_DEFAULTS.version,
    projectSidebarSide: raw.projectSidebarSide === "left" || raw.projectSidebarSide === "right"
      ? raw.projectSidebarSide
      : WORKSPACE_LAYOUT_DEFAULTS.projectSidebarSide,
    terminalSidePanelSide: raw.terminalSidePanelSide === "left" || raw.terminalSidePanelSide === "right"
      ? raw.terminalSidePanelSide
      : WORKSPACE_LAYOUT_DEFAULTS.terminalSidePanelSide,
    terminalSidePanelVisible: typeof raw.terminalSidePanelVisible === "boolean"
      ? raw.terminalSidePanelVisible
      : WORKSPACE_LAYOUT_DEFAULTS.terminalSidePanelVisible,
    workspanTabBarPosition: raw.workspanTabBarPosition === "bottom" || raw.workspanTabBarPosition === "top"
      ? raw.workspanTabBarPosition
      : WORKSPACE_LAYOUT_DEFAULTS.workspanTabBarPosition,
    workspanTabBarVisible: typeof raw.workspanTabBarVisible === "boolean"
      ? raw.workspanTabBarVisible
      : WORKSPACE_LAYOUT_DEFAULTS.workspanTabBarVisible,
  };
}
