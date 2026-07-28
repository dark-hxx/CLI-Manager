import type { OnMount } from "@monaco-editor/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { copyAiText } from "../../lib/aiClipboard";
import { formatAiAnchor, formatAiContextBlock, type AiTextSelection } from "../../lib/aiPathFormatter";
import { useI18n } from "../../lib/i18n";
import type { GitFileChange, TerminalSession } from "../../lib/types";
import { configureMonaco, languageFromPath } from "../../lib/monacoSetup";
import { isSameProjectFileContext } from "../../lib/terminalProject";
import { useSettingsStore } from "../../stores/settingsStore";
import { useFileExplorerStore } from "../../stores/fileExplorerStore";
import { useProjectStore } from "../../stores/projectStore";
import {
  createGitDiffWorkspaceContext,
  EMPTY_GIT_DIFF_WORKSPACE,
  resolveGitDiffProject,
  useGitDiffWorkspaceStore,
} from "../../stores/gitDiffWorkspaceStore";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "../ui/dialog";
import { FileEditorContent } from "./FileEditorContent";
import { FileEditorHeader } from "./FileEditorHeader";
import { FileEditorTabs } from "./FileEditorTabs";
import { clearEditorDecorations, useGitFileDecorations } from "./useGitFileDecorations";
import { useFileEditorSearchNavigation } from "./useFileEditorSearchNavigation";
import { useFileEditorShortcuts } from "./useFileEditorShortcuts";

configureMonaco();

interface FileEditorPaneProps {
  session: TerminalSession;
  isActive: boolean;
  terminalThemeBackground: string;
  onClose: () => void;
}

type PendingAction = { kind: "close-pane" } | { kind: "close-file"; path: string } | null;

type MonacoEditor = Parameters<OnMount>[0];

