import Editor, { type OnMount } from "@monaco-editor/react";
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { eventToCombo } from "../../hooks/useKeyboardShortcuts";
import { copyAiText } from "../../lib/aiClipboard";
import { formatAiAnchor, formatAiContextBlock, formatAiPathAnchorBlock, type AiTextSelection } from "../../lib/aiPathFormatter";
import { sendTextToTerminal } from "../../lib/terminalFileDrag";
import { toast } from "sonner";
import { debugConsoleWarn } from "../../lib/debugConsole";
import { useI18n } from "../../lib/i18n";
import type { GitFileChange, TerminalSession } from "../../lib/types";
import { configureMonaco, languageFromPath } from "../../lib/monacoSetup";
import { useSettingsStore } from "../../stores/settingsStore";
import { useFileExplorerStore } from "../../stores/fileExplorerStore";
import { MarkdownContent } from "../ui/MarkdownContent";
import { Button } from "../ui/button";
import { ConfirmDialog } from "../ConfirmDialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "../ui/dialog";
import { Copy, FileCode, Image, Save, X } from "../icons";
import { GitDiffViewer } from "../git/DiffViewerModal";
import { STATUS_CONFIG } from "../git/GitStatusIcon";

configureMonaco();

interface FileEditorPaneProps {
  session: TerminalSession;
  isActive: boolean;
  terminalThemeBackground: string;
  onClose: () => void;
}

type PendingAction =
  | { kind: "close-pane" }
  | { kind: "close-file"; path: string }
  | null;

type MonacoEditor = Parameters<OnMount>[0];
type GitLineChangeKind = "added" | "modified" | "deleted";

interface GitLineMarker {
  lineNumber: number;
  kind: GitLineChangeKind;
}

function clearSearchDecorations(editor: MonacoEditor, decorationIdsRef: MutableRefObject<string[]>): void {
  if (decorationIdsRef.current.length === 0) return;
  decorationIdsRef.current = editor.deltaDecorations(decorationIdsRef.current, []);
}

function findLineTextColumn(line: string, lineText: string): { start: number; end: number } {
  const needle = lineText.trim();
  if (!needle) return { start: 1, end: Math.max(line.length + 1, 1) };
  const index = line.indexOf(needle);
  if (index === -1) return { start: 1, end: Math.max(line.length + 1, 1) };
  return { start: index + 1, end: index + needle.length + 1 };
}

function findSearchColumn(line: string, searchQuery: string, fallbackLineText: string): { start: number; end: number } {
  const needle = searchQuery.trim();
  if (!needle) return findLineTextColumn(line, fallbackLineText);
  const index = line.toLowerCase().indexOf(needle.toLowerCase());
  if (index === -1) return findLineTextColumn(line, fallbackLineText);
  return { start: index + 1, end: index + needle.length + 1 };
}

function openFindWidget(editor: MonacoEditor, searchQuery: string): void {
  const query = searchQuery.trim();
  const findWithArgs = editor.getAction("editor.actions.findWithArgs");
  if (query && findWithArgs?.isSupported()) {
    void findWithArgs.run({
      searchString: query,
      isRegex: false,
      matchWholeWord: false,
      isCaseSensitive: false,
      findInSelection: false,
    }).catch(() => {
      void editor.getAction("actions.find")?.run();
    });
    return;
  }
  void editor.getAction("actions.find")?.run();
}

function clampLine(lineNumber: number, maxLine: number): number {
  if (maxLine <= 0) return 1;
  return Math.min(Math.max(lineNumber, 1), maxLine);
}

