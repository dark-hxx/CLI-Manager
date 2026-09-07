import type { OnMount } from "@monaco-editor/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { copyAiText } from "../../lib/aiClipboard";
import { formatAiAnchor, formatAiContextBlock, type AiTextSelection } from "../../lib/aiPathFormatter";
import { useI18n } from "../../lib/i18n";
import type { GitFileChange, TerminalSession } from "../../lib/types";
import { configureMonaco, configureMonacoLocale, languageFromPath } from "../../lib/monacoSetup";
import {
  findMarkdownHeadingLine,
  findMarkdownLinkAtPosition,
  resolveMarkdownHref,
} from "../../lib/markdownNavigation";
import { isSameProjectFileContext } from "../../lib/terminalProject";
import { useSettingsStore } from "../../stores/settingsStore";
import { useFileExplorerStore, type ActiveProjectFile } from "../../stores/fileExplorerStore";
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

type PendingAction = { closePane: boolean; paths: string[]; dirtyPaths: string[] } | null;
type MonacoEditor = Parameters<OnMount>[0];
type MarkdownNavigationMode = "source" | "preview";

interface PendingMarkdownNavigation {
  id: number;
  path: string;
  fragment: string;
  mode: MarkdownNavigationMode;
}

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

  const reportMarkdownNavigationError = useCallback((key: "invalid" | "outside" | "unsupported" | "missing" | "fragment") => {
    const translationKey = {
      invalid: "files.toast.markdownLinkInvalid",
      outside: "files.toast.markdownLinkOutsideProject",
      unsupported: "files.toast.markdownLinkUnsupported",
      missing: "files.toast.markdownLinkMissing",
      fragment: "files.toast.markdownFragmentMissing",
    } as const;
    toast.error(t(translationKey[key]));
  }, [t]);

  const revealSourceFragment = useCallback((file: ActiveProjectFile, fragment: string) => {
    const lineNumber = findMarkdownHeadingLine(file.content, fragment);
    if (lineNumber === null) {
      reportMarkdownNavigationError("fragment");
      return false;
    }
    const editor = editorRef.current;
    if (!editor) return false;
    editor.setPosition({ lineNumber, column: 1 });
    editor.revealLineInCenter(lineNumber);
    editor.focus();
    return true;
  }, [reportMarkdownNavigationError]);

  const handleMarkdownLinkActivate = useCallback((href: string, mode: MarkdownNavigationMode) => {
    if (!visibleFile) return;
    const target = resolveMarkdownHref(href, visibleFile.path);
    if (target.kind === "invalid") {
      reportMarkdownNavigationError(
        target.reason === "outside-project" ? "outside" : target.reason === "unsupported-scheme" ? "unsupported" : "invalid",
      );
      return;
    }
    if (target.kind === "external") {
      void openUrl(target.href).catch(() => reportMarkdownNavigationError("invalid"));
      return;
    }
    if (target.kind === "document") {
      if (mode === "source") revealSourceFragment(visibleFile, target.fragment);
      else if (findMarkdownHeadingLine(visibleFile.content, target.fragment) === null) {
        reportMarkdownNavigationError("fragment");
      } else {
        const id = ++markdownNavigationIdRef.current;
        setPendingMarkdownNavigation({
          id,
          path: visibleFile.path,
          fragment: target.fragment,
          mode: "preview",
        });
      }
      return;
    }

    const id = ++markdownNavigationIdRef.current;
    nextMarkdownModeRef.current = target.path === visibleFile.path ? null : { path: target.path, mode };
    setPendingMarkdownNavigation({ id, path: target.path, fragment: target.fragment, mode });
    void revealPath(target.path).then((opened) => {
      if (markdownNavigationIdRef.current !== id) return;
      const current = useFileExplorerStore.getState().activeFile;
      if (!opened) {
        nextMarkdownModeRef.current = null;
        setPendingMarkdownNavigation(null);
        reportMarkdownNavigationError("missing");
        return;
      }
      if (current?.path !== target.path) {
        nextMarkdownModeRef.current = null;
        setPendingMarkdownNavigation(null);
      }
    }).catch(() => {
      if (markdownNavigationIdRef.current !== id) return;
      nextMarkdownModeRef.current = null;
      setPendingMarkdownNavigation(null);
      reportMarkdownNavigationError("missing");
    });
  }, [reportMarkdownNavigationError, revealPath, revealSourceFragment, visibleFile]);

  markdownNavigationRef.current = handleMarkdownLinkActivate;

  useEffect(() => {
    if (!pendingMarkdownNavigation || visibleFile?.path !== pendingMarkdownNavigation.path) return;
    if (visibleFile.previewKind !== "markdown") {
      setPendingMarkdownNavigation(null);
      if (pendingMarkdownNavigation.fragment) reportMarkdownNavigationError("fragment");
      return;
    }
    if (previewMode !== pendingMarkdownNavigation.mode) {
      setPreviewMode(pendingMarkdownNavigation.mode);
      return;
    }
    if (pendingMarkdownNavigation.mode !== "source") return;
    if (revealSourceFragment(visibleFile, pendingMarkdownNavigation.fragment)) {
      nextMarkdownModeRef.current = null;
      setPendingMarkdownNavigation(null);
    }
  }, [editorReadyNonce, pendingMarkdownNavigation, previewMode, reportMarkdownNavigationError, revealSourceFragment, visibleFile]);

  const handleMarkdownFragmentHandled = useCallback((id: number, found: boolean) => {
    nextMarkdownModeRef.current = null;
    setPendingMarkdownNavigation((pending) => pending?.id === id ? null : pending);
    if (!found) reportMarkdownNavigationError("fragment");
  }, [reportMarkdownNavigationError]);

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
