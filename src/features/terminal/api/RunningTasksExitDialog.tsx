import { useEffect, useState } from "react";
import { AlertTriangle } from "../../../shared/ui/icons";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogFooter,
} from "../../../shared/ui/dialog";
import { Button } from "../../../shared/ui/button";
import { useI18n } from "../../../shared/i18n/index";

type RunningTasksExitAction = "background" | "minimize" | "discard";

interface Props {
  open: boolean;
  runningCount: number;
  onBackground: (remember: boolean) => void;
  onMinimize: (remember: boolean) => void;
  onDiscard: (remember: boolean) => void;
  onClose: () => void;
}

/** 退出时存在运行中任务的询问弹窗（Issue #123 Phase 1/2）。 */
export function RunningTasksExitDialog({ open, runningCount, onBackground, onMinimize, onDiscard, onClose }: Props) {
  const { t } = useI18n();
  const [action, setAction] = useState<RunningTasksExitAction>("background");
  const [remember, setRemember] = useState(false);

  useEffect(() => {
    if (open) {
      setAction("background");
      setRemember(false);
    }
  }, [open]);

  const handleConfirm = () => {
    if (action === "background") {
      onBackground(remember);
      return;
    }
    if (action === "minimize") {
      onMinimize(remember);
      return;
    }
    onDiscard(remember);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        className="max-w-[360px] p-4"
        showCloseButton={false}
        aria-labelledby="running-tasks-exit-title"
      >
        <div className="flex items-start gap-2">
          <AlertTriangle
            size={16}
            className="mt-0.5 shrink-0 text-yellow-500"
            strokeWidth={2}
          />
          <DialogTitle id="running-tasks-exit-title" className="text-[13px]">
            {t("dialogs.runningTasksExit.title", { count: runningCount })}
          </DialogTitle>
        </div>

        <div className="mt-3 ml-6 flex flex-col gap-1.5">
          <label className="flex cursor-pointer items-center gap-2 text-[13px] text-text-primary">
            <input
              type="radio"
              name="running-tasks-exit-action"
              value="background"
              checked={action === "background"}
              onChange={() => setAction("background")}
              className="h-3.5 w-3.5 accent-accent"
            />
            {t("dialogs.runningTasksExit.background")}
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-[13px] text-text-primary">
            <input
              type="radio"
              name="running-tasks-exit-action"
              value="discard"
              checked={action === "discard"}
              onChange={() => setAction("discard")}
              className="h-3.5 w-3.5 accent-accent"
            />
            {t("dialogs.runningTasksExit.discard")}
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-[13px] text-text-primary">
            <input
              type="radio"
              name="running-tasks-exit-action"
              value="minimize"
              checked={action === "minimize"}
              onChange={() => setAction("minimize")}
              className="h-3.5 w-3.5 accent-accent"
            />
            {t("dialogs.runningTasksExit.minimize")}
          </label>
        </div>

        <DialogFooter className="mt-4 flex !justify-between gap-2">
          <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-text-secondary">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
              className="h-3 w-3 accent-accent"
            />
            {t("dialogs.runningTasksExit.remember")}
          </label>
          <div className="flex items-center gap-1.5">
            <Button variant="outline" size="sm" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button variant="default" size="sm" onClick={handleConfirm}>
              {t("common.confirm")}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
