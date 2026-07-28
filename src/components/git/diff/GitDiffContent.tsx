import { lazy, Suspense, useRef } from "react";
import { useI18n } from "../../../lib/i18n";
import type { GitDiffViewMode } from "../../../stores/settingsStore";
import { TERMINAL_DIFF_TABLE_STYLE } from "./theme";
import type { GitDiffController } from "./types";
import { GitDiffHunkList } from "./GitDiffHunkList";
import { useGitDiffHorizontalScroll } from "./useGitDiffHorizontalScroll";

const MonacoDiffFallback = lazy(() =>
  import("../MonacoDiffFallback").then((module) => ({ default: module.MonacoDiffFallback })),
);

interface GitDiffContentProps {
  controller: GitDiffController;
  fallbackEditorTheme: "vs" | "vs-dark";
  fileName: string;
  useTerminalTheme: boolean;
  viewMode: GitDiffViewMode;
  wrapLines: boolean;
}

export function GitDiffContent({
  controller,
  fallbackEditorTheme,
  fileName,
  useTerminalTheme,
  viewMode,
  wrapLines,
}: GitDiffContentProps) {
  const { t } = useI18n();
  const { diffText, loading, error, parsed } = controller;
  const fallbackContentRef = useRef<HTMLDivElement | null>(null);
  const horizontalScroll = useGitDiffHorizontalScroll({
    enabled: Boolean(parsed && !wrapLines),
    hunks: parsed?.file.hunks ?? [],
    viewMode,
  });
  const contentRef = parsed ? horizontalScroll.contentRef : fallbackContentRef;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden" style={{ backgroundColor: "var(--surface)" }}>
      <div
        ref={contentRef}
        className="git-diff-scroll-container min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-4"
      >
        {loading && (
          <div className="flex h-full items-center justify-center">
            <div className="flex flex-col items-center gap-3">
              <div
                className="h-8 w-8 animate-spin rounded-full border-2"
                style={{ borderColor: "var(--success)", borderTopColor: "transparent" }}
              />
              <p className="text-sm text-text-muted">{t("git.diff.loading")}</p>
            </div>
          </div>
        )}

        {error && (
          <div className="flex h-full items-center justify-center">
            <p className="max-w-md text-center text-sm" style={{ color: "var(--danger)" }}>{error}</p>
          </div>
        )}

        {!loading && !error && diffText && parsed && (
          <div
            style={useTerminalTheme
              ? TERMINAL_DIFF_TABLE_STYLE
              : { backgroundColor: "var(--surface-container-lowest)", borderColor: "var(--border)" }}
          >
            <GitDiffHunkList
              controller={controller}
              fileName={fileName}
              scrollElementRef={horizontalScroll.contentRef}
              viewMode={viewMode}
              wrapLines={wrapLines}
            />
          </div>
        )}

        {!loading && !error && diffText && !parsed && (
          <div
            className="diff-viewer-container h-full min-h-[320px] overflow-hidden"
            style={useTerminalTheme
              ? TERMINAL_DIFF_TABLE_STYLE
              : { backgroundColor: "var(--surface-container-lowest)", borderColor: "var(--border)" }}
          >
            <Suspense fallback={null}>
              <MonacoDiffFallback value={diffText} theme={fallbackEditorTheme} wrapLines={wrapLines} />
            </Suspense>
          </div>
        )}

        {!loading && !error && !diffText && (
          <div className="flex h-full items-center justify-center">
            <p className="text-sm text-text-muted">{t("git.diff.noContent")}</p>
          </div>
        )}
      </div>

      {parsed && !wrapLines && (
        <>
          <span
            ref={horizontalScroll.measureRef}
            aria-hidden="true"
            className="git-diff-horizontal-measure"
          >
            {horizontalScroll.widestLine}
          </span>
          <div
            ref={horizontalScroll.scrollbarRef}
            className="git-diff-horizontal-scrollbar shrink-0 overflow-x-auto overflow-y-hidden"
            data-overflow={horizontalScroll.hasOverflow}
            onScroll={horizontalScroll.handleHorizontalScroll}
          >
            <div aria-hidden="true" style={{ width: horizontalScroll.trackWidth, height: 1 }} />
          </div>
        </>
      )}
    </div>
  );
}
