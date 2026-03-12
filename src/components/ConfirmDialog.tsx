import { useEffect } from "react";

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
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 flex items-center justify-center z-50"
      style={{ backgroundColor: "rgba(0,0,0,0.5)" }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[360px] rounded-lg p-5 border"
        style={{ backgroundColor: "var(--bg-secondary)", borderColor: "var(--border)" }}
      >
        <h3 className="text-base font-semibold mb-2">{title}</h3>
        {message && (
          <p className="text-sm mb-4" style={{ color: "var(--text-secondary)" }}>
            {message}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm rounded border"
            style={{ borderColor: "var(--border)", color: "var(--text-secondary)" }}
          >
            {cancelText}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="px-3 py-1.5 text-sm rounded"
            style={{ backgroundColor: danger ? "var(--danger)" : "var(--accent)", color: "#fff" }}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
