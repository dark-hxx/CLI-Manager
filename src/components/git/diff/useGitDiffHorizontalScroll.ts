import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { HunkData } from "react-diff-view";
import type { GitDiffViewMode } from "../../../stores/settingsStore";

interface GitDiffHorizontalScrollOptions {
  enabled: boolean;
  hunks: readonly HunkData[];
  viewMode: GitDiffViewMode;
}

const CODE_CELL_SELECTOR = ".diff-code";
const CODE_PADDING_PX = 8;
const TAB_SIZE = 8;

function displayColumns(value: string): number {
  let columns = 0;
  for (const character of value) {
    if (character === "\t") {
      columns += TAB_SIZE - (columns % TAB_SIZE);
    } else {
      columns += (character.codePointAt(0) ?? 0) > 0xff ? 2 : 1;
    }
  }
  return columns;
}

function findWidestLine(hunks: readonly HunkData[]): string {
  let widestLine = " ";
  let widestColumns = 1;
  for (const hunk of hunks) {
    for (const change of hunk.changes) {
      const columns = displayColumns(change.content);
      if (columns > widestColumns) {
        widestColumns = columns;
        widestLine = change.content;
      }
    }
  }
  return widestLine;
}

export function useGitDiffHorizontalScroll({
  enabled,
  hunks,
  viewMode,
}: GitDiffHorizontalScrollOptions) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const scrollbarRef = useRef<HTMLDivElement | null>(null);
  const measureRef = useRef<HTMLSpanElement | null>(null);
  const [trackWidth, setTrackWidth] = useState(0);
  const [hasOverflow, setHasOverflow] = useState(false);
  const widestLine = useMemo(() => findWidestLine(hunks), [hunks]);

  const syncCodeCells = useCallback(() => {
    if (!enabled) return;
    const scrollLeft = scrollbarRef.current?.scrollLeft ?? 0;
    const codeCells = contentRef.current?.querySelectorAll<HTMLElement>(CODE_CELL_SELECTOR);
    for (const codeCell of codeCells ?? []) {
      if (codeCell.scrollLeft !== scrollLeft) codeCell.scrollLeft = scrollLeft;
    }
  }, [enabled]);

  const updateMetrics = useCallback(() => {
    if (!enabled) return;
    const content = contentRef.current;
    const scrollbar = scrollbarRef.current;
    const measure = measureRef.current;
    if (!content || !scrollbar || !measure) return;

    const fallbackCodeWidth = viewMode === "split"
      ? scrollbar.clientWidth / 2
      : scrollbar.clientWidth;
    const codeWidth = content.querySelector<HTMLElement>(CODE_CELL_SELECTOR)?.clientWidth
      ?? fallbackCodeWidth;
    const lineWidth = Math.ceil(measure.scrollWidth + CODE_PADDING_PX);
    const overflowWidth = Math.max(0, lineWidth - codeWidth);
    const nextTrackWidth = Math.ceil(
      scrollbar.clientWidth + overflowWidth,
    );

    content.style.setProperty("--git-diff-code-track-width", `${lineWidth}px`);
    setTrackWidth((current) => current === nextTrackWidth ? current : nextTrackWidth);
    setHasOverflow(overflowWidth > 1);
    syncCodeCells();
  }, [enabled, syncCodeCells, viewMode]);

  useLayoutEffect(() => {
    updateMetrics();
  }, [updateMetrics, widestLine]);

  useEffect(() => {
    const content = contentRef.current;
    const measure = measureRef.current;
    if (!enabled || !content || !measure) return;

    let frame = 0;
    const scheduleUpdate = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(updateMetrics);
    };
    const mutationObserver = new MutationObserver(scheduleUpdate);
    const resizeObserver = new ResizeObserver(scheduleUpdate);
    mutationObserver.observe(content, { childList: true, subtree: true });
    resizeObserver.observe(content);
    resizeObserver.observe(measure);

    return () => {
      window.cancelAnimationFrame(frame);
      mutationObserver.disconnect();
      resizeObserver.disconnect();
      content.style.removeProperty("--git-diff-code-track-width");
    };
  }, [enabled, updateMetrics]);

  useEffect(() => {
    const content = contentRef.current;
    const scrollbar = scrollbarRef.current;
    if (!enabled || !content || !scrollbar) return;

    const handleWheel = (event: WheelEvent) => {
      const delta = event.shiftKey
        ? event.deltaY
        : Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : 0;
      if (delta === 0) return;
      const previous = scrollbar.scrollLeft;
      scrollbar.scrollLeft += delta;
      if (scrollbar.scrollLeft !== previous) event.preventDefault();
    };
    content.addEventListener("wheel", handleWheel, { passive: false });
    return () => content.removeEventListener("wheel", handleWheel);
  }, [enabled]);

  return {
    contentRef,
    handleHorizontalScroll: syncCodeCells,
    hasOverflow,
    measureRef,
    scrollbarRef,
    trackWidth,
    widestLine,
  };
}
