import type { OnMount } from "@monaco-editor/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { copyAiText } from "../../../lib/aiClipboard";
import { formatAiAnchor, formatAiContextBlock, type AiTextSelection } from "../../../lib/aiPathFormatter";
import { useI18n } from "../../../lib/i18n";
import type { GitFileChange } from "../../../lib/types";
import { configureMonaco, configureMonacoLocale, languageFromPath } from "../../../lib/monacoSetup";
import { findMarkdownLinkAtPosition } from "../../../lib/markdownNavigation";
import { isSameProjectFileContext } from "../../../lib/terminalProject";
import { useSettingsStore } from "../../../stores/settingsStore";
import { useFileExplorerStore, type ActiveProjectFile } from "../../../stores/fileExplorerStore";
import { useProjectStore } from "../../../stores/projectStore";
import { createGitDiffWorkspaceContext, EMPTY_GIT_DIFF_WORKSPACE, resolveGitDiffProject, useGitDiffWorkspaceStore } from "../../../stores/gitDiffWorkspaceStore";
import { clearEditorDecorations, useGitFileDecorations } from "../../../components/files/useGitFileDecorations";
import { useFileEditorSearchNavigation } from "../../../components/files/useFileEditorSearchNavigation";
import { useFileEditorShortcuts } from "../../../components/files/useFileEditorShortcuts";
import type { FileEditorPaneProps, PendingAction, MonacoEditor, MarkdownNavigationMode, PendingMarkdownNavigation } from "../types/fileEditorModel";
import { isDarkHexColor } from "../lib/fileEditorTheme";
import { useFileEditorMarkdownNavigation } from "./useFileEditorMarkdownNavigation";
configureMonaco();

export function useFileEditorController({ session, isActive, terminalThemeBackground, onClose }: FileEditorPaneProps) {
  const { language: appLanguage, t } = useI18n();
  const editorRef = useRef<MonacoEditor | null>(null);
  const searchDecorationIdsRef = useRef<string[]>([]);
  const gitDecorationIdsRef = useRef<string[]>([]);
  const markdownMouseDisposableRef = useRef<{ dispose: () => void } | null>(null);
  const markdownNavigationRef = useRef<(href: string, mode: MarkdownNavigationMode) => void>(() => undefined);
  const markdownNavigationIdRef = useRef(0);
  const markdownFileRef = useRef<ActiveProjectFile | null>(null);
  const nextMarkdownModeRef = useRef<{ path: string; mode: MarkdownNavigationMode } | null>(null);
  const [editorReadyNonce, setEditorReadyNonce] = useState(0);
  const copyAiShortcut = useSettingsStore((s) => s.keyboardShortcuts.copyAi);
  const project = useFileExplorerStore((s) => s.project);

  useEffect(() => {
    configureMonacoLocale(appLanguage);
  }, [appLanguage]);

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
  const revealPath = useFileExplorerStore((s) => s.revealPath);
  const saveFile = useFileExplorerStore((s) => s.saveFile);
  const saveActiveFile = useFileExplorerStore((s) => s.saveActiveFile);
  const projects = useProjectStore((s) => s.projects);
  const [previewMode, setPreviewMode] = useState<"source" | "preview">("source");
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [pendingMarkdownNavigation, setPendingMarkdownNavigation] = useState<PendingMarkdownNavigation | null>(null);
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
  markdownFileRef.current = visibleFile;
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
    markdownMouseDisposableRef.current?.dispose();
    markdownMouseDisposableRef.current = editor.onMouseDown((event) => {
      if (!event.event.ctrlKey || !event.event.rightButton || !event.target.position) return;
      const file = markdownFileRef.current;
      if (file?.previewKind !== "markdown") return;
      const href = findMarkdownLinkAtPosition(
        file.content,
        event.target.position.lineNumber,
        event.target.position.column,
      );
      if (!href) return;
      event.event.preventDefault();
      event.event.stopPropagation();
      markdownNavigationRef.current(href, "source");
    });
    setEditorReadyNonce((value) => value + 1);
  }, []);

  useEffect(() => () => markdownMouseDisposableRef.current?.dispose(), []);

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
    if (!isActive || !editorProject || isSameProjectFileContext(useFileExplorerStore.getState().project, editorProject)) return;
    void openProject(editorProject);
  }, [editorProject, isActive, openProject]);

  useEffect(() => {
    const requestedMode = nextMarkdownModeRef.current;
    setPreviewMode(requestedMode && requestedMode.path === visibleFile?.path ? requestedMode.mode : "source");
    if (requestedMode?.path === visibleFile?.path) nextMarkdownModeRef.current = null;
    setPendingMarkdownNavigation((pending) => {
      if (!pending || pending.path === visibleFile?.path) return pending;
      markdownNavigationIdRef.current += 1;
      nextMarkdownModeRef.current = null;
      return null;
    });
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
  const { handleMarkdownLinkActivate, handleMarkdownFragmentHandled } = useFileEditorMarkdownNavigation({
    t, visibleFile, revealPath, editorRef, markdownNavigationRef, markdownNavigationIdRef,
    nextMarkdownModeRef, pendingMarkdownNavigation, setPendingMarkdownNavigation, previewMode,
    setPreviewMode, editorReadyNonce,
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
    const paths = visibleFiles.map((file) => file.path);
    if (dirtyFiles.length > 0) {
      setPendingAction({ closePane: true, paths, dirtyPaths: dirtyFiles.map((file) => file.path) });
      return;
    }
    onClose();
  };

  const closeFiles = (paths: string[]) => paths.forEach(closeFile);
  const requestCloseFiles = (paths: string[]) => {
    const targetFiles = visibleFiles.filter((file) => paths.includes(file.path));
    if (targetFiles.length === 0) return;
    const targetPaths = targetFiles.map((file) => file.path);
    const dirtyPaths = targetFiles.filter((file) => file.content !== file.savedContent).map((file) => file.path);
    if (dirtyPaths.length > 0) {
      setPendingAction({ closePane: false, paths: targetPaths, dirtyPaths });
      return;
    }
    closeFiles(targetPaths);
  };

  const discardAndRun = () => {
    if (!pendingAction) return;
    const { closePane, paths } = pendingAction;
    setPendingAction(null);
    closeFiles(paths);
    if (closePane) onClose();
  };

  const saveAndRun = async () => {
    if (!pendingAction) return;
    try {
      const { closePane, dirtyPaths, paths } = pendingAction;
      for (const path of dirtyPaths) await saveFile(path);
      closeFiles(paths);
      setPendingAction(null);
      if (closePane) onClose();
    } catch {
      // 保存失败时保持确认框和未保存文件不变。
    }
  };
  return {
    activeDiff, t, visibleFile, session, project, dirty, previewMode, setPreviewMode,
    copyActiveAiPath, copyActiveAiContext, save, requestClose, visibleFiles, activeFilePath,
    diffContext, diffWorkspace, setActiveFilePath, requestCloseFiles, editorProject, language,
    editorTheme, handleEditorMount, setActiveContent, handleMarkdownLinkActivate,
    pendingMarkdownNavigation, handleMarkdownFragmentHandled, pendingAction, setPendingAction,
    discardAndRun, saveAndRun,
  };
}
