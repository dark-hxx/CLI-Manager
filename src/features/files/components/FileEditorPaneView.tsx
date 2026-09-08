import { Button } from "../../../shared/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "../../../shared/ui/dialog";
import { FileEditorContent } from "./FileEditorContent";
import { FileEditorHeader } from "./FileEditorHeader";
import { FileEditorTabs } from "./FileEditorTabs";
import type { useFileEditorController } from "../hooks/useFileEditorController";
type FileEditorPaneViewProps = ReturnType<typeof useFileEditorController>;

export function FileEditorPaneView(props: FileEditorPaneViewProps) {
  const {
    activeDiff, t, visibleFile, session, project, dirty, previewMode, setPreviewMode,
    copyActiveAiPath, copyActiveAiContext, save, requestClose, visibleFiles, activeFilePath,
    diffContext, diffWorkspace, setActiveFilePath, requestCloseFiles, editorProject, language,
    editorTheme, handleEditorMount, setActiveContent, handleMarkdownLinkActivate,
    pendingMarkdownNavigation, handleMarkdownFragmentHandled, pendingAction, setPendingAction,
    discardAndRun, saveAndRun,
  } = props;
  return (
    <div className="ui-file-editor-pane flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      <FileEditorHeader
        title={activeDiff
          ? t("git.diff.title", { fileName: activeDiff.fileName })
          : visibleFile?.name ?? session.fileEditor?.projectName ?? project?.name ?? t("files.editor.titleFallback")}
        path={activeDiff?.sourcePath ?? visibleFile?.path ?? session.fileEditor?.projectPath ?? project?.path ?? t("files.editor.noFile")}
        dirty={dirty}
        showMarkdownModes={visibleFile?.previewKind === "markdown"}
        previewMode={previewMode}
        canUseFileActions={Boolean(visibleFile)}
        onPreviewModeChange={setPreviewMode}
        onCopyAiPath={copyActiveAiPath}
        onCopyAiContext={copyActiveAiContext}
        onSave={() => void save()}
        onClose={requestClose}
      />
      <FileEditorTabs
        files={visibleFiles}
        activeFilePath={activeFilePath}
        activeDiff={activeDiff}
        diffContext={diffContext}
        diffWorkspace={diffWorkspace}
        onActivateFile={setActiveFilePath}
        onCloseFiles={requestCloseFiles}
      />
      <FileEditorContent
        file={visibleFile}
        activeDiff={activeDiff}
        project={editorProject}
        diffContext={diffContext}
        diffWorkspace={diffWorkspace}
        previewMode={previewMode}
        language={language}
        editorTheme={editorTheme}
        onEditorMount={handleEditorMount}
        onContentChange={setActiveContent}
        onMarkdownLinkActivate={(href) => handleMarkdownLinkActivate(href, "preview")}
        markdownFragmentRequest={pendingMarkdownNavigation?.mode === "preview"
          && pendingMarkdownNavigation.path === visibleFile?.path
          ? { id: pendingMarkdownNavigation.id, fragment: pendingMarkdownNavigation.fragment }
          : null}
        onMarkdownFragmentHandled={handleMarkdownFragmentHandled}
      />

      <Dialog open={pendingAction !== null} onOpenChange={(open) => { if (!open) setPendingAction(null); }}>
        <DialogContent className="max-w-[420px]">
          <DialogTitle>{t("files.editor.unsavedTitle")}</DialogTitle>
          <DialogDescription className="mt-2">
            {pendingAction?.dirtyPaths.length === 1
              ? t("files.editor.unsavedOne")
              : t("files.editor.unsavedMany", { count: pendingAction?.dirtyPaths.length ?? 0 })}
          </DialogDescription>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingAction(null)}>{t("common.cancel")}</Button>
            <Button variant="outline" onClick={discardAndRun}>{t("files.editor.discard")}</Button>
            <Button onClick={() => void saveAndRun()}>{t("common.save")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
