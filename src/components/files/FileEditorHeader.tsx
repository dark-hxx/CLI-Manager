import { useI18n } from "../../lib/i18n";
import { Button } from "../ui/button";
import { Copy, FileCode, Save, X } from "../icons";

interface FileEditorHeaderProps {
  title: string;
  path: string;
  dirty: boolean;
  showMarkdownModes: boolean;
  previewMode: "source" | "preview";
  canUseFileActions: boolean;
  onPreviewModeChange: (mode: "source" | "preview") => void;
  onCopyAiPath: () => void;
  onCopyAiContext: () => void;
  onSave: () => void;
  onClose: () => void;
}

export function FileEditorHeader({
  title,
  path,
  dirty,
  showMarkdownModes,
  previewMode,
  canUseFileActions,
  onPreviewModeChange,
  onCopyAiPath,
  onCopyAiContext,
  onSave,
  onClose,
}: FileEditorHeaderProps) {
  const { t } = useI18n();
  return (
    <div className="ui-file-editor-header flex h-10 shrink-0 items-center gap-2 border-b border-border bg-surface-container-low px-3">
      <FileCode size={15} strokeWidth={1.8} className="text-on-surface-variant" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-semibold text-on-surface">{title}{dirty ? " *" : ""}</div>
        <div className="truncate text-[10px] text-text-muted">{path}</div>
      </div>
      {showMarkdownModes && (
        <div className="ui-file-editor-segment flex rounded-md border border-border bg-surface-container-lowest p-0.5">
          <button
            type="button"
            className="rounded px-2 py-1 text-[11px]"
            data-active={previewMode === "source" ? "true" : "false"}
            onClick={() => onPreviewModeChange("source")}
          >
            {t("files.editor.source")}
          </button>
          <button
            type="button"
            className="rounded px-2 py-1 text-[11px]"
            data-active={previewMode === "preview" ? "true" : "false"}
            onClick={() => onPreviewModeChange("preview")}
          >
            {t("files.editor.preview")}
          </button>
        </div>
      )}
      <Button size="sm" variant="outline" disabled={!canUseFileActions} onClick={onCopyAiPath}>
        <Copy size={13} />
        {t("files.editor.aiPath")}
      </Button>
      <Button size="sm" variant="outline" disabled={!canUseFileActions} onClick={onCopyAiContext}>
        <Copy size={13} />
        {t("files.editor.aiContext")}
      </Button>
      <Button size="sm" variant="outline" disabled={!dirty} onClick={onSave}>
        <Save size={13} />
        {t("common.save")}
      </Button>
      <button
        type="button"
        className="ui-icon-action"
        title={t("files.editor.close")}
        aria-label={t("files.editor.close")}
        onClick={onClose}
      >
        <X size={15} />
      </button>
    </div>
  );
}
