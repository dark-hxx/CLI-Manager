import { useCallback, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import { useTerminalStore } from "../stores/terminalStore";
import { clampSplitRatio, type TerminalPaneLeaf, type TerminalPaneNode, type TerminalPaneSplit } from "../stores/terminalPaneTree";
import {
  alignTerminalSplitRootRect,
  buildTerminalSplitLayout,
  observeTerminalSplitPixelRatio,
  type TerminalSplitDragPreview,
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

function rectStyle(rect: TerminalSplitRect): CSSProperties {
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
  };
}

export function SplitTerminalView({ node, visibleNode = node, renderLeaf, fullscreenLeafId }: Props) {
  const setSplitRatio = useTerminalStore((s) => s.setSplitRatio);
  const containerRef = useRef<HTMLDivElement>(null);
  const [layoutMetrics, setLayoutMetrics] = useState<SplitLayoutMetrics>({
    rect: { left: 0, top: 0, width: 0, height: 0 },
    pixelGrid: { originLeft: 0, originTop: 0, devicePixelRatio: 1 },
  });
  const [dragPreview, setDragPreview] = useState<TerminalSplitDragPreview | null>(null);

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
      resizeObserver.disconnect();
      stopObservingPixelRatio();
      window.removeEventListener("resize", updateLayoutMetrics);
    };
  }, []);

  const { rect: containerRect, pixelGrid } = layoutMetrics;
  const layout = useMemo(
    () => buildTerminalSplitLayout(node, containerRect, dragPreview, pixelGrid),
    [containerRect, dragPreview, node, pixelGrid],
  );
  const visibleLayout = useMemo(
    () => visibleNode
      ? buildTerminalSplitLayout(visibleNode, containerRect, dragPreview, pixelGrid)
      : { leaves: [], dividers: [] },
    [containerRect, dragPreview, pixelGrid, visibleNode]
  );
  const visibleLeafLayouts = useMemo(
    () => new Map(visibleLayout.leaves.map((leafLayout) => [leafLayout.leaf.id, leafLayout])),
    [visibleLayout.leaves]
  );
  const fullscreenLeaf = fullscreenLeafId
    ? visibleLayout.leaves.find(({ leaf }) => leaf.id === fullscreenLeafId)
    : null;
  const fullscreenRect = containerRect;
  const isDraggingDivider = dragPreview !== null;

  const handleDragStart = useCallback(
    (split: TerminalPaneSplit, splitRect: TerminalSplitRect, e: MouseEvent) => {
      e.preventDefault();
      const container = containerRef.current;
      if (!container) return;

      const rootRect = container.getBoundingClientRect();
      const isHorizontal = split.direction === "horizontal";
      let latestRatio = split.ratio;
      let rafId: number | null = null;

      const flush = () => {
        rafId = null;
        setDragPreview((current) => (
          current?.splitId === split.id && current.ratio === latestRatio
            ? current
            : { splitId: split.id, ratio: latestRatio }
        ));
      };

      const onMove = (ev: globalThis.MouseEvent) => {
        latestRatio = clampSplitRatio(isHorizontal
          ? (ev.clientX - rootRect.left - splitRect.left) / splitRect.width
          : (ev.clientY - rootRect.top - splitRect.top) / splitRect.height);
        if (rafId === null) rafId = requestAnimationFrame(flush);
      };

      const onUp = () => {
        if (rafId !== null) cancelAnimationFrame(rafId);
        setDragPreview(null);
        setSplitRatio(split.id, latestRatio);
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      document.body.style.cursor = isHorizontal ? "col-resize" : "row-resize";
      document.body.style.userSelect = "none";
      setDragPreview({ splitId: split.id, ratio: split.ratio });
    },
    [setSplitRatio]
  );

  return (
    <div
      ref={containerRef}
      className="ui-terminal-split-node relative h-full min-h-0 w-full min-w-0 overflow-hidden"
      data-dragging={isDraggingDivider ? "true" : undefined}
      data-fullscreen={fullscreenLeaf ? "true" : undefined}
    >
      {layout.leaves.map(({ leaf, rect: fallbackRect }) => {
        const visibleLeafLayout = visibleLeafLayouts.get(leaf.id);
        const rect = visibleLeafLayout?.rect ?? fallbackRect;
        const isFullscreenLeaf = fullscreenLeaf?.leaf.id === leaf.id;
        const isHiddenByScope = !visibleLeafLayout;
        const isHiddenByFullscreen = Boolean(fullscreenLeaf) && !isFullscreenLeaf;
        return (
          <div
            key={leaf.id}
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
      {!fullscreenLeaf && visibleLayout.dividers.map(({ split, rect, splitRect }) => {
        const isHorizontal = split.direction === "horizontal";
        const isDragging = dragPreview?.splitId === split.id;
        return (
          <div
            key={split.id}
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
