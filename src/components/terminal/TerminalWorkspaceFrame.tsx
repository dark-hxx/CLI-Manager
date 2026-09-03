import { Fragment, type ReactNode } from "react";
import type { WorkspaceDockSide } from "../../lib/workspaceLayout";

interface TerminalWorkspaceFrameProps {
  dockSide: WorkspaceDockSide;
  panels: readonly ReactNode[];
  actions: ReactNode;
  children: ReactNode;
}

export function TerminalWorkspaceFrame({ dockSide, panels, actions, children }: TerminalWorkspaceFrameProps) {
  const visiblePanels = panels.filter((panel) => panel !== null && panel !== undefined && panel !== false);
  const orderedPanels = dockSide === "left" ? [...visiblePanels].reverse() : visiblePanels;
  const panelSlot = <Fragment key="workspace-panels">{orderedPanels}</Fragment>;

  return (
    <>
      {dockSide === "left" && panelSlot}
      <Fragment key="workspace-center">{children}</Fragment>
      {dockSide === "right" && panelSlot}
      <Fragment key="workspace-actions">{actions}</Fragment>
    </>
  );
}
