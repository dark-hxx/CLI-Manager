import { openUrl } from "@tauri-apps/plugin-opener";
import { useCallback, useEffect } from "react";
import { toast } from "sonner";
import { useI18n } from "../../../lib/i18n";
import { findMarkdownHeadingLine, resolveMarkdownHref } from "../../../lib/markdownNavigation";
import { useFileExplorerStore, type ActiveProjectFile } from "../../../stores/fileExplorerStore";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { MonacoEditor, MarkdownNavigationMode, PendingMarkdownNavigation } from "../types/fileEditorModel";
interface NavigationOptions {
  t: ReturnType<typeof useI18n>["t"];
  visibleFile: ActiveProjectFile | null;
  revealPath: ReturnType<typeof useFileExplorerStore.getState>["revealPath"];
  editorRef: RefObject<MonacoEditor | null>;
  markdownNavigationRef: RefObject<(href: string, mode: MarkdownNavigationMode) => void>;
  markdownNavigationIdRef: RefObject<number>;
  nextMarkdownModeRef: RefObject<{ path: string; mode: MarkdownNavigationMode } | null>;
  pendingMarkdownNavigation: PendingMarkdownNavigation | null;
  setPendingMarkdownNavigation: Dispatch<SetStateAction<PendingMarkdownNavigation | null>>;
  previewMode: MarkdownNavigationMode;
  setPreviewMode: Dispatch<SetStateAction<MarkdownNavigationMode>>;
  editorReadyNonce: number;
}

export function useFileEditorMarkdownNavigation(options: NavigationOptions) {
  const { t, visibleFile, revealPath, editorRef, markdownNavigationRef, markdownNavigationIdRef, nextMarkdownModeRef, pendingMarkdownNavigation, setPendingMarkdownNavigation, previewMode, setPreviewMode, editorReadyNonce } = options;
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
  return { handleMarkdownLinkActivate, handleMarkdownFragmentHandled };
}
