import { Check } from "lucide-react";
import { useI18n } from "../../../../shared/i18n/index";
import { Button } from "../../../../shared/ui/button";
import { conflictChoiceProgress } from "../../lib/conflictProgress";
import type { ConflictDetail } from "../../lib/conflictProtocol";

export function ConflictFileConfirmation({ detail, disabled, onConfirm }: {
  detail: ConflictDetail; disabled: boolean; onConfirm: () => void;
}) {
  const { t } = useI18n();
  const progress = conflictChoiceProgress(detail);
  return <div className="conflict-file-confirmation" data-ready={progress.complete}>
    <div role="status" className="conflict-file-confirmation-message">
      <strong>{t(progress.complete ? "worktree.conflict.allBlocksResolved" : "worktree.conflict.choiceProgress",
        { chosen: progress.chosen, total: progress.total })}</strong>
      <span>{t(progress.complete ? "worktree.conflict.confirmFileHint" : "worktree.conflict.chooseRemainingHint")}</span>
    </div>
    <Button size="sm" variant={progress.complete ? "default" : "outline"}
      disabled={disabled || !progress.complete} onClick={onConfirm} title={t("worktree.conflict.resolveFile")}>
      <Check size={14} aria-hidden="true" />{t("worktree.conflict.resolveFileShort")}
    </Button>
  </div>;
}