function parseGitDiffLineMarkers(diffText: string, maxLine: number): GitLineMarker[] {
  const markers = new Map<number, GitLineChangeKind>();
  const pendingDeletes: number[] = [];
  let newLine = 0;

  const priority: Record<GitLineChangeKind, number> = { deleted: 1, added: 2, modified: 3 };
  const setMarker = (lineNumber: number, kind: GitLineChangeKind) => {
    const line = clampLine(lineNumber, maxLine);
    const current = markers.get(line);
    if (!current || priority[kind] > priority[current]) markers.set(line, kind);
  };
  const flushDeletes = () => {
    for (const line of pendingDeletes.splice(0)) {
      setMarker(line, "deleted");
    }
  };

  for (const line of diffText.split(/\r?\n/)) {
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      flushDeletes();
      newLine = Number.parseInt(hunk[1], 10);
      continue;
    }
    if (newLine === 0 || line.startsWith("---") || line.startsWith("+++")) continue;

    if (line.startsWith("-")) {
      pendingDeletes.push(Math.max(newLine, 1));
      continue;
    }
    if (line.startsWith("+")) {
      setMarker(newLine, pendingDeletes.length > 0 ? "modified" : "added");
      if (pendingDeletes.length > 0) pendingDeletes.shift();
      newLine += 1;
      continue;
    }

    flushDeletes();
    if (line.startsWith(" ")) newLine += 1;
  }

  flushDeletes();
  return Array.from(markers.entries()).map(([lineNumber, kind]) => ({ lineNumber, kind }));
}

function gitLineDecorationColor(kind: GitLineChangeKind): string {
  if (kind === "added") return STATUS_CONFIG.A.color;
  if (kind === "deleted") return STATUS_CONFIG.D.color;
  return STATUS_CONFIG.M.color;
}

