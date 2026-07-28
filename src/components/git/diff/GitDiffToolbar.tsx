import {
  ChevronDown,
  ChevronUp,
  Columns2,
  ExternalLink,
  PanelTop,
  Pin,
  Undo2,
  WrapText,
  X,
} from "lucide-react";
import { useI18n } from "../../../lib/i18n";
import type { GitDiffOptions } from "../../../lib/gitDiffOptions";
import type { GitDiffViewMode } from "../../../stores/settingsStore";
import { GitDiffGenerationOptions } from "./GitDiffGenerationOptions";

interface GitDiffToolbarProps {
  filePath: string;
  status: string;
  fileIndex: number;
  fileCount: number;
  additions: number;
  deletions: number;
  viewMode: GitDiffViewMode;
  wrapLines: boolean;
  diffOptions?: GitDiffOptions;
  canNavigatePrevious: boolean;
  canNavigateNext: boolean;
  canOpenSource: boolean;
  canDiscardFile: boolean;
  onNavigatePrevious: () => void;
  onNavigateNext: () => void;
  onViewModeChange: (mode: GitDiffViewMode) => void;
  onWrapLinesChange?: (wrapLines: boolean) => void;
  onDiffOptionsChange?: (options: GitDiffOptions) => void;
  onOpenSource: () => void;
  onPin?: () => void;
  pinActive?: boolean;
  onRequestDiscard: () => void;
  onClose?: () => void;
}

const ICON_BUTTON_CLASS = "git-diff-toolbar-button ui-focus-ring flex h-7 w-7 shrink-0 items-center justify-center rounded transition-colors disabled:cursor-not-allowed";
const SEGMENT_BUTTON_CLASS = "git-diff-toolbar-segment ui-focus-ring flex h-6 items-center gap-1 rounded px-2 text-[11px] transition-colors";

export function GitDiffToolbar({
  filePath,
  status,
  fileIndex,
  fileCount,
  additions,
  deletions,
  viewMode,
  wrapLines,
  diffOptions,
  canNavigatePrevious,
  canNavigateNext,
  canOpenSource,
  canDiscardFile,
  onNavigatePrevious,
  onNavigateNext,
  onViewModeChange,
  onWrapLinesChange,
  onDiffOptionsChange,
  onOpenSource,
  onPin,
  pinActive = false,
  onRequestDiscard,
  onClose,
}: GitDiffToolbarProps) {
  const { t } = useI18n();

  return (
    <div
      data-git-diff-toolbar
      className="flex min-h-12 shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b px-3 py-2"
      style={{
        backgroundColor: "var(--surface-container-low)",
        borderColor: "color-mix(in srgb, var(--border) 24%, transparent)",
      }}
    >
      <div className="flex min-w-[12rem] flex-1 items-center gap-2 overflow-hidden">
        <span
          className="shrink-0 rounded px-1.5 py-0.5 text-[11px] font-semibold"
          style={{ backgroundColor: "var(--surface-container-high)", color: "var(--text-secondary)" }}
          aria-label={t("git.diff.status", { status })}
        >
          {status}
        </span>
        <span className="truncate text-[13px] font-medium text-text-primary" title={filePath}>
          {filePath}
        </span>
        <span className="shrink-0 text-[11px] text-text-muted">
          {t("git.diff.filePosition", { current: fileIndex + 1, total: fileCount })}
        </span>
        <span className="shrink-0 text-[11px]" style={{ color: "var(--success)" }}>+{additions}</span>
        <span className="shrink-0 text-[11px]" style={{ color: "var(--danger)" }}>-{deletions}</span>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          className={ICON_BUTTON_CLASS}
          onClick={onNavigatePrevious}
          disabled={!canNavigatePrevious}
          title={canNavigatePrevious ? t("git.diff.previousHunk") : t("git.diff.atFirstChange")}
          aria-label={t("git.diff.previousHunk")}
        >
          <ChevronUp size={16} />
        </button>
        <button
          type="button"
          className={ICON_BUTTON_CLASS}
          onClick={onNavigateNext}
          disabled={!canNavigateNext}
          title={canNavigateNext ? t("git.diff.nextHunk") : t("git.diff.atLastChange")}
          aria-label={t("git.diff.nextHunk")}
        >
          <ChevronDown size={16} />
        </button>
      </div>

      <div
        className="flex shrink-0 items-center rounded border p-0.5"
        style={{ borderColor: "var(--border)", backgroundColor: "var(--surface-container-lowest)" }}
        role="group"
        aria-label={t("git.diff.viewMode")}
      >
        <button
          type="button"
          className={SEGMENT_BUTTON_CLASS}
          aria-pressed={viewMode === "split"}
          onClick={() => onViewModeChange("split")}
          title={t("git.diff.split")}
        >
          <Columns2 size={13} />
          <span className="hidden sm:inline">{t("git.diff.split")}</span>
        </button>
        <button
          type="button"
          className={SEGMENT_BUTTON_CLASS}
          aria-pressed={viewMode === "unified"}
          onClick={() => onViewModeChange("unified")}
          title={t("git.diff.unified")}
        >
          <PanelTop size={13} />
          <span className="hidden sm:inline">{t("git.diff.unified")}</span>
        </button>
      </div>

      {diffOptions && onDiffOptionsChange && (
        <GitDiffGenerationOptions options={diffOptions} onChange={onDiffOptionsChange} />
      )}

      {onWrapLinesChange && (
        <button
          type="button"
          className={ICON_BUTTON_CLASS}
          aria-pressed={wrapLines}
          onClick={() => onWrapLinesChange(!wrapLines)}
          title={wrapLines ? t("git.diff.disableWrap") : t("git.diff.enableWrap")}
          aria-label={wrapLines ? t("git.diff.disableWrap") : t("git.diff.enableWrap")}
        >
          <WrapText size={15} />
        </button>
      )}

      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          className={ICON_BUTTON_CLASS}
          onClick={onOpenSource}
          disabled={!canOpenSource}
          title={t("git.diff.openSource")}
          aria-label={t("git.diff.openSource")}
        >
          <ExternalLink size={15} />
        </button>
        {onPin && (
          <button
            type="button"
            className={ICON_BUTTON_CLASS}
            onClick={onPin}
            aria-pressed={pinActive}
            title={pinActive ? t("git.diff.useDialogByDefault") : t("git.diff.pin")}
            aria-label={pinActive ? t("git.diff.useDialogByDefault") : t("git.diff.pin")}
          >
            <Pin size={15} />
          </button>
        )}
        {canDiscardFile && (
          <button
            type="button"
            className={ICON_BUTTON_CLASS}
            onClick={onRequestDiscard}
            title={t("git.diff.revertFileTitle")}
            aria-label={t("git.diff.revertFileTitle")}
            style={{ color: "var(--danger)" }}
          >
            <Undo2 size={15} />
          </button>
        )}
        {onClose && (
          <button
            type="button"
            className={ICON_BUTTON_CLASS}
            onClick={onClose}
            title={t("common.close")}
            aria-label={t("common.close")}
          >
            <X size={17} />
          </button>
        )}
      </div>
    </div>
  );
}
