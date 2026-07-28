import Editor, { type OnMount } from "@monaco-editor/react";
import { useI18n } from "../../lib/i18n";
import type { Project } from "../../lib/types";
import type { ActiveProjectFile } from "../../stores/fileExplorerStore";
import type {
  GitDiffWorkspaceContext,
  GitDiffWorkspaceTab,
  ProjectGitDiffWorkspace,
} from "../../stores/gitDiffWorkspaceStore";
import { GitDiffEditorHost } from "../git/diff/GitDiffEditorHost";
import { FileCode, Image } from "../icons";
import { MarkdownContent } from "../ui/MarkdownContent";

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
  return (
    <div className="ui-file-editor-body min-h-0 flex-1 overflow-hidden bg-surface">
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
          <div className="ui-file-editor-markdown-preview h-full overflow-auto p-4">
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
              fontSize: 13,
              glyphMargin: true,
              minimap: { enabled: true },
              scrollBeyondLastLine: false,
              wordWrap: "on",
            }}
          />
        )
      )}
    </div>
  );
}
