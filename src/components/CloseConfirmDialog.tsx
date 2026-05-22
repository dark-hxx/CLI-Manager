import { useEffect, useState } from "react";
import { AlertTriangle } from "./icons";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogFooter,
} from "./ui/dialog";
import { Button } from "./ui/button";

type CloseAction = "minimize" | "exit";

interface Props {
  open: boolean;
  onMinimize: (remember: boolean) => void;
  onExit: (remember: boolean) => void;
  onClose: () => void;
}

export function CloseConfirmDialog({ open, onMinimize, onExit, onClose }: Props) {
  const [action, setAction] = useState<CloseAction>("minimize");
  const [remember, setRemember] = useState(false);

  useEffect(() => {
    if (open) {
      setAction("minimize");
      setRemember(false);
    }
  }, [open]);

  const handleConfirm = () => {
    if (action === "minimize") {
      onMinimize(remember);
    } else {
      onExit(remember);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        className="max-w-[300px] p-4"
        showCloseButton={false}
        aria-labelledby="close-confirm-title"
      >
        <div className="flex items-start gap-2">
          <AlertTriangle
            size={16}
            className="mt-0.5 shrink-0 text-yellow-500"
            strokeWidth={2}
          />
          <DialogTitle id="close-confirm-title" className="text-[13px]">
            您点击了关闭按钮，您想要：
          </DialogTitle>
        </div>

        <div className="mt-3 ml-6 flex flex-col gap-1.5">
          <label className="flex cursor-pointer items-center gap-2 text-[13px] text-text-primary">
            <input
              type="radio"
              name="close-action"
              value="minimize"
              checked={action === "minimize"}
              onChange={() => setAction("minimize")}
              className="h-3.5 w-3.5 accent-accent"
            />
            最小化到托盘
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-[13px] text-text-primary">
            <input
              type="radio"
              name="close-action"
              value="exit"
              checked={action === "exit"}
              onChange={() => setAction("exit")}
              className="h-3.5 w-3.5 accent-accent"
            />
            退出
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
            不再提示
          </label>
          <div className="flex items-center gap-1.5">
            <Button variant="outline" size="sm" onClick={onClose}>
              取消
            </Button>
            <Button variant="default" size="sm" onClick={handleConfirm}>
              确定
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
