import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { getTerminalSidePanelSkinStyle, TERM_PANEL } from "../stats/termStatsUi";
import { readLegacyTerminalPanelWidth } from "../../lib/terminalPanelStorage";
import {
  TERMINAL_PANEL_WIDTH_MAX,
  useSettingsStore,
  type TerminalPanelWidthKey,
} from "../../stores/settingsStore";
import type { WorkspaceDockSide } from "../../lib/workspaceLayout";

interface ResizableTerminalPanelFrameProps {
  widthKey: TerminalPanelWidthKey;
  defaultWidth: number;
  dockSide: WorkspaceDockSide;
  minWidth?: number;
  maxWidth?: number;
  resizeLabel: string;
  resizeTitle?: string;
  children: ReactNode;
}

function clampWidth(width: number, minWidth: number, maxWidth: number): number {
  return Math.min(maxWidth, Math.max(minWidth, Math.round(width)));
}

export function ResizableTerminalPanelFrame({
  widthKey,
  defaultWidth,
  dockSide,
  minWidth = defaultWidth,
  maxWidth = TERMINAL_PANEL_WIDTH_MAX,
  resizeLabel,
  resizeTitle = resizeLabel,
  children,
}: ResizableTerminalPanelFrameProps) {
  const terminalSidePanelSkin = useSettingsStore((s) => s.terminalSidePanelSkin);
  const persistedWidth = useSettingsStore((s) => s.terminalPanelWidths[widthKey]);
  const updateSettings = useSettingsStore((s) => s.update);
  const [width, setWidth] = useState(() => clampWidth(persistedWidth ?? defaultWidth, minWidth, maxWidth));
  const [dragging, setDragging] = useState(false);
  const widthRef = useRef(width);
  const panelRef = useRef<HTMLElement | null>(null);
  const dragStartXRef = useRef(0);
  const dragStartWidthRef = useRef(defaultWidth);
  const pendingWidthRef = useRef<number | null>(null);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    widthRef.current = width;
  }, [width]);

  useEffect(() => {
    if (!dragging && persistedWidth !== widthRef.current) {
      setWidth(clampWidth(persistedWidth, minWidth, maxWidth));
    }
  }, [dragging, maxWidth, minWidth, persistedWidth]);

  useEffect(() => {
    if (persistedWidth !== defaultWidth) return;
    const legacyWidth = readLegacyTerminalPanelWidth(widthKey, defaultWidth, minWidth, maxWidth);
    if (legacyWidth === null || legacyWidth === persistedWidth) return;
    setWidth(legacyWidth);
    const current = useSettingsStore.getState().terminalPanelWidths;
    void updateSettings("terminalPanelWidths", { ...current, [widthKey]: legacyWidth });
  }, [defaultWidth, maxWidth, minWidth, persistedWidth, updateSettings, widthKey]);

  useEffect(() => {
    if (panelRef.current) panelRef.current.style.width = `${width}px`;
  }, [width]);

  useEffect(() => {
    if (!dragging) return;

    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const commitPendingWidth = () => {
      if (pendingWidthRef.current === null) return;
      widthRef.current = pendingWidthRef.current;
      if (panelRef.current) panelRef.current.style.width = `${pendingWidthRef.current}px`;
      frameRef.current = null;
    };

    const handleMouseMove = (event: globalThis.MouseEvent) => {
      const pointerDelta = dockSide === "left"
        ? event.clientX - dragStartXRef.current
        : dragStartXRef.current - event.clientX;
      const rawWidth = dragStartWidthRef.current + pointerDelta;
      const nextWidth = clampWidth(rawWidth, minWidth, maxWidth);
      pendingWidthRef.current = nextWidth;
      // Rebase at an edge so reversing by one pixel immediately leaves the
      // clamp boundary instead of waiting for the pointer to cross old input.
      if (rawWidth !== nextWidth) {
        dragStartWidthRef.current = nextWidth;
        dragStartXRef.current = event.clientX;
      }
      if (frameRef.current === null) frameRef.current = window.requestAnimationFrame(commitPendingWidth);
    };

    const handleMouseUp = () => {
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      const finalWidth = clampWidth(pendingWidthRef.current ?? widthRef.current, minWidth, maxWidth);
      pendingWidthRef.current = null;
      widthRef.current = finalWidth;
      if (panelRef.current) panelRef.current.style.width = `${finalWidth}px`;
      setWidth(finalWidth);
      const current = useSettingsStore.getState().terminalPanelWidths;
      void updateSettings("terminalPanelWidths", { ...current, [widthKey]: finalWidth });
      setDragging(false);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
    };
  }, [dockSide, dragging, maxWidth, minWidth, updateSettings, widthKey]);

  const handleResizeMouseDown = useCallback((event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    dragStartXRef.current = event.clientX;
    const renderedWidth = panelRef.current?.getBoundingClientRect().width ?? widthRef.current;
    const initialWidth = clampWidth(renderedWidth, minWidth, maxWidth);
    dragStartWidthRef.current = initialWidth;
    pendingWidthRef.current = initialWidth;
    widthRef.current = initialWidth;
    setDragging(true);
  }, [maxWidth, minWidth]);

  const dockedOnLeft = dockSide === "left";
  return (
    <aside
      ref={panelRef}
      className={`ui-terminal-side-panel-frame relative flex shrink-0 flex-col overflow-hidden border-border font-mono ${dockedOnLeft ? "border-r" : "border-l"}`}
      data-dock-side={dockSide}
      data-dragging={dragging ? "true" : undefined}
      style={{
        // Keep the live imperative width in React's render path while other
        // terminal content updates frequently during a drag.
        width: dragging ? (pendingWidthRef.current ?? widthRef.current) : width,
        minWidth,
        maxWidth,
        ...getTerminalSidePanelSkinStyle(terminalSidePanelSkin),
        backgroundColor: TERM_PANEL.bg,
        borderColor: TERM_PANEL.border,
      }}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={resizeLabel}
        title={resizeTitle}
        className={`absolute top-0 z-20 h-full w-2 cursor-col-resize transition-colors ${
          dockedOnLeft ? "right-0 translate-x-1/2" : "left-0 -translate-x-1/2"
        } ${dragging ? "bg-primary/35" : "hover:bg-primary/25"}`}
        onMouseDown={handleResizeMouseDown}
      />
      {children}
    </aside>
  );
}
