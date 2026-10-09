import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import type { GitFileChange, Project, WorktreeRecord } from "../../../shared/types/index";
import { useI18n, type TranslationKey } from "../../../shared/i18n/index";
import { useWorktreeStore, type GitWorktreeMergeResult } from "./worktreeStore";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "../../../shared/ui/dialog";
import { Button } from "../../../shared/ui/button";
import { Textarea } from "../../../shared/ui/textarea";
import { ConfirmDialog } from "../../../shared/ui/ConfirmDialog";
import { useWorktreeRecovery } from "../hooks/useWorktreeRecovery";
import { WorktreeRecoveryNotice } from "../components/WorktreeRecoveryNotice";
import { useWorktreeConflictProbe } from "../hooks/useWorktreeConflictProbe";
import { openWorktreeConflicts } from "./worktreeConflictStore";

interface WorktreeFinishDialogProps {
  project: Project | null;
  worktree: WorktreeRecord | null;
  open: boolean;
  onClose: () => void;
  resume?: { step: Step; message: string; focus?: HTMLElement | null; mergeAfterConflicts?: boolean };
}

type Step = "review" | "merge" | "cleanup" | "done";
type Translate = (key: TranslationKey, params?: Record<string, string | number>) => string;

interface FinishErrorInfo {
  code?: string;
  title: string;
  description: string;
  details?: string[];
  raw?: string;
}

