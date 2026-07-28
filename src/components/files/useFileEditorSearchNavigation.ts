import type { OnMount } from "@monaco-editor/react";
import { useEffect, type MutableRefObject } from "react";
import type { ActiveProjectFile } from "../../stores/fileExplorerStore";
import { clearEditorDecorations } from "./useGitFileDecorations";

type MonacoEditor = Parameters<OnMount>[0];

interface SearchNavigationTarget {
  path: string;
  lineNumber: number;
  lineText?: string;
  columnNumber?: number;
  source: "search" | "terminal";
}

interface UseFileEditorSearchNavigationOptions {
  editorRef: MutableRefObject<MonacoEditor | null>;
  decorationIdsRef: MutableRefObject<string[]>;
  editorReadyNonce: number;
  file: ActiveProjectFile | null;
  previewMode: "source" | "preview";
  target: SearchNavigationTarget | null;
  searchQuery: string;
  setPreviewMode: (mode: "source" | "preview") => void;
  onHandled: () => void;
}

function findLineTextColumn(line: string, lineText: string): { start: number; end: number } {
  const needle = lineText.trim();
  if (!needle) return { start: 1, end: Math.max(line.length + 1, 1) };
  const index = line.indexOf(needle);
  if (index === -1) return { start: 1, end: Math.max(line.length + 1, 1) };
  return { start: index + 1, end: index + needle.length + 1 };
}

function findSearchColumn(line: string, query: string, fallback: string): { start: number; end: number } {
  const needle = query.trim();
  if (!needle) return findLineTextColumn(line, fallback);
  const index = line.toLowerCase().indexOf(needle.toLowerCase());
  return index === -1
    ? findLineTextColumn(line, fallback)
    : { start: index + 1, end: index + needle.length + 1 };
}

function openFindWidget(editor: MonacoEditor, searchQuery: string): void {
  const query = searchQuery.trim();
  const findWithArgs = editor.getAction("editor.actions.findWithArgs");
  if (!query || !findWithArgs?.isSupported()) {
    void editor.getAction("actions.find")?.run();
    return;
  }
  void findWithArgs.run({
    searchString: query,
    isRegex: false,
    matchWholeWord: false,
    isCaseSensitive: false,
    findInSelection: false,
  }).catch(() => {
    void editor.getAction("actions.find")?.run();
  });
}

export function useFileEditorSearchNavigation({
  editorRef,
  decorationIdsRef,
  editorReadyNonce,
  file,
  previewMode,
  target,
  searchQuery,
  setPreviewMode,
  onHandled,
}: UseFileEditorSearchNavigationOptions): void {
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !file || !target || file.path !== target.path) return;
    if (file.previewKind !== "text" && file.previewKind !== "markdown") return;
    if (file.previewKind === "markdown" && previewMode !== "source") {
      setPreviewMode("source");
      return;
    }

    const model = editor.getModel();
    const lineNumber = Math.min(Math.max(target.lineNumber, 1), model?.getLineCount() ?? 1);
    const line = model?.getLineContent(lineNumber) ?? "";
    const column = target.columnNumber
      ? {
          start: Math.min(Math.max(target.columnNumber, 1), Math.max(line.length + 1, 1)),
          end: Math.min(Math.max(target.columnNumber + 1, 1), Math.max(line.length + 1, 1)),
        }
      : target.source === "search"
        ? findSearchColumn(line, searchQuery, target.lineText ?? "")
        : { start: 1, end: Math.max(line.length + 1, 1) };

    clearEditorDecorations(editor, decorationIdsRef);
    decorationIdsRef.current = editor.deltaDecorations([], [
      {
        range: { startLineNumber: lineNumber, startColumn: 1, endLineNumber: lineNumber, endColumn: Math.max(line.length + 1, 1) },
        options: { isWholeLine: true, className: "ui-file-editor-search-line-highlight" },
      },
      {
        range: { startLineNumber: lineNumber, startColumn: column.start, endLineNumber: lineNumber, endColumn: column.end },
        options: { inlineClassName: "ui-file-editor-search-snippet-highlight" },
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
    if (target.source === "search") openFindWidget(editor, searchQuery);
    onHandled();
  }, [decorationIdsRef, editorReadyNonce, editorRef, file, onHandled, previewMode, searchQuery, setPreviewMode, target]);
}
