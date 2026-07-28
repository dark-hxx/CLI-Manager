import type { OnMount } from "@monaco-editor/react";
import { useEffect, type MutableRefObject } from "react";
import { useGitTransportLease } from "../../hooks/useGitTransportLease";
import { debugConsoleWarn } from "../../lib/debugConsole";
import type { GitFileChange, Project, ProjectFilePreviewKind } from "../../lib/types";
import { STATUS_CONFIG } from "../git/GitStatusIcon";

type MonacoEditor = Parameters<OnMount>[0];
type GitLineChangeKind = "added" | "modified" | "deleted";

interface GitLineMarker {
  lineNumber: number;
  kind: GitLineChangeKind;
}

interface UseGitFileDecorationsOptions {
  editorRef: MutableRefObject<MonacoEditor | null>;
  decorationIdsRef: MutableRefObject<string[]>;
  editorReadyNonce: number;
  project: Project | null;
  change: GitFileChange | null;
  filePath: string | null;
  previewKind: ProjectFilePreviewKind | null;
  previewMode: "source" | "preview";
  modifiedMs?: number | null;
  sizeBytes?: number;
}

export function clearEditorDecorations(
  editor: MonacoEditor,
  decorationIdsRef: MutableRefObject<string[]>,
): void {
  if (decorationIdsRef.current.length === 0) return;
  decorationIdsRef.current = editor.deltaDecorations(decorationIdsRef.current, []);
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
    for (const line of pendingDeletes.splice(0)) setMarker(line, "deleted");
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

function decorationColor(kind: GitLineChangeKind): string {
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
      overviewRuler: { color: decorationColor(marker.kind), position: 4 },
    },
  }));
}

export function useGitFileDecorations({
  editorRef,
  decorationIdsRef,
  editorReadyNonce,
  project,
  change,
  filePath,
  previewKind,
  previewMode,
  modifiedMs,
  sizeBytes,
}: UseGitFileDecorationsOptions): void {
  const enabled = Boolean(
    project
    && change
    && filePath
    && (previewKind === "text" || previewKind === "markdown")
    && (previewKind !== "markdown" || previewMode === "source"),
  );
  const { lease } = useGitTransportLease(project, enabled);

  useEffect(() => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    clearEditorDecorationsIfPresent(editor, decorationIdsRef);
    if (!editor || !model || !project || !change || !filePath || !lease || !enabled) return;

    let cancelled = false;
    const repositoryId = project.environment_type === "ssh" ? "" : project.path;
    void lease.transport.getFileDiff(repositoryId, filePath, change.status)
      .then(({ value }) => {
        if (cancelled || editorRef.current !== editor) return;
        const currentModel = editor.getModel();
        if (!currentModel) return;
        decorationIdsRef.current = editor.deltaDecorations(
          decorationIdsRef.current,
          makeGitLineDecorations(parseGitDiffLineMarkers(value.content, currentModel.getLineCount())),
        );
      })
      .catch((error) => {
        if (!cancelled) debugConsoleWarn("[FileEditorPane] Failed to load Git line markers:", error);
      });

    return () => {
      cancelled = true;
      if (editorRef.current === editor) clearEditorDecorations(editor, decorationIdsRef);
    };
  }, [
    change?.path,
    change?.status,
    decorationIdsRef,
    editorReadyNonce,
    editorRef,
    enabled,
    filePath,
    lease,
    modifiedMs,
    project,
    sizeBytes,
  ]);
}

function clearEditorDecorationsIfPresent(
  editor: MonacoEditor | null | undefined,
  decorationIdsRef: MutableRefObject<string[]>,
): void {
  if (editor) clearEditorDecorations(editor, decorationIdsRef);
}