function formatChangeSummary(changes: GitFileChange[]): string {
  if (changes.length === 0) return "";
  return changes.map((change) => `${change.status} ${change.path}`).join("\n");
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function createMergeConflictError(
  conflictFiles: string[],
  t: Translate,
  stashCreated = false
): FinishErrorInfo {
  return {
    code: "merge_conflict",
    title: t("worktree.finish.error.conflictTitle"),
    description: t("worktree.finish.error.conflictDescription"),
    details: [
      ...(conflictFiles.length > 0 ? conflictFiles : [t("worktree.finish.error.noConflictFiles")]),
      ...(stashCreated ? [t("worktree.finish.error.forceMergeStashRetained")] : []),
    ],
  };
}

function createStashRestoreError(result: GitWorktreeMergeResult, t: Translate): FinishErrorInfo {
  const mergeWasAborted = !result.merged;
  return {
    code: "force_merge_restore_conflict",
    title: t(
      mergeWasAborted
        ? "worktree.finish.error.forceConflictRestoreTitle"
        : "worktree.finish.error.forceRestoreConflictTitle"
    ),
    description: t(
      mergeWasAborted
        ? "worktree.finish.error.forceConflictRestoreDescription"
        : "worktree.finish.error.forceRestoreConflictDescription"
    ),
    details: [
      ...(mergeWasAborted && result.conflictFiles.length > 0
        ? [t("worktree.finish.error.forceMergeConflictFiles"), ...result.conflictFiles]
        : []),
      ...(result.stashRestoreConflictFiles.length > 0
        ? result.stashRestoreConflictFiles
        : [t("worktree.finish.error.noConflictFiles")]),
      ...(result.stashReference
        ? [t("worktree.finish.error.forceRestoreStashReference", { reference: result.stashReference })]
        : []),
      t("worktree.finish.error.forceMergeStashRetained"),
    ],
    raw: result.output,
  };
}

function formatFinishError(err: unknown, t: Translate, projectPath?: string): FinishErrorInfo {
  const raw = errorText(err).trim();
  if (raw.includes("dirty_main_worktree")) {
    return {
      code: "dirty_main_worktree",
      title: t("worktree.finish.error.dirtyMainTitle"),
      description: t("worktree.finish.error.dirtyMainDescription"),
      details: [
        ...(projectPath ? [t("worktree.finish.error.mainPath", { path: projectPath })] : []),
        t("worktree.finish.error.dirtyMainAction"),
        t("worktree.finish.error.dirtyMainSafe"),
      ],
    };
  }

  if (raw.includes("force_merge_stash_failed") || raw.includes("force_merge_stash_reference_failed") || raw.includes("force_merge_stash_incomplete")) {
    return {
      code: "force_merge_stash_failed",
      title: t("worktree.finish.error.forceStashTitle"),
      description: t("worktree.finish.error.forceStashDescription"),
      raw,
    };
  }

  if (raw.includes("force_merge_restore_failed")) {
    return {
      code: "force_merge_restore_failed",
      title: t("worktree.finish.error.forceRestoreTitle"),
      description: t("worktree.finish.error.forceRestoreDescription"),
      raw,
    };
  }

  if (raw.includes("force_merge_checkout_failed")) {
    return {
      code: "force_merge_checkout_failed",
      title: t("worktree.finish.error.forceCheckoutTitle"),
      description: t("worktree.finish.error.forceCheckoutDescription"),
      raw,
    };
  }

  if (raw.includes("force_merge_abort_failed")) {
    return {
      code: "force_merge_abort_failed",
      title: t("worktree.finish.error.forceAbortTitle"),
      description: t("worktree.finish.error.forceAbortDescription"),
      raw,
    };
  }

  if (raw.includes("worktree_branch_not_found") || raw.includes("branch_not_found")) {
    return {
      code: "branch_not_found",
      title: t("worktree.finish.error.branchMissingTitle"),
      description: t("worktree.finish.error.branchMissingDescription"),
      raw,
    };
  }

  if (raw.includes("merge_failed")) {
    return {
      code: "merge_failed",
      title: t("worktree.finish.error.mergeFailedTitle"),
      description: t("worktree.finish.error.mergeFailedDescription"),
      raw,
    };
  }

  return {
    code: "generic",
    title: t("worktree.finish.error.genericTitle"),
    description: t("worktree.finish.error.genericDescription"),
    raw,
  };
}

/** An explicit submit handoff may attempt the target merge once, never on a mere return. */
function ResumeConflictMerge({ ready, onMerge }: { ready: boolean; onMerge: () => Promise<void> }) {
  const attempted = useRef(false);
  useEffect(() => {
    if (!ready || attempted.current) return;
    attempted.current = true;
    void onMerge();
  }, [ready, onMerge]);
  return null;
}

export function WorktreeFinishDialog({ project, worktree, open, onClose, resume }: WorktreeFinishDialogProps) {
  const { t } = useI18n();
  const mergeWorktree = useWorktreeStore((state) => state.mergeWorktree);
  const forceMergeWorktree = useWorktreeStore((state) => state.forceMergeWorktree);
  const removeWorktree = useWorktreeStore((state) => state.removeWorktree);
  const [changes, setChanges] = useState<GitFileChange[]>([]);
  const [loadingChanges, setLoadingChanges] = useState(false);
  const [step, setStep] = useState<Step>("review");
  const [commitMessage, setCommitMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [output, setOutput] = useState("");
  const [error, setError] = useState<FinishErrorInfo | null>(null);
  const [forceConfirmOpen, setForceConfirmOpen] = useState(false);
  const recovery = useWorktreeRecovery(open, project?.path, worktree?.path);
  const conflict = useWorktreeConflictProbe(open && !recovery.blocked, project, worktree);
  const handoff = useRef(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  const reviewedKey = useRef<string | null>(null);

  useEffect(() => {
    if (!open || !worktree) return;
    setStep(resume?.step ?? "review");
    setCommitMessage(resume?.message ?? worktree.name);
    handoff.current = false;
    setOutput("");
    setError(null);
    setForceConfirmOpen(false);
    setChanges([]);
    reviewedKey.current = null;
    setLoadingChanges(false);
  }, [open, worktree, resume?.step, resume?.message]);

  useEffect(() => {
    if (!open || !worktree || recovery.blocked || conflict.blocked || reviewedKey.current === recovery.key) return;
    let active = true;
    setLoadingChanges(true);
    invoke<GitFileChange[]>("git_get_changes", { projectPath: worktree.path })
      .then((items) => {
        if (!active) return;
        reviewedKey.current = recovery.key;
        setChanges(items);
        if (items.length === 0 && (!resume || resume.step === "review")) setStep("merge");
      })
      .catch((err) => { if (active) setError(formatFinishError(err, t, worktree.path)); })
      .finally(() => { if (active) setLoadingChanges(false); });
    return () => { active = false; };
  }, [open, t, worktree, recovery.blocked, recovery.key, conflict.blocked, resume?.step]);

  const changeSummary = useMemo(() => formatChangeSummary(changes), [changes]);
  const actionsBlocked = busy || loadingChanges || recovery.blocked || conflict.blocked;
  const canCommit = changes.length > 0 && commitMessage.trim().length > 0 && !actionsBlocked;
  const canResolveConflicts = !recovery.blocked && (conflict.probe?.kind === "managed" || conflict.probe?.kind === "recovery" || (error?.code === "merge_conflict" && conflict.probe?.kind === "none"));

  if (!project || !worktree) return null;

  // 先关闭旧模态，再交给布局外宿主；不携带 Git 写操作或清空后的 finishTarget。
  const handleResolve = () => {
    if (busy || loadingChanges || recovery.blocked) return;
    handoff.current = true;
    const focus = resume?.focus ?? returnFocus.current;
    onClose();
    openWorktreeConflicts({ project, worktree, step, message: commitMessage, focus });
  };

  const handleCommit = async () => {
    if (!canCommit) return;
    setBusy(true);
    setError(null);
    setOutput(`git add --all\ngit commit -m "${commitMessage.trim()}"`);
    try {
      await invoke("git_stage_all", { projectPath: worktree.path });
      const commitId = await invoke<string>("git_commit", { projectPath: worktree.path, message: commitMessage.trim() });
      setOutput((current) => `${current}\n${t("worktree.finish.commitResult", { commitId })}`);
      setStep("merge");
    } catch (err) {
      const text = errorText(err);
      if (text === "nothing_staged") {
        setOutput((current) => `${current}\n${t("worktree.finish.nothingToCommit")}`);
        setStep("merge");
      } else {
        setError(formatFinishError(err, t, worktree.path));
      }
    } finally {
      await recovery.gate.refresh();
      setBusy(false);
    }
  };

  const handleMerge = async () => {
    if (actionsBlocked) return;
    setBusy(true);
    setError(null);
    setOutput((current) => `${current}\n\ngit -C "${project.path}" merge --no-ff --no-edit ${worktree.branch}`);
    try {
      const result = await mergeWorktree(worktree);
      setOutput((current) => `${current}\n${result.output}`);
      if (result.merged && (!result.stashCreated || result.stashRestored)) {
        setStep("cleanup");
      } else if (result.skipped && result.skipReason === "no_diff") {
        setOutput((current) => `${current}\n${t("worktree.finish.noDiffToMerge")}`);
        setStep("cleanup");
      } else if (result.stashCreated && !result.stashRestored) {
        setError(createStashRestoreError(result, t));
      } else {
        setError(createMergeConflictError(result.conflictFiles, t, result.stashCreated));
      }
    } catch (err) {
      setError(formatFinishError(err, t, project.path));
    } finally {
      await recovery.gate.refresh();
      setBusy(false);
    }
  };

  // 只有确认框的显式确定按钮会进入此处，stash/merge/恢复由 Rust 作为一个受锁保护的序列执行。
  const handleForceMerge = async () => {
    if (actionsBlocked) return;
    setForceConfirmOpen(false);
    setBusy(true);
    setError(null);
    setOutput((current) => `${current}\n\n${t("worktree.finish.forceMergeStarted")}`);
    try {
      const result = await forceMergeWorktree(worktree);
      setOutput((current) => `${current}\n${result.output}`);
      if (result.merged && (!result.stashCreated || result.stashRestored)) {
        setStep("cleanup");
      } else if (result.skipped && result.skipReason === "no_diff") {
        setOutput((current) => `${current}\n${t("worktree.finish.noDiffToMerge")}`);
        setStep("cleanup");
      } else if (result.stashCreated && !result.stashRestored) {
        setError(createStashRestoreError(result, t));
      } else {
        setError(createMergeConflictError(result.conflictFiles, t, result.stashCreated));
      }
    } catch (err) {
      setError(formatFinishError(err, t, project.path));
    } finally {
      await recovery.gate.refresh();
      setBusy(false);
    }
  };

  const handleCleanup = async () => {
    if (actionsBlocked) return;
    setBusy(true);
    setError(null);
    setOutput((current) => `${current}\n\ngit worktree remove "${worktree.path}"\ngit branch -D ${worktree.branch}`);
    try {
      await removeWorktree(worktree, true);
      setStep("done");
      toast.success(t("worktree.finish.cleanupDone"));
      onClose();
    } catch (err) {
      setError(formatFinishError(err, t, project.path));
    } finally {
      await recovery.gate.refresh();
      setBusy(false);
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={(next) => { if (!next && !busy && !forceConfirmOpen) onClose(); }}>
      <DialogContent className="flex max-h-[calc(100dvh-40px)] max-w-[520px] flex-col overflow-hidden" showCloseButton={false}
        onOpenAutoFocus={() => { returnFocus.current = resume?.focus ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null); }}
        onCloseAutoFocus={(event) => {
          if (handoff.current || resume) event.preventDefault();
        }}>
        <DialogTitle className="shrink-0">{t("worktree.finish.title", { name: worktree.name })}</DialogTitle>
        <DialogDescription className="mt-2 shrink-0">
          {t("worktree.finish.description", { branch: worktree.branch })}
        </DialogDescription>
        {resume?.mergeAfterConflicts && <ResumeConflictMerge
          ready={open && step === "merge" && !actionsBlocked && !error && reviewedKey.current === recovery.key && changes.length === 0}
          onMerge={handleMerge} />}

        <div className="mt-4 min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain text-sm">
          <WorktreeRecoveryNotice key={recovery.key} snapshot={recovery.snapshot} gate={recovery.gate} busy={busy} />
          {!recovery.blocked && conflict.blocked && <div role="status" className="space-y-2 rounded-lg border border-border p-3">
            <p>{t("worktree.conflict.finishBlocked")}</p>
            {conflict.error && <pre className="max-h-32 overflow-auto whitespace-pre-wrap text-xs">{conflict.error}</pre>}
            <Button variant="outline" size="sm" onClick={conflict.refresh} disabled={!conflict.probe && !conflict.error}>{t("worktree.conflict.recheck")}</Button>
          </div>}
          {canResolveConflicts && <div className="space-y-3 rounded-lg border border-accent/40 bg-accent/10 p-4">
            <p className="font-semibold">{t("worktree.conflict.entryHint", { branch: worktree.base_branch })}</p>
            <Button variant="default" className="w-full" onClick={handleResolve} disabled={busy || loadingChanges}>{t("worktree.conflict.open")}</Button>
          </div>}
          <div className="rounded-lg border border-border bg-bg-secondary/60 p-3">
            <div className="mb-1 text-xs font-semibold text-text-secondary">{t("worktree.finish.changes")}</div>
            {loadingChanges ? (
              <div className="text-xs text-text-muted">{t("common.loading")}</div>
            ) : changes.length === 0 ? (
              <div className="text-xs text-text-muted">{t("worktree.finish.noChanges")}</div>
            ) : (
              <pre className="max-h-32 overflow-auto whitespace-pre-wrap text-xs text-text-secondary">{changeSummary}</pre>
            )}
          </div>

          {step === "review" && (
            <div>
              <label className="mb-1 block text-xs text-text-muted">{t("worktree.finish.commitMessage")}</label>
              <Textarea
                value={commitMessage}
                onChange={(event) => setCommitMessage(event.currentTarget.value)}
                className="h-20 resize-none text-sm"
              />
            </div>
          )}

          {output && (
            <pre className="max-h-36 overflow-auto rounded-lg border border-border bg-bg-tertiary p-2 text-[11px] text-text-secondary">{output}</pre>
          )}

          {error && (
            <div className="rounded-lg border border-danger/25 bg-danger/15 px-3 py-2 text-xs text-danger">
              <div className="font-semibold">{error.title}</div>
              <div className="mt-1 leading-relaxed">{error.description}</div>
              {error.details && error.details.length > 0 && (
                <div className="mt-2 rounded-md bg-bg-primary/60 p-2 text-text-secondary">
                  <div className="mb-1 font-semibold text-text-primary">{t("worktree.finish.error.details")}</div>
                  <ul className="list-disc space-y-1 pl-4">
                    {error.details.map((detail) => (
                      <li key={detail}>{detail}</li>
                    ))}
                  </ul>
                </div>
              )}
              {error.raw && (
                <div className="mt-2 rounded-md bg-bg-primary/60 p-2 text-text-secondary">
                  <div className="mb-1 font-semibold text-text-primary">{t("worktree.finish.error.raw")}</div>
                  <pre className="whitespace-pre-wrap break-words">{error.raw}</pre>
                </div>
              )}
              {error.code === "dirty_main_worktree" && (
                <Button
                  className="mt-3"
                  variant="destructive"
                  onClick={() => setForceConfirmOpen(true)}
                  disabled={actionsBlocked}
                  aria-label={t("worktree.finish.forceMergeAria")}
                >
                  {t("worktree.finish.forceMerge")}
                </Button>
              )}
            </div>
          )}
        </div>

        {recovery.blocked && <p id="worktree-recovery-disabled" className="shrink-0 text-xs text-danger">{t("worktree.recovery.disabled")}</p>}
        <DialogFooter className="shrink-0">
          <Button variant="outline" onClick={onClose} disabled={busy}>{t("common.cancel")}</Button>
          {step === "review" && <Button onClick={handleCommit} disabled={!canCommit}>{busy ? t("common.processing") : t("worktree.finish.commitAll")}</Button>}
          {step === "merge" && <Button variant="default" onClick={canResolveConflicts ? handleResolve : handleMerge} disabled={canResolveConflicts ? busy || loadingChanges : actionsBlocked} aria-describedby={recovery.blocked ? "worktree-recovery-disabled" : undefined}>{busy ? t("common.processing") : t(canResolveConflicts ? "worktree.conflict.open" : "worktree.finish.merge")}</Button>}
          {step === "cleanup" && <Button onClick={handleCleanup} disabled={actionsBlocked} aria-describedby={recovery.blocked ? "worktree-recovery-disabled" : undefined}>{busy ? t("common.processing") : t("worktree.finish.cleanup")}</Button>}
        </DialogFooter>
      </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={forceConfirmOpen}
        title={t("worktree.finish.forceMergeConfirmTitle")}
        message={t("worktree.finish.forceMergeConfirmMessage")}
        confirmText={t("worktree.finish.forceMergeConfirm")}
        cancelText={t("common.cancel")}
        danger
        explicitCloseOnly
        onConfirm={handleForceMerge}
        onClose={() => setForceConfirmOpen(false)}
      />
    </>
  );
}
