import type { PointerEvent as ReactPointerEvent } from "react";
import type { TerminalFileDragSource } from "../../hooks/useTerminalFilePointerDrag";
import type { TerminalFileDragProject } from "../../lib/terminalFileDrag";
import type { GitTreeNode } from "../../lib/types";
import { GitTreeNodeComponent } from "./GitTreeNode";

interface GitChangesTreeProps {
  project: TerminalFileDragProject | null;
  nodes: GitTreeNode[];
  treeId: string;
  onFileClick: (filePath: string) => void;
  onOpenSourceFile: (filePath: string, status: string) => void;
  onRequestDiscard: (path: string, name: string, status: string) => void;
  onRequestDeleteUntracked: (paths: string[], name: string) => void;
  onToggleStage: (filePath: string, staged: boolean) => void;
  onToggleStagePaths: (paths: string[], allStaged: boolean) => void;
  onFilePointerDown: (event: ReactPointerEvent<HTMLElement>, source: TerminalFileDragSource) => void;
  onFilePointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  onFilePointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  onFilePointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
}

export function GitChangesTree({ project, nodes, treeId, onFileClick, onOpenSourceFile, onRequestDiscard, onRequestDeleteUntracked, onToggleStage, onToggleStagePaths, onFilePointerDown, onFilePointerMove, onFilePointerUp, onFilePointerCancel }: GitChangesTreeProps) {
  return (
    <div className="space-y-0.5">
      {nodes.map((node) => (
        <GitTreeNodeComponent
          key={node.path}
          project={project}
          node={node}
          depth={0}
          treeId={treeId}
          onFileClick={onFileClick}
          onOpenSourceFile={onOpenSourceFile}
          onRequestDiscard={onRequestDiscard}
          onRequestDeleteUntracked={onRequestDeleteUntracked}
          onToggleStage={onToggleStage}
          onToggleStagePaths={onToggleStagePaths}
          onFilePointerDown={onFilePointerDown}
          onFilePointerMove={onFilePointerMove}
          onFilePointerUp={onFilePointerUp}
          onFilePointerCancel={onFilePointerCancel}
        />
      ))}
    </div>
  );
}
