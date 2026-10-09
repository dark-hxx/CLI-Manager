import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ArrowRight, ChevronsLeft, ChevronsRight, CircleHelp, GitMerge, Save, X } from "lucide-react";
import { useI18n } from "../../../../shared/i18n/index";
import { registerWorkspaceViewCloseGuard, releaseWorkspaceViewCloseGuard } from "../../../terminal/api/workspaceViewLifecycle";
import { useTerminalStore } from "../../../terminal/state";
import { Button } from "../../../../shared/ui/button";
import { ConflictController } from "../../lib/conflictController";
import { isConflictTerminal } from "../../lib/conflictProtocol";
import type { ConflictReturnContext } from "../../api/worktreeConflictStore";
import { ConflictFileList } from "./ConflictFileList";
import { ConflictBlockEditor } from "./ConflictBlockEditor";
import { ConflictFileConfirmation } from "./ConflictFileConfirmation";
import { DEFAULT_CONFLICT_COLUMNS, type ConflictColumnSizes } from "../../lib/conflictColumnLayout";

type Confirmation = "abort" | "base_branch" | "worktree" | null;

export function WorktreeConflictWorkspace({ target, sessionId, onTabClosed, onReturn }: { target: ConflictReturnContext; sessionId: string; onTabClosed: () => void; onReturn: (terminal: boolean, mergeToTarget?: boolean) => void }) {
  const { t } = useI18n();
  const [controller] = useState(() => new ConflictController(invoke, { projectPath: target.project.path, worktreePath: target.worktree.path, worktreeBranch: target.worktree.branch, baseBranch: target.worktree.base_branch }));
  const view = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const [confirmation, setConfirmation] = useState<Confirmation>(null);
  const [closeFailed, setCloseFailed] = useState(false);
  const [closing, setClosing] = useState(false);
  const [toolbarContainer, setToolbarContainer] = useState<HTMLDivElement | null>(null);
  const [columnSizes, setColumnSizes] = useState<ConflictColumnSizes>(DEFAULT_CONFLICT_COLUMNS);
  const [message, setMessage] = useState(`Merge ${target.worktree.base_branch} into ${target.worktree.branch}`);
  const lifetime = useRef(0);
  const tabCloseRequested = useRef(false);
  useEffect(() => {
    const epoch = ++lifetime.current;
    void controller.initialize(true).catch(() => undefined);
    // StrictMode immediately remounts effects; only a real unmount disposes the owner.
    return () => { queueMicrotask(() => { if (lifetime.current === epoch) controller.dispose(); }); };
  }, [controller]);
  useEffect(() => registerWorkspaceViewCloseGuard(sessionId, async () => {
    if (controller.getSnapshot().busy || closing || confirmation) return false;
    tabCloseRequested.current = true;
    setClosing(true);
    try {
      await controller.flush();
      onTabClosed();
      return true;
    } catch {
      setCloseFailed(true);
      return false;
    } finally { setClosing(false); }
  }), [controller, sessionId, onTabClosed, closing, confirmation]);
  const perform = (operation: Promise<void>) => { void operation.catch(() => undefined); };
  const snapshot = view.snapshot;
  const detail = view.detail;
  const terminal = isConflictTerminal(snapshot);
  const blocked = view.busy || view.loading || view.needsRecheck || closing || confirmation !== null || closeFailed;
  const selectedPath = view.page?.files.find((file) => file.fileId === view.selectedId)?.displayPath;

  // Closing never aborts Git. Failed persistence keeps the tab and buffer alive.
  const requestClose = async () => {
    if (view.busy || closing || confirmation) return;
    if (tabCloseRequested.current) {
      await useTerminalStore.getState().closeSession(sessionId);
      return;
    }
    setClosing(true);
    try { await controller.flush(); onReturn(false); }
    catch { setCloseFailed(true); }
    finally { setClosing(false); }
  };
  const confirmAction = () => {
    const action = confirmation; setConfirmation(null);
    perform(action === "abort" ? controller.abort() : controller.resolve(action === "base_branch" ? "base_branch" : "worktree"));
  };
  const submitToTarget = async () => {
    if (blocked || !snapshot || (snapshot.state !== "ready" && snapshot.state !== "completed")) return;
    setClosing(true);
    try {
      if (snapshot.state === "ready") await controller.continueMerge(message.trim());
      // Release ownership before reusing the finish flow's recovery and target-merge gates.
      await controller.release();
      onReturn(true, true);
    } finally { setClosing(false); }
  };
  return <section data-worktree-conflict-workspace aria-label={t("worktree.conflict.title", { name: target.worktree.name })}
    className="conflict-workspace flex h-full min-h-0 min-w-0 flex-col gap-2 overflow-hidden p-3"
    onKeyDown={(event) => { if (event.key === "Escape") event.stopPropagation(); }}>
      <header className="conflict-workspace-header shrink-0">
        <div className="conflict-workspace-heading">
          <GitMerge size={16} className="conflict-workspace-icon" aria-hidden="true" />
          <h2 className="min-w-0 text-base font-semibold" title={target.worktree.name}>
            <span>{t("worktree.conflict.heading")}</span><span aria-hidden="true">·</span><code>{target.worktree.name}</code>
          </h2>
          <details className="conflict-workspace-help">
            <summary aria-label={t("worktree.conflict.help")} title={t("worktree.conflict.help")}><CircleHelp size={14} aria-hidden="true" /></summary>
            <div className="conflict-workspace-help-content">
              <p className="font-medium">{t("worktree.conflict.steps", { branch: target.worktree.base_branch })}</p>
              <p>{t("worktree.conflict.choiceHint")}</p>
              <p>{t("worktree.conflict.description")}</p>
            </div>
          </details>
        </div>
        <p className="sr-only">{t("worktree.conflict.description")}</p>
        <div className="conflict-workspace-meta">
          <div className="conflict-workspace-direction" role="group" aria-label={t("worktree.conflict.mergeDirection")}>
            <code title={t("worktree.conflict.worktree", { branch: target.worktree.branch })}>{target.worktree.branch}</code>
            <ArrowRight size={12} className="shrink-0 text-text-muted" aria-hidden="true" />
            <code className="text-accent" title={t("worktree.conflict.base", { branch: target.worktree.base_branch })}>{target.worktree.base_branch}</code>
          </div>
          {snapshot && <div className="conflict-workspace-status" role="status" data-state={snapshot.state}>
            <span className="conflict-workspace-state">{t(`worktree.conflict.state.${snapshot.state}`)}
              <span className="tabular-nums">{t("worktree.conflict.progressShort", { resolved: snapshot.resolved, total: snapshot.total })}</span>
            </span>
            <span className={view.dirty ? "text-accent" : "text-text-muted"}>{view.dirty ? t("worktree.conflict.unsaved") : t("worktree.conflict.saved")}</span>
          </div>}
        </div>
      </header>
      {view.error && <div role="alert" className="max-h-24 shrink-0 overflow-auto rounded border border-danger/30 p-2 text-xs text-danger">
        <p>{t("worktree.conflict.error")}</p><pre className="whitespace-pre-wrap break-words">{view.error}</pre>
      </div>}
      {view.needsRecheck && <p className="shrink-0 text-xs text-danger">{t("worktree.conflict.recheckRequired")}</p>}
      {closeFailed && <div role="alert" className="shrink-0 rounded border border-danger p-2 text-sm">
        <p>{t("worktree.conflict.closeFailed")}</p>
        <div className="mt-2 flex gap-2">
          <Button disabled={view.busy || closing} onClick={() => { void requestClose(); }}>{t("worktree.conflict.retrySave")}</Button>
          <Button variant="destructive" disabled={view.busy || closing} onClick={() => { perform(controller.discardLocal().then(async () => {
            if (!tabCloseRequested.current) { onReturn(false); return; }
            releaseWorkspaceViewCloseGuard(sessionId);
            onTabClosed();
            await useTerminalStore.getState().closeSession(sessionId);
          })); }}>{t("worktree.conflict.discardClose")}</Button>
          <Button variant="outline" onClick={() => setCloseFailed(false)}>{t("common.cancel")}</Button>
        </div>
      </div>}
      {confirmation && <div role="alert" className="shrink-0 rounded border border-danger p-2 text-sm">
        <p>{t(confirmation === "abort" ? "worktree.conflict.confirmAbort" : "worktree.conflict.confirmSide", { branch: confirmation === "base_branch" ? target.worktree.base_branch : target.worktree.branch })}</p>
        <div className="mt-2 flex gap-2"><Button variant="destructive" onClick={confirmAction}>{t("worktree.conflict.confirm")}</Button><Button variant="outline" onClick={() => setConfirmation(null)}>{t("common.cancel")}</Button></div>
      </div>}
      {!snapshot && <div className="flex min-h-0 flex-1 flex-col items-start gap-3 overflow-auto rounded-lg border border-border p-4" role="status" aria-busy={view.busy}>
        <p className="text-sm">{t(view.busy || !view.probe && !view.error ? "worktree.conflict.loadingFiles" : "worktree.conflict.loadBlocked")}</p>
        <p className="text-xs text-text-muted">{t("worktree.conflict.prepareHint", { base: target.worktree.base_branch, worktree: target.worktree.branch })}</p>
      </div>}
      {snapshot && !terminal && <div className="conflict-file-toolbar shrink-0">
        <div ref={setToolbarContainer} className="conflict-navigation-slot" />
        {detail && <div className="conflict-file-actions">
          <Button size="sm" variant="outline" title={t(detail.baseExists ? "worktree.conflict.takeBase" : "worktree.conflict.deleteBase", { branch: target.worktree.base_branch })}
            disabled={blocked || detail.capability === "external_only"} onClick={() => setConfirmation("base_branch")}>
            <ChevronsRight size={14} className="text-accent" aria-hidden="true" />{t(detail.baseExists ? "worktree.conflict.takeBaseShort" : "worktree.conflict.deleteBaseShort")}
          </Button>
          <Button size="sm" variant="outline" title={t(detail.worktreeExists ? "worktree.conflict.takeWorktree" : "worktree.conflict.deleteWorktree", { branch: target.worktree.branch })}
            disabled={blocked || detail.capability === "external_only"} onClick={() => setConfirmation("worktree")}>
            <ChevronsLeft size={14} className="text-success" aria-hidden="true" />{t(detail.worktreeExists ? "worktree.conflict.takeWorktreeShort" : "worktree.conflict.deleteWorktreeShort")}
          </Button>
        </div>}
        <span className="conflict-active-file" title={selectedPath}>{selectedPath ?? t("worktree.conflict.selectFile")}</span>
      </div>}
      {snapshot && !terminal && <div className="conflict-workspace-body grid min-h-0 flex-1 overflow-hidden rounded border border-border">
        <ConflictFileList view={view} onPage={(cursor) => { if (!blocked) perform(controller.page(cursor)); }} onSelect={(fileId) => { if (!confirmation && !closeFailed && !closing && !view.needsRecheck) perform(controller.select(fileId)); }} />
        <section className="flex min-h-0 min-w-0 flex-col" aria-busy={view.loading}>
          {detail?.capability === "blocks" && <ConflictFileConfirmation detail={detail} disabled={blocked}
            onConfirm={() => perform(controller.resolve())} />}
          {detail?.capability === "blocks" ? <ConflictBlockEditor key={detail.fileId} detail={detail} filePath={selectedPath} baseBranch={target.worktree.base_branch} worktreeBranch={target.worktree.branch}
            toolbarContainer={toolbarContainer}
            columnSizes={columnSizes} onColumnSizesChange={setColumnSizes}
            disabled={(view.busy && !view.saving) || view.loading || view.needsRecheck || closing || !!confirmation || closeFailed} onChoice={(id, choice) => controller.choose(id, choice)} /> : <div className="min-h-0 overflow-auto p-3 text-sm">
            {detail && <><p>{t(detail.capability === "external_only" ? "worktree.conflict.externalOnly" : "worktree.conflict.wholeOnly")}</p><code className="break-all text-xs text-text-muted">{detail.reason}</code></>}
            {!detail && <p>{t(view.loading ? "common.loading" : snapshot.state === "ready" ? "worktree.conflict.readyHint" : "worktree.conflict.selectFile")}</p>}
          </div>}
        </section>
      </div>}
      {terminal && <div className="flex min-h-0 flex-1 flex-col justify-center overflow-auto text-sm"><p>{t(snapshot?.state === "completed" ? "worktree.conflict.completedHint" : "worktree.conflict.abortedHint")}</p></div>}
      {snapshot?.state === "ready" && <label className="shrink-0 text-xs">{t("worktree.conflict.commitMessage")}<input value={message} onChange={(event) => setMessage(event.currentTarget.value)} disabled={blocked} className="mt-1 w-full rounded border border-border bg-bg-primary p-2 text-sm" /></label>}
      <footer className="flex shrink-0 flex-wrap justify-end gap-2">
        {snapshot && <span className="conflict-footer-status" role="status">{t("worktree.conflict.progress", { resolved: snapshot.resolved, total: snapshot.total })}</span>}
        {snapshot && !terminal && <Button variant="destructive" disabled={blocked} onClick={() => setConfirmation("abort")}><X size={14} aria-hidden="true" />{t("worktree.conflict.abort")}</Button>}
        <Button variant="outline" disabled={view.busy || closing || !!confirmation} onClick={() => { void requestClose(); }}><Save size={14} aria-hidden="true" />{t("worktree.conflict.back")}</Button>
        {view.dirty && <Button variant="outline" disabled={view.busy || closing} onClick={() => perform(controller.flush())}>{t("worktree.conflict.save")}</Button>}
        <Button variant="outline" disabled={view.busy || closing || !!confirmation || closeFailed} onClick={() => perform(controller.recheck())}>{t("worktree.conflict.recheck")}</Button>
        {snapshot && snapshot.state !== "aborted" && <Button variant="default" disabled={blocked || (snapshot.state !== "ready" && snapshot.state !== "completed") || (snapshot.state === "ready" && !message.trim())} onClick={() => perform(submitToTarget())}>{t("worktree.conflict.submitToTarget", { branch: target.worktree.base_branch })}</Button>}
        {snapshot?.state === "aborted" && <Button disabled={blocked} onClick={() => perform(controller.release().then(() => onReturn(true)))}>{t("worktree.conflict.release")}</Button>}
      </footer>
  </section>;
}
