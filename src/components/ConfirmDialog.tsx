import { useEffect, useRef, useState } from "react";
import { useFocusTrap } from "../hooks/useFocusTrap";

interface Props {
  open: boolean;
  title: string;
  message?: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmText = "Confirm",
  cancelText = "Cancel",
  danger = false,
  onConfirm,
  onClose,
}: Props) {
  const [mounted, setMounted] = useState(open);
  const [closing, setClosing] = useState(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(dialogRef, mounted && !closing);

  useEffect(() => {
    if (open) {
      setMounted(true);
      setClosing(false);
      return;
    }
    if (!mounted) return;
    setClosing(true);
    const timer = setTimeout(() => {
      setMounted(false);
      setClosing(false);
    }, 180);
    return () => clearTimeout(timer);
  }, [open, mounted]);

  useEffect(() => {
    if (!open || closing) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose, closing]);

  if (!mounted) return null;

  return (
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center ${closing ? "animate-fade-out bg-black/50" : "animate-fade-in bg-black/50"}`}
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        onClick={(e) => e.stopPropagation()}
        className={`w-[360px] rounded-lg border border-border bg-bg-secondary p-5 ${closing ? "animate-scale-out" : "animate-scale-in"}`}
        role="dialog"
        aria-modal="true"
      >
        <h3 className="text-base font-semibold mb-2">{title}</h3>
        {message && (
          <p className="mb-4 text-sm text-text-secondary">
            {message}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-border px-3 py-1.5 text-sm text-text-secondary"
          >
            {cancelText}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={`rounded px-3 py-1.5 text-sm text-white ${danger ? "bg-danger" : "bg-accent"}`}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
