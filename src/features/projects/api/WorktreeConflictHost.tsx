import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { useI18n } from "../../../shared/i18n/index";
import { useProjectStore } from "./projectStore";
import { useWorktreeStore } from "./worktreeStore";
import { closeWorktreeConflicts, useWorktreeConflictStore } from "./worktreeConflictStore";
import { useTerminalStore } from "../../terminal/state";
import { releaseWorkspaceViewCloseGuard } from "../../terminal/api/workspaceViewLifecycle";

const Workspace = lazy(() => import("../components/conflicts/WorktreeConflictWorkspace").then((module) => ({ default: module.WorktreeConflictWorkspace })));
const Finish = lazy(() => import("./WorktreeFinishDialog").then((module) => ({ default: module.WorktreeFinishDialog })));

/** Keep one portal target: moving between normal/compact layouts never remounts the draft owner. */
export function WorktreeConflictHost() {
  const { t } = useI18n();
  const { target, phase, mountPoint, sessionId } = useWorktreeConflictStore();
  const fallback = useRef<HTMLDivElement>(null);
  const [container] = useState(() => {
    const element = document.createElement("div");
    element.className = "conflict-tab-content";
    element.id = "worktree-conflict-panel";
    element.setAttribute("role", "tabpanel");
    return element;
  });
  useLayoutEffect(() => {
    (mountPoint ?? fallback.current)?.appendChild(container);
    return () => container.remove();
  }, [container, mountPoint]);
  useEffect(() => {
    if (phase !== "opening" && phase !== "returning") return;
    let second = 0;
    const first = requestAnimationFrame(() => { second = requestAnimationFrame(() => {
      if (useWorktreeConflictStore.getState().target !== target) return;
      if (phase === "returning" && target) {
        const project = useProjectStore.getState().projects.find((item) => item.id === target.project.id && item.path === target.project.path);
        const worktree = useWorktreeStore.getState().worktrees.find((item) => item.id === target.worktree.id && item.path === target.worktree.path);
        if (!project || !worktree || worktree.project_id !== project.id || worktree.branch !== target.worktree.branch || worktree.base_branch !== target.worktree.base_branch) {
          toast.error(t("worktree.conflict.returnUnavailable")); closeWorktreeConflicts(); return;
        }
      }
      useWorktreeConflictStore.setState({ phase: phase === "opening" ? "workspace" : "finish" });
    }); });
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); };
  }, [phase, target, t]);
  return <>
    <div ref={fallback} hidden />
    {createPortal(<Suspense fallback={<div role="status" className="p-3 text-sm">{t("common.loading")}</div>}>
      {target && sessionId && phase === "workspace" && <Workspace target={target} sessionId={sessionId} onTabClosed={closeWorktreeConflicts} onReturn={(terminal, mergeToTarget = false) => {
        // The controller already flushed/released before returning to the finish flow.
        releaseWorkspaceViewCloseGuard(sessionId);
        useWorktreeConflictStore.setState({ phase: "returning", sessionId: null, target: { ...target, step: terminal ? "merge" : target.step, mergeAfterConflicts: mergeToTarget } });
        void useTerminalStore.getState().closeSession(sessionId).catch(() => { toast.error(t("worktree.conflict.error")); });
      }} />}
    </Suspense>, container)}
    <Suspense fallback={null}>
      {target && phase === "finish" && <Finish open project={target.project} worktree={target.worktree} resume={{ step: target.step, message: target.message, focus: target.focus, mergeAfterConflicts: target.mergeAfterConflicts }} onClose={closeWorktreeConflicts} />}
    </Suspense>
  </>;
}
