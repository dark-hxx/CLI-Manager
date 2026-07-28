import { Undo2, X } from "../../icons";
import type { GitDiffWhitespaceMode } from "../../../lib/gitDiffOptions";
import { useI18n } from "../../../lib/i18n";
import type { GitDiffController } from "./types";

interface GitDiffSelectionBarProps {
  controller: GitDiffController;
  whitespaceMode?: GitDiffWhitespaceMode;
}

export function GitDiffSelectionBar({
  controller,
  whitespaceMode = "exact",
}: GitDiffSelectionBarProps) {
  const { t } = useI18n();
  const {
    parsed,
    selectedKeySet,
    reverting,
    canRevertLines,
    partialRevertUnavailable,
    clearSelection,
    revertSelectedLines,
  } = controller;
  const selectedCount = selectedKeySet.size;

  return (
    <>
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {canRevertLines && parsed
          ? t("git.diff.selectedLines", { count: selectedCount })
          : ""}
      </span>
      {partialRevertUnavailable && (
        <div
          className="border-t px-4 py-2 text-[11px]"
          style={{
            borderColor: "color-mix(in srgb, var(--border) 24%, transparent)",
            backgroundColor: "var(--surface-container-low)",
            color: "var(--text-muted)",
          }}
        >
          {t(whitespaceMode === "exact"
            ? "git.diff.nonUtf8PartialRevertDisabled"
            : "git.diff.whitespacePartialRevertDisabled")}
        </div>
      )}

      {canRevertLines && parsed && selectedCount > 0 && (
        <div
          className="flex flex-wrap items-center justify-between gap-2 border-t px-4 py-2 text-[11px]"
          style={{
            borderColor: "color-mix(in srgb, var(--border) 24%, transparent)",
            backgroundColor: "var(--surface-container-low)",
            color: "var(--text-muted)",
          }}
        >
          <span className="font-medium text-text-primary">
            {t("git.diff.selectedLines", { count: selectedCount })}
          </span>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={clearSelection}
              className="ui-focus-ring flex items-center gap-1 rounded px-2 py-0.5 transition-opacity hover:opacity-80"
              style={{ color: "var(--text-muted)" }}
              title={t("git.diff.clearSelection")}
              aria-label={t("git.diff.clearSelection")}
            >
              <X size={11} aria-hidden="true" />
              {t("git.diff.clearSelection")}
            </button>
            <button
              type="button"
              onClick={() => void revertSelectedLines()}
              disabled={reverting}
              className="ui-focus-ring flex items-center gap-1 rounded px-2 py-0.5 transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-40"
              style={{
                color: "var(--danger)",
                border: "1px solid color-mix(in srgb, var(--danger) 26%, var(--border))",
              }}
            >
              <Undo2 size={11} aria-hidden="true" />
              {t("git.diff.revertSelectedLines", { count: selectedCount })}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
