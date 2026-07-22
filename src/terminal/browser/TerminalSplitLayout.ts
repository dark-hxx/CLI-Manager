import type {
  TerminalPaneLeaf,
  TerminalPaneNode,
  TerminalPaneSplit,
} from "../../stores/terminalPaneTree";

export interface TerminalSplitRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface TerminalSplitPixelGrid {
  originLeft: number;
  originTop: number;
  devicePixelRatio: number;
}

export interface TerminalSplitPixelRatioTarget {
  readonly devicePixelRatio: number;
  matchMedia: (query: string) => MediaQueryList;
}

export interface TerminalSplitDragPreview {
  splitId: string;
  ratio: number;
}

export interface TerminalLeafLayout {
  leaf: TerminalPaneLeaf;
  rect: TerminalSplitRect;
}

export interface TerminalDividerLayout {
  split: TerminalPaneSplit;
  rect: TerminalSplitRect;
  splitRect: TerminalSplitRect;
}

export interface TerminalSplitLayout {
  leaves: TerminalLeafLayout[];
  dividers: TerminalDividerLayout[];
}

const DIVIDER_SIZE = 4;

function clampSize(value: number): number {
  return Math.max(0, value);
}

function normalizedPixelRatio(devicePixelRatio: number): number {
  return Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
}

export function observeTerminalSplitPixelRatio(
  target: TerminalSplitPixelRatioTarget,
  onChange: () => void,
): () => void {
  let mediaQuery: MediaQueryList | null = null;
  let disposed = false;

  const handleChange = () => {
    if (disposed) return;
    bind();
    onChange();
  };
  const bind = () => {
    mediaQuery?.removeEventListener("change", handleChange);
    mediaQuery = target.matchMedia(`(resolution: ${normalizedPixelRatio(target.devicePixelRatio)}dppx)`);
    mediaQuery.addEventListener("change", handleChange);
  };

  bind();
  return () => {
    disposed = true;
    mediaQuery?.removeEventListener("change", handleChange);
    mediaQuery = null;
  };
}

export function snapTerminalSplitCoordinate(value: number, devicePixelRatio: number): number {
  const pixelRatio = normalizedPixelRatio(devicePixelRatio);
  return Math.round(value * pixelRatio) / pixelRatio;
}

export function alignTerminalSplitRootRect(
  bounds: Pick<DOMRectReadOnly, "left" | "top" | "right" | "bottom">,
  devicePixelRatio: number,
): TerminalSplitRect {
  const alignedLeft = snapTerminalSplitCoordinate(bounds.left, devicePixelRatio);
  const alignedTop = snapTerminalSplitCoordinate(bounds.top, devicePixelRatio);
  const alignedRight = snapTerminalSplitCoordinate(bounds.right, devicePixelRatio);
  const alignedBottom = snapTerminalSplitCoordinate(bounds.bottom, devicePixelRatio);
  return {
    left: alignedLeft - bounds.left,
    top: alignedTop - bounds.top,
    width: clampSize(alignedRight - alignedLeft),
    height: clampSize(alignedBottom - alignedTop),
  };
}

function snapLocalCoordinate(
  value: number,
  origin: number,
  devicePixelRatio: number,
): number {
  return snapTerminalSplitCoordinate(origin + value, devicePixelRatio) - origin;
}

export function buildTerminalSplitLayout(
  node: TerminalPaneNode,
  rect: TerminalSplitRect,
  dragPreview: TerminalSplitDragPreview | null,
  pixelGrid: TerminalSplitPixelGrid,
): TerminalSplitLayout {
  if (node.type === "leaf") {
    return { leaves: [{ leaf: node, rect }], dividers: [] };
  }

  const isHorizontal = node.direction === "horizontal";
  const start = isHorizontal ? rect.left : rect.top;
  const totalLength = isHorizontal ? rect.width : rect.height;
  const end = start + totalLength;
  const ratio = dragPreview?.splitId === node.id ? dragPreview.ratio : node.ratio;
  const axisOrigin = isHorizontal ? pixelGrid.originLeft : pixelGrid.originTop;
  const desiredCenter = start + totalLength * ratio;
  const dividerStart = Math.min(
    end,
    Math.max(
      start,
      snapLocalCoordinate(desiredCenter - DIVIDER_SIZE / 2, axisOrigin, pixelGrid.devicePixelRatio),
    ),
  );
  const dividerEnd = Math.min(
    end,
    Math.max(
      dividerStart,
      snapLocalCoordinate(desiredCenter + DIVIDER_SIZE / 2, axisOrigin, pixelGrid.devicePixelRatio),
    ),
  );
  const firstLength = clampSize(dividerStart - start);
  const dividerLength = clampSize(dividerEnd - dividerStart);
  const secondLength = clampSize(end - dividerEnd);

  const firstRect: TerminalSplitRect = isHorizontal
    ? { left: rect.left, top: rect.top, width: firstLength, height: rect.height }
    : { left: rect.left, top: rect.top, width: rect.width, height: firstLength };
  const dividerRect: TerminalSplitRect = isHorizontal
    ? { left: dividerStart, top: rect.top, width: dividerLength, height: rect.height }
    : { left: rect.left, top: dividerStart, width: rect.width, height: dividerLength };
  const secondRect: TerminalSplitRect = isHorizontal
    ? { left: dividerEnd, top: rect.top, width: secondLength, height: rect.height }
    : { left: rect.left, top: dividerEnd, width: rect.width, height: secondLength };

  const firstLayout = buildTerminalSplitLayout(node.first, firstRect, dragPreview, pixelGrid);
  const secondLayout = buildTerminalSplitLayout(node.second, secondRect, dragPreview, pixelGrid);

  return {
    leaves: [...firstLayout.leaves, ...secondLayout.leaves],
    dividers: [
      { split: node, rect: dividerRect, splitRect: rect },
      ...firstLayout.dividers,
      ...secondLayout.dividers,
    ],
  };
}
