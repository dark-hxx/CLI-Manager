import { createContext, useContext, type MouseEvent as ReactMouseEvent } from "react";
import type { DragEndEvent } from "@dnd-kit/core";
import type { Project, TerminalScope, WorktreeRecord } from "../../lib/types";
import type { ProviderBadge } from "../../stores/projectStore";
import type { SessionStatus } from "../../stores/terminalStore";

export interface TreeActions {
  selectedId: string | null;
  selectedProjectIds: Set<string>;
  selectedGroupIds: Set<string>;
  projectScopedTerminalViewEnabled: boolean;
  terminalScope: TerminalScope;
  newGroupParentId: string | null;
  collapsedIds: Set<string>;
  renamingGroupId: string | null;
  renamingProjectId: string | null;
  providerBadges: Record<string, ProviderBadge>;
  onSelectProject: (e: ReactMouseEvent, p: Project) => void;
  onSelectProjectByKeyboard: (p: Project) => void;
  onSelectGroup: (e: ReactMouseEvent, groupId: string, forceExpanded: boolean) => void;
  onSelectGroupScope: (groupId: string) => void;
  onOpenProject: (p: Project) => void;
  onStartGroup: (groupId: string) => void;
  onRequestDeleteProject: (p: Project) => void;
  onRequestDeleteGroup: (groupId: string, groupName: string) => void;
  onRenameConfirm: (id: string, newName: string) => void;
  onCancelRename: () => void;
  onProjectRenameConfirm: (id: string, newName: string) => void;
  onCancelProjectRename: () => void;
  onContextMenuProject: (e: ReactMouseEvent, p: Project) => void;
  onSelectWorktree: (worktree: WorktreeRecord) => void;
  onOpenWorktree: (project: Project, worktree: WorktreeRecord) => void;
  onContextMenuWorktree: (e: ReactMouseEvent, project: Project, worktree: WorktreeRecord) => void;
  onContextMenuGroup: (e: ReactMouseEvent, groupId: string, groupName: string) => void;
  onCreateGroup: (parentId: string | null, name: string) => void;
  onCancelNewGroup: () => void;
  toggleCollapsed: (id: string) => void;
  getProjectStatus: (projectId: string) => SessionStatus | null;
  getProjectTerminalCount: (projectId: string) => number;
  isPathInvalid: (projectId: string) => boolean;
  onDragEnd: (event: DragEndEvent) => void;
}

export const TreeContext = createContext<TreeActions | null>(null);

export function worktreeListCollapseId(projectId: string): string {
  return `project-worktrees:${projectId}`;
}

export function useTreeActions(): TreeActions {
  const ctx = useContext(TreeContext);
  if (!ctx) throw new Error("useTreeActions must be used within TreeContext.Provider");
  return ctx;
}
