import { useDroppable } from "@dnd-kit/core";
import { PANE_CENTER_DROP_PREFIX, PANE_EDGE_DROP_PREFIX, type PaneDropPreview } from "../lib/terminalTabsModel";

export function PaneContentDropZones({
  paneId,
  enabled,
  activeDropPreview,
}: {
  paneId: string;
  enabled: boolean;
  activeDropPreview?: PaneDropPreview;
}) {
  const centerDrop = useDroppable({ id: `${PANE_CENTER_DROP_PREFIX}${paneId}`, disabled: !enabled });
  const leftDrop = useDroppable({ id: `${PANE_EDGE_DROP_PREFIX}${paneId}:left`, disabled: !enabled });
  const rightDrop = useDroppable({ id: `${PANE_EDGE_DROP_PREFIX}${paneId}:right`, disabled: !enabled });
  const topDrop = useDroppable({ id: `${PANE_EDGE_DROP_PREFIX}${paneId}:top`, disabled: !enabled });
  const bottomDrop = useDroppable({ id: `${PANE_EDGE_DROP_PREFIX}${paneId}:bottom`, disabled: !enabled });
  const activeEdge = activeDropPreview?.paneId === paneId ? activeDropPreview.edge : null;

  return (
    <>
      <div ref={centerDrop.setNodeRef} className="ui-terminal-pane-center-drop" aria-hidden="true" />
      <div ref={leftDrop.setNodeRef} className="ui-terminal-pane-edge-drop ui-terminal-pane-edge-drop-left" aria-hidden="true" />
      <div ref={rightDrop.setNodeRef} className="ui-terminal-pane-edge-drop ui-terminal-pane-edge-drop-right" aria-hidden="true" />
      <div ref={topDrop.setNodeRef} className="ui-terminal-pane-edge-drop ui-terminal-pane-edge-drop-top" aria-hidden="true" />
      <div ref={bottomDrop.setNodeRef} className="ui-terminal-pane-edge-drop ui-terminal-pane-edge-drop-bottom" aria-hidden="true" />
      {activeEdge && <div className="ui-terminal-pane-drop-preview" data-edge={activeEdge} aria-hidden="true" />}
    </>
  );
}
