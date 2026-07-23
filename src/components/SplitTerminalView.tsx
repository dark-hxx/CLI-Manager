import { useCallback, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import { useTerminalStore } from "../stores/terminalStore";
import { clampSplitRatio, type TerminalPaneLeaf, type TerminalPaneNode, type TerminalPaneSplit } from "../stores/terminalPaneTree";
import {
  alignTerminalSplitRootRect,
  buildTerminalSplitLayout,
  observeTerminalSplitPixelRatio,
  type TerminalSplitDragPreview,
  type TerminalSplitLayout,
  type TerminalSplitPixelGrid,
  type TerminalSplitRect,
} from "../terminal/browser/TerminalSplitLayout";

interface Props {
  /** Stable source tree whose leaves stay mounted for the whole terminal session. */
  node: TerminalPaneNode;
  /** Optional presentation tree used to collapse leaves hidden by terminal scope. */
  visibleNode?: TerminalPaneNode | null;
  renderLeaf: (leaf: TerminalPaneLeaf) => ReactNode;
  fullscreenLeafId?: string | null;
}

interface SplitLayoutMetrics {
  rect: TerminalSplitRect;
  pixelGrid: TerminalSplitPixelGrid;
}

interface LiveDragLayout {
  layout: TerminalSplitLayout;
  visibleLayout: TerminalSplitLayout;
}

function rectStyle(rect: TerminalSplitRect): CSSProperties {
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
  };
}

function applyRectStyle(element: HTMLDivElement | undefined, rect: TerminalSplitRect): void {
  if (!element) return;
  element.style.left = `${rect.left}px`;
  element.style.top = `${rect.top}px`;
  element.style.width = `${rect.width}px`;
  element.style.height = `${rect.height}px`;
}