function isDarkHexColor(color: string): boolean {
  const raw = color.trim().replace(/^#/, "");
  const hex = raw.length === 3
    ? raw.split("").map((char) => `${char}${char}`).join("")
    : raw;
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return true;
  const red = Number.parseInt(hex.slice(0, 2), 16);
  const green = Number.parseInt(hex.slice(2, 4), 16);
  const blue = Number.parseInt(hex.slice(4, 6), 16);
  const luminance = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
  return luminance < 0.5;
}

export function FileEditorPane({ session, isActive, terminalThemeBackground, onClose }: FileEditorPaneProps) {
  const { t } = useI18n();
  const editorRef = useRef<MonacoEditor | null>(null);
  const searchDecorationIdsRef = useRef<string[]>([]);
  const gitDecorationIdsRef = useRef<string[]>([]);
  const [editorReadyNonce, setEditorReadyNonce] = useState(0);
  const copyAiShortcut = useSettingsStore((s) => s.keyboardShortcuts.copyAi);
  const project = useFileExplorerStore((s) => s.project);
  const openProject = useFileExplorerStore((s) => s.openProject);
  const openFiles = useFileExplorerStore((s) => s.openFiles);
  const activeFilePath = useFileExplorerStore((s) => s.activeFilePath);
  const activeFile = useFileExplorerStore((s) => s.activeFile);
  const searchQuery = useFileExplorerStore((s) => s.searchQuery);
  const gitChanges = useFileExplorerStore((s) => s.gitChanges);
  const searchNavigationTarget = useFileExplorerStore((s) => s.searchNavigationTarget);
  const setActiveFilePath = useFileExplorerStore((s) => s.setActiveFilePath);
  const clearSearchNavigationTarget = useFileExplorerStore((s) => s.clearSearchNavigationTarget);
  const closeFile = useFileExplorerStore((s) => s.closeFile);
  const setActiveContent = useFileExplorerStore((s) => s.setActiveContent);
  const saveFile = useFileExplorerStore((s) => s.saveFile);
  const saveActiveFile = useFileExplorerStore((s) => s.saveActiveFile);
  const projects = useProjectStore((s) => s.projects);
  const [previewMode, setPreviewMode] = useState<"source" | "preview">("source");
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const sessionProject = session.fileEditor?.project ?? null;
  const latestProject = sessionProject
    ? projects.find((candidate) => candidate.id === sessionProject.id) ?? null
    : null;
  const editorProject = useMemo(
    () => sessionProject ? resolveGitDiffProject(sessionProject, latestProject) : null,
    [latestProject, sessionProject],
  );
  const diffContext = useMemo(
    () => editorProject ? createGitDiffWorkspaceContext(editorProject) : null,
    [editorProject],
  );
  const diffWorkspace = useGitDiffWorkspaceStore((state) => (
    diffContext ? state.workspaces[diffContext.key] ?? EMPTY_GIT_DIFF_WORKSPACE : EMPTY_GIT_DIFF_WORKSPACE
  ));
  const activeDiff = diffWorkspace.tabs.find((tab) => tab.id === diffWorkspace.activeId) ?? null;
  const ownsFileState = isSameProjectFileContext(project, editorProject);
  const visibleFiles = ownsFileState ? openFiles : [];
  const visibleFile = ownsFileState && !activeDiff ? activeFile : null;
  const dirty = Boolean(visibleFile && visibleFile.content !== visibleFile.savedContent);
  const dirtyFiles = visibleFiles.filter((file) => file.content !== file.savedContent);
  const activeGitChange = useMemo<GitFileChange | null>(
    () => visibleFile ? gitChanges.find((change) => change.path === visibleFile.path) ?? null : null,
    [gitChanges, visibleFile?.path]
  );
  const language = useMemo(() => visibleFile ? languageFromPath(visibleFile.path) : "plaintext", [visibleFile]);
  const editorTheme = useMemo(
    () => isDarkHexColor(terminalThemeBackground) ? "vs-dark" : "vs",
    [terminalThemeBackground]
  );

  const handleEditorMount = useCallback<OnMount>((editor) => {
    editorRef.current = editor;
    setEditorReadyNonce((value) => value + 1);
  }, []);

  useGitFileDecorations({
    editorRef,
    decorationIdsRef: gitDecorationIdsRef,
    editorReadyNonce,
    project: editorProject,
    change: activeGitChange,
    filePath: visibleFile?.path ?? null,
    previewKind: visibleFile?.previewKind ?? null,
    previewMode,
    modifiedMs: visibleFile?.modifiedMs,
    sizeBytes: visibleFile?.sizeBytes,
  });

  useEffect(() => {
    if (!isActive || !editorProject || isSameProjectFileContext(project, editorProject)) return;
    void openProject(editorProject);
  }, [editorProject, isActive, openProject, project]);

  useEffect(() => {
    setPreviewMode("source");
  }, [visibleFile?.path]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    clearEditorDecorations(editor, searchDecorationIdsRef);
    clearEditorDecorations(editor, gitDecorationIdsRef);
  }, [visibleFile?.path]);

  useFileEditorSearchNavigation({
    editorRef,
    decorationIdsRef: searchDecorationIdsRef,
    editorReadyNonce,
    file: visibleFile,
    previewMode,
    target: searchNavigationTarget,
    searchQuery,
    setPreviewMode,
    onHandled: clearSearchNavigationTarget,
  });

  const save = useCallback(async () => {
    if (!visibleFile || visibleFile.previewKind === "image") return;
    try {
      await saveActiveFile();
    } catch {
      // Store 已提示错误；保留 dirty 状态。
    }
  }, [saveActiveFile, visibleFile]);

  const getEditorSelection = useCallback((): AiTextSelection | null => {
    const selection = editorRef.current?.getSelection();
    if (!editorRef.current || !selection || selection.isEmpty()) return null;
    return {
      startLine: selection.startLineNumber,
      endLine: selection.endLineNumber,
      text: editorRef.current.getModel()?.getValueInRange(selection),
    };
  }, []);

  const copyActiveAiPath = useCallback(() => {
    if (!project || !visibleFile) return;
    const selection = (visibleFile.previewKind === "text" || visibleFile.previewKind === "markdown") && previewMode === "source"
      ? getEditorSelection()
      : null;
    void copyAiText(formatAiAnchor(project, visibleFile.path, selection), t("files.toast.aiPathCopied"));
  }, [getEditorSelection, previewMode, project, t, visibleFile]);

  const copyActiveAiContext = useCallback(() => {
    if (!project || !visibleFile) return;
    const selection = (visibleFile.previewKind === "text" || visibleFile.previewKind === "markdown") && previewMode === "source"
      ? getEditorSelection()
      : null;
    void copyAiText(formatAiContextBlock(project, visibleFile.path, selection), t("files.toast.aiContextCopied"));
  }, [getEditorSelection, previewMode, project, t, visibleFile]);

  useFileEditorShortcuts({
    active: isActive,
    copyAiShortcut,
    onCopyAiPath: copyActiveAiPath,
    onSave: save,
  });

  const requestClose = () => {
    if (dirtyFiles.length > 0) {
      setPendingAction({ kind: "close-pane" });
      return;
    }
    onClose();
  };

  const discardAndRun = () => {
    setPendingAction(null);
    if (pendingAction?.kind === "close-file") {
      closeFile(pendingAction.path);
      return;
    }
    visibleFiles.forEach((file) => closeFile(file.path));
    onClose();
  };

  const saveAndRun = async () => {
    try {
      if (pendingAction?.kind === "close-file") {
        await saveFile(pendingAction.path);
        closeFile(pendingAction.path);
        setPendingAction(null);
        return;
      }
      for (const file of dirtyFiles) {
        await saveFile(file.path);
      }
      visibleFiles.forEach((file) => closeFile(file.path));
      setPendingAction(null);
      onClose();
    } catch {
      // 保存失败时保持确认框和未保存文件不变。
    }
  };

  const requestCloseFile = (path: string) => {
    const file = visibleFiles.find((item) => item.path === path);
    if (!file) return;
    if (file.content !== file.savedContent) {
      setPendingAction({ kind: "close-file", path });
      return;
    }
    closeFile(path);
  };

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
        onCloseFile={requestCloseFile}
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
      />

      <Dialog open={pendingAction !== null} onOpenChange={(open) => { if (!open) setPendingAction(null); }}>
        <DialogContent className="max-w-[420px]">
          <DialogTitle>{t("files.editor.unsavedTitle")}</DialogTitle>
          <DialogDescription className="mt-2">
            {pendingAction?.kind === "close-file"
              ? t("files.editor.unsavedOne")
              : t("files.editor.unsavedMany", { count: dirtyFiles.length })}
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
