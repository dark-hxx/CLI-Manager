import { useVirtualizer } from "@tanstack/react-virtual";
import {
  useCallback,
  useEffect,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type RefObject,
} from "react";
import type { ChangeEventArgs, HunkData } from "react-diff-view";
import type { GitDiffViewMode } from "../../../stores/settingsStore";
import { GitDiffHunkBlock } from "./GitDiffHunkBlock";
import { estimateGitDiffHunkHeight } from "./gitDiffVirtualization";
import type { GitDiffController } from "./types";

interface GitDiffHunkListProps {
  controller: GitDiffController;
  fileName: string;
  scrollElementRef: RefObject<HTMLDivElement | null>;
  viewMode: GitDiffViewMode;
  wrapLines: boolean;
}

const EMPTY_HUNKS: HunkData[] = [];

interface PendingFocus {
  file: NonNullable<GitDiffController["parsed"]>["file"];
  key: string;
}

export function GitDiffHunkList({
  controller,
  fileName,
  scrollElementRef,
  viewMode,
  wrapLines,
}: GitDiffHunkListProps) {
  const hunks = controller.parsed?.file.hunks ?? EMPTY_HUNKS;
  const [pendingFocus, setPendingFocus] = useState<PendingFocus | null>(null);
  const virtualizer = useVirtualizer({
    count: hunks.length,
    getScrollElement: () => scrollElementRef.current,
    estimateSize: (index) => estimateGitDiffHunkHeight(hunks[index], viewMode),
    measureElement: (element) => element.getBoundingClientRect().height,
    overscan: 3,
    getItemKey: (index) => {
      const hunk = hunks[index];
      return hunk ? `${hunk.oldStart}:${hunk.newStart}:${hunk.content}` : index;
    },
  });
  const virtualItems = virtualizer.getVirtualItems();
  const focusChange = useCallback((key: string): boolean => {
    const buttons = scrollElementRef.current?.querySelectorAll<HTMLButtonElement>(
      "[data-git-diff-change-key]",
    );
    const target = [...buttons ?? []].find((button) => button.dataset.gitDiffChangeKey === key);
    target?.focus();
    return Boolean(target);
  }, [scrollElementRef]);
  const handleGutterClick = useCallback((args: ChangeEventArgs, event: MouseEvent<HTMLElement>) => {
    controller.selectChange(args, event.shiftKey);
  }, [controller]);
  const handleGutterKeyDown = useCallback((
    args: ChangeEventArgs,
    event: KeyboardEvent<HTMLElement>,
  ) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      controller.selectChange(args, false);
      return;
    }
    if (!event.shiftKey || !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) {
      return;
    }
    event.preventDefault();
    const direction = event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 1;
    const next = controller.extendSelectionFromKeyboard(args, direction);
    if (!next) return;
    controller.goToHunk(next.hunkIndex);
    if (controller.parsed) {
      setPendingFocus({ file: controller.parsed.file, key: next.key });
    }
    virtualizer.scrollToIndex(next.hunkIndex, { align: "center" });
  }, [controller, virtualizer]);

  useEffect(() => {
    if (hunks.length === 0) return;
    virtualizer.scrollToIndex(controller.activeHunkIndex, { align: "center" });
  }, [controller.activeHunkIndex, hunks, virtualizer]);

  useEffect(() => {
    virtualizer.measure();
  }, [viewMode, virtualizer, wrapLines]);

  useEffect(() => {
    if (!pendingFocus) return;
    if (pendingFocus.file !== controller.parsed?.file) {
      setPendingFocus(null);
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      if (focusChange(pendingFocus.key)) setPendingFocus(null);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [controller.parsed?.file, focusChange, pendingFocus, virtualItems]);

  const parsed = controller.parsed;
  if (!parsed) return null;
  return (
    <div
      className="diff-viewer-container relative min-w-full"
      style={{ height: virtualizer.getTotalSize() }}
    >
      {virtualItems.map((virtualItem) => {
        const hunk = hunks[virtualItem.index];
        if (!hunk) return null;
        return (
          <div
            key={virtualItem.key}
            ref={virtualizer.measureElement}
            data-index={virtualItem.index}
            className="absolute left-0 top-0 w-full"
            style={{ transform: `translateY(${virtualItem.start}px)` }}
          >
            <GitDiffHunkBlock
              controller={controller}
              diffType={parsed.file.type}
              fileName={fileName}
              hunk={hunk}
              hunkIndex={virtualItem.index}
              syntaxHighlight={parsed.syntaxHighlight}
              viewMode={viewMode}
              onGutterClick={handleGutterClick}
              onGutterKeyDown={handleGutterKeyDown}
            />
          </div>
        );
      })}
    </div>
  );
}
