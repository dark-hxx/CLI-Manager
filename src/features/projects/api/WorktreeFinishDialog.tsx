import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import type { GitFileChange, Project, WorktreeRecord } from "../../../shared/types/index";
import { useI18n, type TranslationKey } from "../../../shared/i18n/index";
import { useWorktreeStore } from "./worktreeStore";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "../../../shared/ui/dialog";
import { Button } from "../../../shared/ui/button";
import { Textarea } from "../../../shared/ui/textarea";

interface WorktreeFinishDialogProps {
  project: Project | null;
  worktree: WorktreeRecord | null;
  open: boolean;
  onClose: () => void;
}

type Step = "review" | "merge" | "cleanup" | "done";
type Translate = (key: TranslationKey, params?: Record<string, string | number>) => string;

interface FinishErrorInfo {
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

function createMergeConflictError(conflictFiles: string[], t: Translate): FinishErrorInfo {
  return {
    title: t("worktree.finish.error.conflictTitle"),
    description: t("worktree.finish.error.conflictDescription"),
    details: conflictFiles.length > 0 ? conflictFiles : [t("worktree.finish.error.noConflictFiles")],
  };
}

function formatFinishError(err: unknown, t: Translate, projectPath?: string): FinishErrorInfo {
  const raw = errorText(err).trim();
  if (raw.includes("dirty_main_worktree")) {
    return {
      title: t("worktree.finish.error.dirtyMainTitle"),
      description: t("worktree.finish.error.dirtyMainDescription"),
      details: [
        ...(projectPath ? [t("worktree.finish.error.mainPath", { path: projectPath })] : []),
        t("worktree.finish.error.dirtyMainAction"),
        t("worktree.finish.error.dirtyMainSafe"),
      ],
    };
  }

  if (raw.includes("worktree_branch_not_found") || raw.includes("branch_not_found")) {
    return {
      title: t("worktree.finish.error.branchMissingTitle"),
      description: t("worktree.finish.error.branchMissingDescription"),
      raw,
    };
  }

  if (raw.includes("merge_failed")) {
    return {
      title: t("worktree.finish.error.mergeFailedTitle"),
      description: t("worktree.finish.error.mergeFailedDescription"),
      raw,
    };
  }

  return {
    title: t("worktree.finish.error.genericTitle"),
    description: t("worktree.finish.error.genericDescription"),
    raw,
  };
}

export function WorktreeFinishDialog({ project, worktree, open, onClose }: WorktreeFinishDialogProps) {
  const { t } = useI18n();
  const mergeWorktree = useWorktreeStore((state) => state.mergeWorktree);
  const removeWorktree = useWorktreeStore((state) => state.removeWorktree);
  const [changes, setChanges] = useState<GitFileChange[]>([]);
  const [loadingChanges, setLoadingChanges] = useState(false);
  const [step, setStep] = useState<Step>("review");
  const [commitMessage, setCommitMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [output, setOutput] = useState("");
  const [error, setError] = useState<FinishErrorInfo | null>(null);

  useEffect(() => {
    if (!open || !worktree) return;
    setStep("review");
    setCommitMessage(worktree.name);
    setOutput("");
    setError(null);
    setLoadingChanges(true);
    invoke<GitFileChange[]>("git_get_changes", { projectPath: worktree.path })
      .then((items) => {
        setChanges(items);
        if (items.length === 0) setStep("merge");
      })
      .catch((err) => setError(formatFinishError(err, t, worktree.path)))
      .finally(() => setLoadingChanges(false));
  }, [open, t, worktree]);

  const changeSummary = useMemo(() => formatChangeSummary(changes), [changes]);
  const canCommit = changes.length > 0 && commitMessage.trim().length > 0 && !busy;

  if (!project || !worktree) return null;

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
      setBusy(false);
    }
  };

  const handleMerge = async () => {
    setBusy(true);
    setError(null);
    setOutput((current) => `${current}\n\ngit -C "${project.path}" merge --no-ff --no-edit ${worktree.branch}`);
    try {
      const result = await mergeWorktree(worktree);
      setOutput((current) => `${current}\n${result.output}`);
      if (result.merged) {
        setStep("cleanup");
      } else if (result.skipped && result.skipReason === "no_diff") {
        setOutput((current) => `${current}\n${t("worktree.finish.noDiffToMerge")}`);
        setStep("cleanup");
      } else {
        setError(createMergeConflictError(result.conflictFiles, t));
      }
    } catch (err) {
      setError(formatFinishError(err, t, project.path));
    } finally {
      setBusy(false);
    }
  };

  const handleCleanup = async () => {
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
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="max-w-[520px]" showCloseButton={false}>
        <DialogTitle>{t("worktree.finish.title", { name: worktree.name })}</DialogTitle>
        <DialogDescription className="mt-2">
          {t("worktree.finish.description", { branch: worktree.branch })}
        </DialogDescription>

        <div className="mt-4 space-y-3 text-sm">
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
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>{t("common.cancel")}</Button>
          {step === "review" && <Button onClick={handleCommit} disabled={!canCommit}>{busy ? t("common.processing") : t("worktree.finish.commitAll")}</Button>}
          {step === "merge" && <Button onClick={handleMerge} disabled={busy}>{busy ? t("common.processing") : t("worktree.finish.merge")}</Button>}
          {step === "cleanup" && <Button onClick={handleCleanup} disabled={busy}>{busy ? t("common.processing") : t("worktree.finish.cleanup")}</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