function makeGitLineDecorations(markers: GitLineMarker[]) {
  return markers.map((marker) => ({
    range: {
      startLineNumber: marker.lineNumber,
      startColumn: 1,
      endLineNumber: marker.lineNumber,
      endColumn: 1,
    },
    options: {
      linesDecorationsClassName: `ui-file-editor-git-line-${marker.kind}`,
      overviewRuler: {
        color: gitLineDecorationColor(marker.kind),
        position: 4,
      },
    },
  }));
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
  const { t } = useI18n();
  const editorRef = useRef<MonacoEditor | null>(null);
  const searchDecorationIdsRef = useRef<string[]>([]);
  const gitDecorationIdsRef = useRef<string[]>([]);
  const [editorReadyNonce, setEditorReadyNonce] = useState(0);
  const copyAiShortcut = useSettingsStore((s) => s.keyboardShortcuts.copyAi);
  const project = useFileExplorerStore((s) => s.project);
  const openProject = useFileExplorerStore((s) => s.openProject);
  const openFiles = useFileExplorerStore((s) => s.openFiles);
  const openDiffs = useFileExplorerStore((s) => s.openDiffs);
  const activeFilePath = useFileExplorerStore((s) => s.activeFilePath);
  const activeFile = useFileExplorerStore((s) => s.activeFile);
  const activeDiff = useFileExplorerStore((s) => s.activeDiff);
  const searchQuery = useFileExplorerStore((s) => s.searchQuery);
  const gitChanges = useFileExplorerStore((s) => s.gitChanges);
  const searchNavigationTarget = useFileExplorerStore((s) => s.searchNavigationTarget);
  const setActiveFilePath = useFileExplorerStore((s) => s.setActiveFilePath);
  const setActiveDiffPath = useFileExplorerStore((s) => s.setActiveDiffPath);
  const clearSearchNavigationTarget = useFileExplorerStore((s) => s.clearSearchNavigationTarget);
  const closeFile = useFileExplorerStore((s) => s.closeFile);
  const closeDiff = useFileExplorerStore((s) => s.closeDiff);
  const refreshVisibleState = useFileExplorerStore((s) => s.refreshVisibleState);
  const setActiveContent = useFileExplorerStore((s) => s.setActiveContent);
  const saveFile = useFileExplorerStore((s) => s.saveFile);
  const saveActiveFile = useFileExplorerStore((s) => s.saveActiveFile);
  const [previewMode, setPreviewMode] = useState<"source" | "preview">("source");
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [discardDiffTarget, setDiscardDiffTarget] = useState<{ path: string; name: string; status: string } | null>(null);
  const ownsFileState = Boolean(project?.id && session.fileEditor?.projectId && project.id === session.fileEditor.projectId);
  const visibleFiles = ownsFileState ? openFiles : [];
  const visibleDiffs = ownsFileState ? openDiffs : [];
  const visibleFile = ownsFileState ? activeFile : null;
  const visibleDiff = ownsFileState ? activeDiff : null;
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
    // 右键按下瞬间（选区还没被清）快照当前选区，供“发送到终端”使用。
    editor.onMouseDown((event) => {
      if (event.event.rightButton) {
        const sel = editor.getSelection();
        rightClickSelectionRef.current = sel && !sel.isEmpty()
          ? {
              startLine: sel.startLineNumber,
              endLine: sel.endLineNumber,
              text: editor.getModel()?.getValueInRange(sel),
            }
          : null;
      }
    });
    editor.addAction({
      id: "cli-manager.sendToTerminal",
      label: t("files.editor.sendToTerminal"),
      contextMenuGroupId: "9_cutcopypaste",
      contextMenuOrder: 3,
      run: () => sendSelectionToTerminalRef.current(),
    });
    setEditorReadyNonce((value) => value + 1);
  }, [t]);

  useEffect(() => {
    const fileProject = session.fileEditor?.project;
    if (!isActive || !project || !fileProject || project.id === fileProject.id) return;
    void openProject(fileProject);
  }, [isActive, openProject, project?.id, session.fileEditor?.project]);

  useEffect(() => {
    setPreviewMode("source");
  }, [visibleFile?.path]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    clearSearchDecorations(editor, searchDecorationIdsRef);
    clearSearchDecorations(editor, gitDecorationIdsRef);
  }, [visibleFile?.path]);

  useEffect(() => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) return;

    clearSearchDecorations(editor, gitDecorationIdsRef);
    if (!project || !visibleFile || !activeGitChange) return;
    if (visibleFile.previewKind !== "text" && visibleFile.previewKind !== "markdown") return;
    if (visibleFile.previewKind === "markdown" && previewMode !== "source") return;

    let cancelled = false;
    void invoke<string>("git_get_file_diff", {
      projectPath: project.path,
      filePath: visibleFile.path,
      status: activeGitChange.status,
    })
      .then((diffText) => {
        if (cancelled || editorRef.current !== editor) return;
        const currentModel = editor.getModel();
        if (!currentModel) return;
        const markers = parseGitDiffLineMarkers(diffText, currentModel.getLineCount());
        gitDecorationIdsRef.current = editor.deltaDecorations(
          gitDecorationIdsRef.current,
          makeGitLineDecorations(markers)
        );
      })
      .catch((err) => {
        if (!cancelled) debugConsoleWarn("[FileEditorPane] Failed to load git diff markers:", err);
      });

    return () => {
      cancelled = true;
      if (editorRef.current === editor) clearSearchDecorations(editor, gitDecorationIdsRef);
    };
  }, [
    activeGitChange?.path,
    activeGitChange?.status,
    editorReadyNonce,
    previewMode,
    project?.path,
    visibleFile?.modifiedMs,
    visibleFile?.path,
    visibleFile?.previewKind,
    visibleFile?.sizeBytes,
  ]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !visibleFile || !searchNavigationTarget) return;
    if (visibleFile.path !== searchNavigationTarget.path) return;
    if (visibleFile.previewKind !== "text" && visibleFile.previewKind !== "markdown") return;
    if (visibleFile.previewKind === "markdown" && previewMode !== "source") {
      setPreviewMode("source");
      return;
    }

    const model = editor.getModel();
    const lineNumber = Math.min(Math.max(searchNavigationTarget.lineNumber, 1), model?.getLineCount() ?? 1);
    const line = model?.getLineContent(lineNumber) ?? "";
    const column = findSearchColumn(line, searchQuery, searchNavigationTarget.lineText);

    clearSearchDecorations(editor, searchDecorationIdsRef);
    searchDecorationIdsRef.current = editor.deltaDecorations([], [
      {
        range: {
          startLineNumber: lineNumber,
          startColumn: 1,
          endLineNumber: lineNumber,
          endColumn: Math.max(line.length + 1, 1),
        },
        options: {
          isWholeLine: true,
          className: "ui-file-editor-search-line-highlight",
        },
      },
      {
        range: {
          startLineNumber: lineNumber,
          startColumn: column.start,
          endLineNumber: lineNumber,
          endColumn: column.end,
        },
        options: {
          inlineClassName: "ui-file-editor-search-snippet-highlight",
        },
      },
    ]);
    editor.setSelection({
      startLineNumber: lineNumber,
      startColumn: column.start,
      endLineNumber: lineNumber,
      endColumn: column.end,
    });
    editor.revealLineInCenter(lineNumber);
    editor.focus();
    openFindWidget(editor, searchQuery);
    clearSearchNavigationTarget();
  }, [clearSearchNavigationTarget, editorReadyNonce, previewMode, searchNavigationTarget, searchQuery, visibleFile]);

  const save = useCallback(async () => {
    if (!visibleFile || visibleFile.previewKind === "image") return;
    await saveActiveFile();
  }, [saveActiveFile, visibleFile]);

  // 右键点到选区外时 Monaco 会把光标移过去、清空选区，导致读不到原选区行号。
  // 这里在右键 mousedown（选区尚在）时快照，供“发送到终端”优先使用。
  const rightClickSelectionRef = useRef<AiTextSelection | null>(null);

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

  // 把当前选中（或整文件引用）以 @path L2-L5 形式发送到当前终端，供 AI CLI 使用。
  const sendSelectionToTerminal = useCallback(() => {
    if (!project || !visibleFile) return;
    const isSourceMode = (visibleFile.previewKind === "text" || visibleFile.previewKind === "markdown") && previewMode === "source";
    // 右键触发时优先用右键按下瞬间的选区快照（否则光标可能已移出选区、丢了行号）。
    const selection = isSourceMode
      ? (rightClickSelectionRef.current ?? getEditorSelection())
      : null;
    rightClickSelectionRef.current = null;
    // 只发送 @路径 + 行号（不含选中的代码文本），末尾补空格，
    // 使终端能把整段渲染成文件 chip、且多次发送不粘连。
    const text = `${formatAiPathAnchorBlock(visibleFile.path, selection)} `;
    const ok = sendTextToTerminal(text);
    if (ok) {
      toast.success(t("files.editor.sendToTerminalDone"));
    } else {
      toast.error(t("files.editor.sendNoTerminal"));
    }
  }, [getEditorSelection, previewMode, project, t, visibleFile]);

  // Monaco action 在 mount 时注册一次，用 ref 保证 run 时调用最新闭包。
  const sendSelectionToTerminalRef = useRef(sendSelectionToTerminal);
  useEffect(() => {
    sendSelectionToTerminalRef.current = sendSelectionToTerminal;
  }, [sendSelectionToTerminal]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!isActive || !copyAiShortcut.trim()) return;
      const target = event.target as HTMLElement | null;
      if (!target?.closest(".ui-file-editor-pane")) return;
      if (eventToCombo(event) !== copyAiShortcut) return;
      event.preventDefault();
      event.stopPropagation();
      copyActiveAiPath();
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [copyActiveAiPath, copyAiShortcut, isActive]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!isActive) return;
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "s") return;
      event.preventDefault();
      void save();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isActive, save]);

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

  const requestDiscardDiffFile = (path: string, name: string, status: string) => {
    setDiscardDiffTarget({ path, name, status });
  };

  const discardDiffFile = async () => {
    if (!project || !discardDiffTarget) return;
    const target = discardDiffTarget;
    setDiscardDiffTarget(null);
    await invoke("git_discard_file", {
      projectPath: project.path,
      filePath: target.path,
      status: target.status,
    });
    closeDiff(target.path);
    await refreshVisibleState();
  };

  return (
    <div className="ui-file-editor-pane flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      <div className="ui-file-editor-header flex h-10 shrink-0 items-center gap-2 border-b border-border bg-surface-container-low px-3">
        <FileCode size={15} strokeWidth={1.8} className="text-on-surface-variant" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-semibold text-on-surface">
            {visibleFile ? visibleFile.name : session.fileEditor?.projectName ?? project?.name ?? t("files.editor.titleFallback")}
            {dirty ? " *" : ""}
          </div>
          <div className="truncate text-[10px] text-text-muted">
            {visibleFile?.path ?? session.fileEditor?.projectPath ?? project?.path ?? t("files.editor.noFile")}
          </div>
        </div>
        {visibleFile?.previewKind === "markdown" && (
          <div className="ui-file-editor-segment flex rounded-md border border-border bg-surface-container-lowest p-0.5">
            <button
              type="button"
              className="rounded px-2 py-1 text-[11px]"
              data-active={previewMode === "source" ? "true" : "false"}
              onClick={() => setPreviewMode("source")}
            >
              {t("files.editor.source")}
            </button>
            <button
              type="button"
              className="rounded px-2 py-1 text-[11px]"
              data-active={previewMode === "preview" ? "true" : "false"}
              onClick={() => setPreviewMode("preview")}
            >
              {t("files.editor.preview")}
            </button>
          </div>
        )}
        <Button size="sm" variant="outline" disabled={!visibleFile} onClick={copyActiveAiPath}>
          <Copy size={13} />
          {t("files.editor.aiPath")}
        </Button>
        <Button size="sm" variant="outline" disabled={!visibleFile} onClick={copyActiveAiContext}>
          <Copy size={13} />
          {t("files.editor.aiContext")}
        </Button>
        <Button size="sm" variant="outline" disabled={!dirty} onClick={() => void save()}>
          <Save size={13} />
          {t("common.save")}
        </Button>
        <button type="button" className="ui-icon-action" title={t("files.editor.close")} aria-label={t("files.editor.close")} onClick={requestClose}>
          <X size={15} />
        </button>
      </div>

      {(visibleFiles.length > 0 || visibleDiffs.length > 0) && (
        <div className="ui-file-editor-tabs flex h-8 shrink-0 items-center overflow-x-auto border-b border-border bg-surface-container-lowest px-1">
          {visibleFiles.map((file) => {
            const isActiveFile = !visibleDiff && file.path === activeFilePath;
            const isDirty = file.content !== file.savedContent;
            return (
              <div
                key={file.path}
                className="ui-file-editor-tab group flex h-7 max-w-[180px] shrink-0 items-center rounded-t text-[11px] text-on-surface-variant hover:bg-surface-container-high"
                data-active={isActiveFile ? "true" : "false"}
                style={isActiveFile ? { background: "var(--surface-container)", color: "var(--on-surface)" } : undefined}
                title={file.path}
              >
                <button
                  type="button"
                  className="min-w-0 flex-1 truncate px-2 text-left"
                  onClick={() => setActiveFilePath(file.path)}
                >
                  {file.name}{isDirty ? " *" : ""}
                </button>
                <button
                  type="button"
                  className="mr-1 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded opacity-70 hover:bg-surface-container-highest hover:opacity-100"
                  aria-label={t("files.editor.closeNamed", { name: file.name })}
                  onClick={(event) => {
                    event.stopPropagation();
                    requestCloseFile(file.path);
                  }}
                >
                  <X size={11} />
                </button>
              </div>
            );
          })}
          {visibleDiffs.map((diff) => {
            const isActiveDiff = visibleDiff?.path === diff.path;
            return (
              <div
                key={`diff:${diff.path}`}
                className="ui-file-editor-tab group flex h-7 max-w-[220px] shrink-0 items-center rounded-t text-[11px] text-on-surface-variant hover:bg-surface-container-high"
                data-active={isActiveDiff ? "true" : "false"}
                style={isActiveDiff ? { background: "var(--surface-container)", color: "var(--on-surface)" } : undefined}
                title={diff.path}
              >
                <button
                  type="button"
                  className="min-w-0 flex-1 truncate px-2 text-left"
                  onClick={() => setActiveDiffPath(diff.path)}
                >
                  Diff: {diff.name}
                </button>
                <button
                  type="button"
                  className="mr-1 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded opacity-70 hover:bg-surface-container-highest hover:opacity-100"
                  aria-label={t("files.editor.closeNamed", { name: `Diff: ${diff.name}` })}
                  onClick={(event) => {
                    event.stopPropagation();
                    closeDiff(diff.path);
                  }}
                >
                  <X size={11} />
                </button>
              </div>
            );
          })}
        </div>
      )}

      <div className="ui-file-editor-body min-h-0 flex-1 overflow-hidden bg-surface">
        {!visibleFile && !visibleDiff && (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-text-muted">
            <FileCode size={36} strokeWidth={1.2} />
            <div className="text-sm">{t("files.editor.selectFromTree")}</div>
          </div>
        )}
        {visibleDiff && project && (
          <GitDiffViewer
            projectPath={project.path}
            filePath={visibleDiff.path}
            fileName={visibleDiff.name}
            status={visibleDiff.status}
            onRequestDiscard={requestDiscardDiffFile}
            onReverted={() => void refreshVisibleState()}
            useTerminalTheme
          />
        )}
        {!visibleDiff && visibleFile?.previewKind === "unsupported" && (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-text-muted">
            <FileCode size={36} strokeWidth={1.2} />
            <div className="text-sm">{t("files.editor.unsupported")}</div>
          </div>
        )}
        {!visibleDiff && visibleFile?.previewKind === "image" && visibleFile.image && (
          <div className="ui-file-editor-image-preview flex h-full items-center justify-center overflow-auto bg-surface-container-lowest p-4">
            <div className="flex max-h-full max-w-full flex-col items-center gap-3">
              <img
                src={`data:${visibleFile.image.mimeType};base64,${visibleFile.image.dataBase64}`}
                alt={visibleFile.name}
                className="max-h-[calc(100vh-180px)] max-w-full rounded border border-border object-contain"
              />
              <div className="flex items-center gap-2 text-xs text-text-muted">
                <Image size={13} />
                {(visibleFile.image.sizeBytes / 1024).toFixed(1)} KB
              </div>
            </div>
          </div>
        )}
        {!visibleDiff && visibleFile && (visibleFile.previewKind === "text" || visibleFile.previewKind === "markdown") && (
          visibleFile.previewKind === "markdown" && previewMode === "preview" ? (
            <div className="ui-file-editor-markdown-preview h-full overflow-auto p-4">
              <MarkdownContent content={visibleFile.content} variant="terminal" linkBehavior="preview" />
            </div>
          ) : (
            <Editor
              path={visibleFile.path}
              value={visibleFile.content}
              language={language}
              theme={editorTheme}
              onMount={handleEditorMount}
              onChange={(value) => setActiveContent(value ?? "")}
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
      <ConfirmDialog
        open={!!discardDiffTarget}
        title={t("git.confirm.revertTitle")}
        message={discardDiffTarget ? t("git.confirm.revertMessage", { name: discardDiffTarget.name }) : undefined}
        confirmText={t("git.confirm.revert")}
        cancelText={t("common.cancel")}
        danger
        onConfirm={() => void discardDiffFile()}
        onClose={() => setDiscardDiffTarget(null)}
      />
    </div>
  );
}