export function SplitTerminalView({ node, visibleNode = node, renderLeaf, fullscreenLeafId }: Props) {
  const setSplitRatio = useTerminalStore((s) => s.setSplitRatio);
  const containerRef = useRef<HTMLDivElement>(null);
  const [layoutMetrics, setLayoutMetrics] = useState<SplitLayoutMetrics>({
    rect: { left: 0, top: 0, width: 0, height: 0 },
    pixelGrid: { originLeft: 0, originTop: 0, devicePixelRatio: 1 },
  });
  const [draggingSplitId, setDraggingSplitId] = useState<string | null>(null);
  const leafElementsRef = useRef(new Map<string, HTMLDivElement>());
  const dividerElementsRef = useRef(new Map<string, HTMLDivElement>());
  const liveDragLayoutRef = useRef<LiveDragLayout | null>(null);
  const activeDragCleanupRef = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const updateLayoutMetrics = () => {
      const bounds = container.getBoundingClientRect();
      const devicePixelRatio = Math.max(1, window.devicePixelRatio || 1);
      const rect = alignTerminalSplitRootRect(bounds, devicePixelRatio);
      const pixelGrid = {
        originLeft: bounds.left,
        originTop: bounds.top,
        devicePixelRatio,
      };
      setLayoutMetrics((current) => {
        if (
          current.rect.left === rect.left
          && current.rect.top === rect.top
          && current.rect.width === rect.width
          && current.rect.height === rect.height
          && current.pixelGrid.originLeft === pixelGrid.originLeft
          && current.pixelGrid.originTop === pixelGrid.originTop
          && current.pixelGrid.devicePixelRatio === pixelGrid.devicePixelRatio
        ) {
          return current;
        }
        return { rect, pixelGrid };
      });
    };

    updateLayoutMetrics();

    const resizeObserver = new ResizeObserver(updateLayoutMetrics);
    const stopObservingPixelRatio = observeTerminalSplitPixelRatio(window, updateLayoutMetrics);

    resizeObserver.observe(container);
    window.addEventListener("resize", updateLayoutMetrics);
    return () => {
      activeDragCleanupRef.current?.();
      resizeObserver.disconnect();
      stopObservingPixelRatio();
      window.removeEventListener("resize", updateLayoutMetrics);
    };
  }, []);

  const { rect: containerRect, pixelGrid } = layoutMetrics;
  const layout = useMemo(
    () => buildTerminalSplitLayout(node, containerRect, null, pixelGrid),
    [containerRect, node, pixelGrid],
  );
  const visibleLayout = useMemo(
    () => visibleNode
      ? buildTerminalSplitLayout(visibleNode, containerRect, null, pixelGrid)
      : { leaves: [], dividers: [] },
    [containerRect, pixelGrid, visibleNode]
  );
  const renderedLayout = liveDragLayoutRef.current?.layout ?? layout;
  const renderedVisibleLayout = liveDragLayoutRef.current?.visibleLayout ?? visibleLayout;
  const visibleLeafLayouts = new Map(
    renderedVisibleLayout.leaves.map((leafLayout) => [leafLayout.leaf.id, leafLayout])
  );
  const fullscreenLeaf = fullscreenLeafId
    ? renderedVisibleLayout.leaves.find(({ leaf }) => leaf.id === fullscreenLeafId)
    : null;
  const fullscreenRect = containerRect;
  const isDraggingDivider = draggingSplitId !== null;

  const applyDragPreview = useCallback((dragPreview: TerminalSplitDragPreview) => {
    // Keep the hot drag path outside React; React receives only drag start/end state.
    const nextLayout = buildTerminalSplitLayout(node, containerRect, dragPreview, pixelGrid);
    const nextVisibleLayout = visibleNode
      ? buildTerminalSplitLayout(visibleNode, containerRect, dragPreview, pixelGrid)
      : { leaves: [], dividers: [] };
    liveDragLayoutRef.current = { layout: nextLayout, visibleLayout: nextVisibleLayout };

    const nextVisibleLeaves = new Map(
      nextVisibleLayout.leaves.map((leafLayout) => [leafLayout.leaf.id, leafLayout])
    );
    for (const { leaf, rect: fallbackRect } of nextLayout.leaves) {
      applyRectStyle(leafElementsRef.current.get(leaf.id), nextVisibleLeaves.get(leaf.id)?.rect ?? fallbackRect);
    }
    for (const { split, rect } of nextVisibleLayout.dividers) {
      applyRectStyle(dividerElementsRef.current.get(split.id), rect);
    }
  }, [containerRect, node, pixelGrid, visibleNode]);

  const handleDragStart = useCallback(
    (split: TerminalPaneSplit, splitRect: TerminalSplitRect, e: MouseEvent) => {
      e.preventDefault();
      const container = containerRef.current;
      if (!container) return;

      const rootRect = container.getBoundingClientRect();
      const isHorizontal = split.direction === "horizontal";
      let latestRatio = split.ratio;
      let rafId: number | null = null;
      let disposed = false;
      const previousCursor = document.body.style.cursor;
      const previousUserSelect = document.body.style.userSelect;

      const flush = () => {
        rafId = null;
        applyDragPreview({ splitId: split.id, ratio: latestRatio });
      };

      const updateLatestRatio = (ev: globalThis.MouseEvent) => {
        latestRatio = clampSplitRatio(isHorizontal
          ? (ev.clientX - rootRect.left - splitRect.left) / splitRect.width
          : (ev.clientY - rootRect.top - splitRect.top) / splitRect.height);
      };

      const onMove = (ev: globalThis.MouseEvent) => {
        updateLatestRatio(ev);
        if (rafId === null) rafId = requestAnimationFrame(flush);
      };

      const cleanup = () => {
        if (disposed) return;
        disposed = true;
        if (rafId !== null) cancelAnimationFrame(rafId);
        rafId = null;
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        window.removeEventListener("blur", onBlur);
        document.body.style.cursor = previousCursor;
        document.body.style.userSelect = previousUserSelect;
        if (activeDragCleanupRef.current === cleanup) activeDragCleanupRef.current = null;
      };

      const finish = () => {
        if (disposed) return;
        if (rafId !== null) {
          cancelAnimationFrame(rafId);
          rafId = null;
        }
        applyDragPreview({ splitId: split.id, ratio: latestRatio });
        cleanup();
        setSplitRatio(split.id, latestRatio);
        liveDragLayoutRef.current = null;
        setDraggingSplitId(null);
      };

      function onUp(ev: globalThis.MouseEvent) {
        updateLatestRatio(ev);
        finish();
      }

      function onBlur() {
        finish();
      }

      activeDragCleanupRef.current?.();
      activeDragCleanupRef.current = cleanup;
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      window.addEventListener("blur", onBlur);
      document.body.style.cursor = isHorizontal ? "col-resize" : "row-resize";
      document.body.style.userSelect = "none";
      applyDragPreview({ splitId: split.id, ratio: split.ratio });
      setDraggingSplitId(split.id);
    },
    [applyDragPreview, setSplitRatio]
  );

  return (
    <div
      ref={containerRef}
      className="ui-terminal-split-node relative h-full min-h-0 w-full min-w-0 overflow-hidden"
      data-dragging={isDraggingDivider ? "true" : undefined}
      data-fullscreen={fullscreenLeaf ? "true" : undefined}
    >
      {renderedLayout.leaves.map(({ leaf, rect: fallbackRect }) => {
        const visibleLeafLayout = visibleLeafLayouts.get(leaf.id);
        const rect = visibleLeafLayout?.rect ?? fallbackRect;
        const isFullscreenLeaf = fullscreenLeaf?.leaf.id === leaf.id;
        const isHiddenByScope = !visibleLeafLayout;
        const isHiddenByFullscreen = Boolean(fullscreenLeaf) && !isFullscreenLeaf;
        return (
          <div
            key={leaf.id}
            ref={(element) => {
              if (element) leafElementsRef.current.set(leaf.id, element);
              else leafElementsRef.current.delete(leaf.id);
            }}
            className="ui-terminal-split-child absolute min-h-0 min-w-0 overflow-hidden"
            data-fullscreen={isFullscreenLeaf ? "true" : undefined}
            data-hidden={isHiddenByScope || isHiddenByFullscreen ? "true" : undefined}
            style={{
              ...rectStyle(isFullscreenLeaf ? fullscreenRect : rect),
              zIndex: isFullscreenLeaf ? 20 : undefined,
              transition: visibleNode === node ? undefined : "none",
            }}
          >
            {renderLeaf(leaf)}
          </div>
        );
      })}
      {!fullscreenLeaf && renderedVisibleLayout.dividers.map(({ split, rect, splitRect }) => {
        const isHorizontal = split.direction === "horizontal";
        const isDragging = draggingSplitId === split.id;
        return (
          <div
            key={split.id}
            ref={(element) => {
              if (element) dividerElementsRef.current.set(split.id, element);
              else dividerElementsRef.current.delete(split.id);
            }}
            onMouseDown={(event) => handleDragStart(split, splitRect, event)}
            className="ui-terminal-split-divider absolute shrink-0 transition-colors"
            data-dragging={isDragging ? "true" : undefined}
            data-orientation={isHorizontal ? "vertical" : "horizontal"}
            style={{
              ...rectStyle(rect),
              cursor: isHorizontal ? "col-resize" : "row-resize",
              zIndex: 10,
            }}
          />
        );
      })}
    </div>
  );
}
