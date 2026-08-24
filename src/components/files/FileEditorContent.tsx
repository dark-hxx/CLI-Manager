import Editor, { type OnMount } from "@monaco-editor/react";
import { useEffect, useState, type CSSProperties, type WheelEvent as ReactWheelEvent } from "react";
import { useI18n } from "../../lib/i18n";
import { normalizeFontFamilyStack } from "../../lib/systemFonts";
import type { Project } from "../../lib/types";
import type { ActiveProjectFile } from "../../stores/fileExplorerStore";
import type {
  GitDiffWorkspaceContext,
  GitDiffWorkspaceTab,
  ProjectGitDiffWorkspace,
} from "../../stores/gitDiffWorkspaceStore";
import { GitDiffEditorHost } from "../git/diff/GitDiffEditorHost";
import { FileCode, Image } from "../icons";
import { FontSizeControl, useFontSizeControlVisibility } from "../ui/FontSizeControl";
import { MarkdownContent } from "../ui/MarkdownContent";
import { useSettingsStore } from "../../stores/settingsStore";

const FILE_PREVIEW_FONT_SIZE_MIN = 8;
const FILE_PREVIEW_FONT_SIZE_MAX = 32;

interface FileEditorContentProps {
  file: ActiveProjectFile | null;
  activeDiff: GitDiffWorkspaceTab | null;
  project: Project | null;
  diffContext: GitDiffWorkspaceContext | null;
  diffWorkspace: ProjectGitDiffWorkspace;
  previewMode: "source" | "preview";
  language: string;
  editorTheme: string;
  onEditorMount: OnMount;
  onContentChange: (content: string) => void;
}

export function FileEditorContent({
  file,
  activeDiff,
  project,
  diffContext,
  diffWorkspace,
  previewMode,
  language,
  editorTheme,
  onEditorMount,
  onContentChange,
}: FileEditorContentProps) {
  const { t } = useI18n();
  const uiFontFamily = useSettingsStore((state) => state.uiFontFamily);
  const uiFontSize = useSettingsStore((state) => state.uiFontSize);
  const effectiveUiFontFamily = normalizeFontFamilyStack(uiFontFamily);
  const [fontSize, setFontSize] = useState(uiFontSize);
  const { fontSizeControlVisible, showFontSizeControl } = useFontSizeControlVisibility();
  const previewableText = file?.previewKind === "text" || file?.previewKind === "markdown";

  useEffect(() => setFontSize(uiFontSize), [uiFontSize]);

  const handlePreviewWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    if (!previewableText || !event.ctrlKey || event.deltaY === 0) return;
    event.preventDefault();
    showFontSizeControl();
    const direction = event.deltaY < 0 ? 1 : -1;
    setFontSize((current) => Math.min(
      FILE_PREVIEW_FONT_SIZE_MAX,
      Math.max(FILE_PREVIEW_FONT_SIZE_MIN, current + direction),
    ));
  };

  return (
    <div
      className="ui-file-editor-body relative min-h-0 flex-1 overflow-hidden bg-surface"
      onWheelCapture={handlePreviewWheel}
    >
      {!file && !activeDiff && (
        <div className="flex h-full flex-col items-center justify-center gap-2 text-text-muted">
          <FileCode size={36} strokeWidth={1.2} />
          <div className="text-sm">{t("files.editor.selectFromTree")}</div>
        </div>
      )}
      {activeDiff && project && diffContext && (
        <GitDiffEditorHost project={project} context={diffContext} workspace={diffWorkspace} />
      )}
      {file?.previewKind === "unsupported" && (
        <div className="flex h-full flex-col items-center justify-center gap-2 text-text-muted">
          <FileCode size={36} strokeWidth={1.2} />
          <div className="text-sm">{t("files.editor.unsupported")}</div>
        </div>
      )}
      {file?.previewKind === "image" && file.image && (
        <div className="ui-file-editor-image-preview flex h-full items-center justify-center overflow-auto bg-surface-container-lowest p-4">
          <div className="flex max-h-full max-w-full flex-col items-center gap-3">
            <img
              src={`data:${file.image.mimeType};base64,${file.image.dataBase64}`}
              alt={file.name}
              className="max-h-[calc(100vh-180px)] max-w-full rounded border border-border object-contain"
            />
            <div className="flex items-center gap-2 text-xs text-text-muted">
              <Image size={13} />
              {(file.image.sizeBytes / 1024).toFixed(1)} KB
            </div>
          </div>
        </div>
      )}
      {file && (file.previewKind === "text" || file.previewKind === "markdown") && (
        file.previewKind === "markdown" && previewMode === "preview" ? (
          <div
            className="ui-file-editor-markdown-preview h-full overflow-auto p-4"
            style={{
              "--markdown-preview-font-size": `${fontSize}px`,
              fontFamily: effectiveUiFontFamily,
              fontSize,
            } as CSSProperties & Record<"--markdown-preview-font-size", string>}
          >
            <MarkdownContent content={file.content} variant="terminal" linkBehavior="preview" />
          </div>
        ) : (
          <Editor
            path={file.path}
            value={file.content}
            language={language}
            theme={editorTheme}
            onMount={onEditorMount}
            onChange={(value) => onContentChange(value ?? "")}
            options={{
              automaticLayout: true,
              fontFamily: effectiveUiFontFamily,
              fontSize,
              glyphMargin: true,
              minimap: { enabled: true },
              scrollBeyondLastLine: false,
              wordWrap: "on",
            }}
          />
        )
      )}
      {previewableText && fontSizeControlVisible && (
        <FontSizeControl
          fontSize={fontSize}
          defaultFontSize={uiFontSize}
          min={FILE_PREVIEW_FONT_SIZE_MIN}
          max={FILE_PREVIEW_FONT_SIZE_MAX}
          onChange={(next) => {
            showFontSizeControl();
            setFontSize(next);
          }}
          className="absolute bottom-3 right-3 z-20"
        />
      )}
    </div>
  );
}
