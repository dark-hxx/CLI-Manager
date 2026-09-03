export type WorkspaceDockSide = "left" | "right";
export type WorkspanTabBarPosition = "top" | "bottom";

export interface WorkspaceLayoutSettings {
  version: 1;
  terminalSidePanelSide: WorkspaceDockSide;
  workspanTabBarPosition: WorkspanTabBarPosition;
}

export const WORKSPACE_LAYOUT_DEFAULTS: WorkspaceLayoutSettings = {
  version: 1,
  terminalSidePanelSide: "right",
  workspanTabBarPosition: "top",
};

export function migrateWorkspaceLayout(value: unknown): WorkspaceLayoutSettings {
  const raw = typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : {};

  return {
    version: 1,
    terminalSidePanelSide: raw.terminalSidePanelSide === "left" || raw.terminalSidePanelSide === "right"
      ? raw.terminalSidePanelSide
      : WORKSPACE_LAYOUT_DEFAULTS.terminalSidePanelSide,
    workspanTabBarPosition: raw.workspanTabBarPosition === "bottom" || raw.workspanTabBarPosition === "top"
      ? raw.workspanTabBarPosition
      : WORKSPACE_LAYOUT_DEFAULTS.workspanTabBarPosition,
  };
}
