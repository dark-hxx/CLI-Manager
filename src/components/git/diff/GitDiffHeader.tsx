import { Undo2, X } from "../../icons";
import { useI18n } from "../../../lib/i18n";

interface GitDiffHeaderProps {
  fileName: string;
  canDiscardFile: boolean;
  onRequestDiscard: () => void;
  onClose?: () => void;
}

export function GitDiffHeader({
  fileName,
  canDiscardFile,
  onRequestDiscard,
  onClose,
}: GitDiffHeaderProps) {
  const { t } = useI18n();
  return (
    <div
      data-git-diff-header
      className="flex items-center justify-between border-b px-4 py-3"
      style={{
        backgroundColor: "var(--surface-container-low)",
        borderColor: "color-mix(in srgb, var(--border) 24%, transparent)",
      }}
    >
      <h2 className="text-base font-semibold text-text-primary">
        {t("git.diff.title", { fileName })}
      </h2>
      <div className="flex items-center gap-2">
        {canDiscardFile && (
          <button
            type="button"
            onClick={onRequestDiscard}
            className="ui-focus-ring flex items-center gap-1 rounded px-2 py-1 text-[12px] transition-opacity hover:opacity-80"
            style={{
              color: "var(--danger)",
              border: "1px solid color-mix(in srgb, var(--danger) 26%, var(--border))",
            }}
            title={t("git.diff.revertFileTitle")}
          >
            <Undo2 size={13} />
            {t("git.diff.revertFile")}
          </button>
        )}
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="ui-focus-ring rounded p-1 transition-opacity hover:opacity-70"
            style={{ color: "var(--text-muted)" }}
            title={t("common.close")}
            aria-label={t("common.close")}
          >
            <X size={18} strokeWidth={1.5} />
          </button>
        )}
      </div>
    </div>
  );
}
