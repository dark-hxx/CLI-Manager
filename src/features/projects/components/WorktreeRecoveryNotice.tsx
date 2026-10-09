import { useState } from "react";
import { useI18n } from "../../../shared/i18n/index";
import { Button } from "../../../shared/ui/button";
import { ConfirmDialog } from "../../../shared/ui/ConfirmDialog";
import type { RecoveryGateSnapshot, WorktreeRecoveryGate } from "../lib/worktreeRecoveryGate";

/** 恢复提示不执行任何 Git 写操作；确认仅解除已校验状态的应用闸门。 */
export function WorktreeRecoveryNotice({ snapshot, gate, busy }: {
  snapshot: RecoveryGateSnapshot; gate: WorktreeRecoveryGate; busy: boolean;
}) {
  const { t } = useI18n();
  const [confirmToken, setConfirmToken] = useState<string | null>(null);
  if (snapshot.phase === "ready") return null;
  const loading = snapshot.phase === "loading";
  return (
    <div className="space-y-2 rounded-lg border border-danger/25 bg-danger/10 p-3 text-xs" role="status" aria-live="polite">
      <div className="font-semibold">{t(loading ? "worktree.recovery.checking" : "worktree.recovery.title")}</div>
      {!loading && <p>{t("worktree.recovery.description")}</p>}
      {snapshot.status?.reason === "repository_operation_in_progress" && <p>{t("worktree.recovery.operation")}</p>}
      {snapshot.status?.reason === "recovery_journal_corrupt" && <p>{t("worktree.recovery.corrupt")}</p>}
      {snapshot.status?.stashOid && <p className="break-all">{t("worktree.recovery.stash", { oid: snapshot.status.stashOid })}</p>}
      {snapshot.error && <pre className="max-h-28 overflow-auto whitespace-pre-wrap break-all">{snapshot.error}</pre>}
      {!loading && <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={busy} onClick={() => void gate.refresh(snapshot.phase === "error" ? "probe" : "recheck")}>{t("worktree.recovery.recheck")}</Button>
        {snapshot.phase !== "error" && snapshot.status?.canConfirm && snapshot.status.stateToken && (
          <Button variant="outline" disabled={busy} onClick={() => setConfirmToken(snapshot.status!.stateToken)}>{t("worktree.recovery.confirm")}</Button>
        )}
      </div>}
      <ConfirmDialog open={confirmToken !== null} danger explicitCloseOnly
        title={t("worktree.recovery.confirmTitle")} message={t("worktree.recovery.confirmMessage")}
        confirmText={t("worktree.recovery.confirm")} cancelText={t("common.cancel")}
        onClose={() => setConfirmToken(null)} onConfirm={() => {
          const token = confirmToken;
          setConfirmToken(null);
          if (token && !busy) void gate.refresh("confirm", token);
        }} />
    </div>
  );
}
