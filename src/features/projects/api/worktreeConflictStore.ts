import { create } from "zustand";
import { toast } from "sonner";
import { translateCurrent } from "../../../shared/i18n/index";
import type { Project, WorktreeRecord } from "../../../shared/types/index";
import { useSettingsStore } from "../../../shared/preferences/settingsStore";
import { useTerminalStore } from "../../terminal/state";
import { openWorkspaceViewSession } from "../../terminal/api/workspaceViewSession";
import { registerWorkspaceViewCloseGuard, releaseWorkspaceViewCloseGuard } from "../../terminal/api/workspaceViewLifecycle";

export interface ConflictReturnContext {
  project: Project; worktree: WorktreeRecord; step: "review" | "merge" | "cleanup" | "done";
  message: string; focus: HTMLElement | null;
  mergeAfterConflicts?: boolean;
}
interface HostState {
  target: ConflictReturnContext | null; phase: "closed" | "opening" | "workspace" | "returning" | "finish";
  mountPoint: HTMLDivElement | null; sessionId: string | null;
}
export const useWorktreeConflictStore = create<HostState>(() => ({ target: null, phase: "closed", mountPoint: null, sessionId: null }));

/** Preserve return state independently of Sidebar/TerminalTabs unmounts (compact mode). */
export function openWorktreeConflicts(target: ConflictReturnContext): void {
  if (useSettingsStore.getState().viewMode === "compact") {
    void useSettingsStore.getState().update("viewMode", "standard").catch(() => {
      toast.error(translateCurrent("worktree.conflict.error"));
    });
  }
  const current = useWorktreeConflictStore.getState();
  if (current.target && (current.phase === "opening" || current.phase === "workspace")) {
    // A second entry must not replace the live controller or discard its draft.
    if (current.sessionId) useTerminalStore.getState().setActive(current.sessionId);
    if (current.target.worktree.id !== target.worktree.id || current.target.project.id !== target.project.id) {
      toast.info(translateCurrent("worktree.conflict.existingWorkspace", { name: current.target.worktree.name }));
    }
    return;
  }
  const sessionId = `worktree-conflict:${target.project.id}:${target.worktree.id}`;
  // Do not let an early close destroy a workspace before its save guard mounts.
  registerWorkspaceViewCloseGuard(sessionId, async () => false);
  useWorktreeConflictStore.setState({ target, phase: "opening", sessionId });
  openWorkspaceViewSession({
    id: sessionId, kind: "worktree-conflict", projectId: target.project.id,
    worktreeId: target.worktree.id, cwd: target.worktree.path,
    title: translateCurrent("worktree.conflict.title", { name: target.worktree.name }),
  });
}
export function closeWorktreeConflicts(): void {
  const { target, sessionId } = useWorktreeConflictStore.getState();
  if (sessionId) releaseWorkspaceViewCloseGuard(sessionId);
  useWorktreeConflictStore.setState({ target: null, phase: "closed", sessionId: null, mountPoint: null });
  requestAnimationFrame(() => {
    const focus = target?.focus?.isConnected ? target.focus : document.getElementById("main-content");
    focus?.focus({ preventScroll: true });
  });
}
