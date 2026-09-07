export interface DesktopPetRenderedRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface DesktopPetPhysicalBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DesktopPetRenderedBoundsInput {
  current: DesktopPetPhysicalBounds;
  viewportWidth: number;
  viewportHeight: number;
  contentRects: DesktopPetRenderedRect[];
  petScale: number;
  scaleFactor: number;
  workArea?: DesktopPetPhysicalBounds | null;
  margin?: number;
}

export interface DesktopPetRenderedBoundsResult {
  bounds: DesktopPetPhysicalBounds;
  basePosition: { x: number; y: number };
  changed: boolean;
  requiredCssWidth: number;
  requiredCssHeight: number;
}

const PET_WINDOW_BASE_WIDTH = 190;
const PET_WINDOW_BASE_HEIGHT = 210;
const DEFAULT_CONTENT_MARGIN = 8;

function positiveFinite(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function roundedPhysical(value: number): number {
  return Math.max(1, Math.round(value));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function sameBounds(left: DesktopPetPhysicalBounds, right: DesktopPetPhysicalBounds): boolean {
  return (
    Math.abs(left.x - right.x) <= 1
    && Math.abs(left.y - right.y) <= 1
    && Math.abs(left.width - right.width) <= 1
    && Math.abs(left.height - right.height) <= 1
  );
}

/**
 * Calculate the smallest native window that contains the rendered pet and bubble.
 * The content is centered horizontally and anchored to the bottom, so growing
 * the window keeps the visible pet in place instead of moving it on screen.
 */
export function calculateDesktopPetRenderedBounds(
  input: DesktopPetRenderedBoundsInput
): DesktopPetRenderedBoundsResult {
  const scaleFactor = positiveFinite(input.scaleFactor, 1);
  const petScale = positiveFinite(input.petScale, 1);
  const viewportWidth = positiveFinite(input.viewportWidth, PET_WINDOW_BASE_WIDTH * petScale);
  const viewportHeight = positiveFinite(input.viewportHeight, PET_WINDOW_BASE_HEIGHT * petScale);
  const margin = Math.max(0, finite(input.margin ?? DEFAULT_CONTENT_MARGIN, DEFAULT_CONTENT_MARGIN));
  const baseCssWidth = PET_WINDOW_BASE_WIDTH * petScale;
  const baseCssHeight = PET_WINDOW_BASE_HEIGHT * petScale;
  const current = {
    x: Math.round(finite(input.current.x, 0)),
    y: Math.round(finite(input.current.y, 0)),
    width: roundedPhysical(finite(input.current.width, baseCssWidth * scaleFactor)),
    height: roundedPhysical(finite(input.current.height, baseCssHeight * scaleFactor)),
  };
  const rects = input.contentRects
    .filter((rect) => (
      Number.isFinite(rect.left)
      && Number.isFinite(rect.top)
      && Number.isFinite(rect.right)
      && Number.isFinite(rect.bottom)
      && rect.right >= rect.left
      && rect.bottom >= rect.top
    ));
  const minLeft = rects.length > 0 ? Math.min(...rects.map((rect) => rect.left)) : 0;
  const maxRight = rects.length > 0 ? Math.max(...rects.map((rect) => rect.right)) : viewportWidth;
  const minTop = rects.length > 0 ? Math.min(...rects.map((rect) => rect.top)) : 0;
  const maxBottom = rects.length > 0 ? Math.max(...rects.map((rect) => rect.bottom)) : viewportHeight;

  const viewportCenter = viewportWidth / 2;
  const contentRadius = Math.max(
    viewportCenter - minLeft,
    maxRight - viewportCenter
  );
  const requiredCssWidth = Math.max(baseCssWidth, (contentRadius + margin) * 2);
  const requiredCssHeight = Math.max(
    baseCssHeight,
    viewportHeight - minTop + margin,
    maxBottom > viewportHeight ? maxBottom + margin : 0
  );
  const requiredWidth = roundedPhysical(requiredCssWidth * scaleFactor);
  const requiredHeight = roundedPhysical(requiredCssHeight * scaleFactor);
  const currentCenter = current.x + current.width / 2;
  const currentBottom = current.y + current.height;
  let x = Math.round(currentCenter - requiredWidth / 2);
  let y = Math.round(currentBottom - requiredHeight);

  if (input.workArea) {
    const workArea = input.workArea;
    const workX = Math.round(finite(workArea.x, x));
    const workY = Math.round(finite(workArea.y, y));
    const workWidth = roundedPhysical(finite(workArea.width, requiredWidth));
    const workHeight = roundedPhysical(finite(workArea.height, requiredHeight));
    x = clamp(x, workX, workX + workWidth - requiredWidth);
    y = clamp(y, workY, workY + workHeight - requiredHeight);
  }

  const bounds = { x, y, width: requiredWidth, height: requiredHeight };
  const baseWidth = roundedPhysical(baseCssWidth * scaleFactor);
  const baseHeight = roundedPhysical(baseCssHeight * scaleFactor);
  const basePosition = {
    x: Math.round(x + requiredWidth / 2 - baseWidth / 2),
    y: Math.round(y + requiredHeight - baseHeight),
  };
  return {
    bounds,
    basePosition,
    changed: !sameBounds(current, bounds),
    requiredCssWidth,
    requiredCssHeight,
  };
}
