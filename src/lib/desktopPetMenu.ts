export interface DesktopPetWindowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type DesktopPetMenuHorizontalPlacement = "left" | "right";
export type DesktopPetMenuVerticalPlacement = "above" | "below";

export interface DesktopPetMenuWindowGeometry {
  logicalWidth: number;
  logicalHeight: number;
  physicalWidth: number;
  physicalHeight: number;
  x: number;
  y: number;
  anchorX: number;
  anchorY: number;
  anchorWidth: number;
  anchorHeight: number;
  panelWidth: number;
  targetListHeight: number;
  horizontalPlacement: DesktopPetMenuHorizontalPlacement;
  verticalPlacement: DesktopPetMenuVerticalPlacement;
}

const DESKTOP_PET_MENU_TARGET_EXTRA_WIDTH = 440;
const DESKTOP_PET_MENU_ACTIONS_EXTRA_WIDTH = 190;
const DESKTOP_PET_MENU_CARD_HEIGHT = 58;
const DESKTOP_PET_MENU_CARD_STEP = 54;
const DESKTOP_PET_MENU_CARD_BREATHING_ROOM = 12;
const DESKTOP_PET_MENU_MAX_VISIBLE_TARGETS = 5;
const DESKTOP_PET_MENU_VERTICAL_CHROME = 28;

function finiteInteger(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.round(value) : fallback;
}

function choosePlacement<TBefore, TAfter>(
  before: number,
  after: number,
  requestedExtra: number,
  beforePlacement: TBefore,
  afterPlacement: TAfter
): TBefore | TAfter {
  if (before >= requestedExtra) return beforePlacement;
  if (after >= requestedExtra) return afterPlacement;
  return before >= after ? beforePlacement : afterPlacement;
}

export function calculateDesktopPetMenuWindowGeometry(
  collapsed: DesktopPetWindowRect,
  scaleFactor: number,
  targetCount: number,
  workArea?: DesktopPetWindowRect | null,
  secondaryHeaderHeight = 0
): DesktopPetMenuWindowGeometry {
  const safeScaleFactor = Number.isFinite(scaleFactor) && scaleFactor > 0 ? scaleFactor : 1;
  const collapsedX = finiteInteger(collapsed.x, 0);
  const collapsedY = finiteInteger(collapsed.y, 0);
  const collapsedWidth = Math.max(1, finiteInteger(collapsed.width, 1));
  const collapsedHeight = Math.max(1, finiteInteger(collapsed.height, 1));
  const anchorWidth = collapsedWidth / safeScaleFactor;
  const anchorHeight = collapsedHeight / safeScaleFactor;
  const visibleTargets = Math.min(
    Math.max(0, Math.floor(Number.isFinite(targetCount) ? targetCount : 0)),
    DESKTOP_PET_MENU_MAX_VISIBLE_TARGETS
  );
  const requestedTargetListHeight = visibleTargets > 0
    ? DESKTOP_PET_MENU_CARD_HEIGHT
      + (visibleTargets - 1) * DESKTOP_PET_MENU_CARD_STEP
      + DESKTOP_PET_MENU_CARD_BREATHING_ROOM
      + Math.max(0, Number.isFinite(secondaryHeaderHeight) ? secondaryHeaderHeight : 0)
    : 0;
  const requestedPanelWidth = visibleTargets > 0
    ? DESKTOP_PET_MENU_TARGET_EXTRA_WIDTH
    : DESKTOP_PET_MENU_ACTIONS_EXTRA_WIDTH;
  const requestedLogicalHeight = Math.max(
    anchorHeight,
    224,
    requestedTargetListHeight > 0
      ? requestedTargetListHeight + DESKTOP_PET_MENU_VERTICAL_CHROME
      : anchorHeight
  );
  const requestedPanelPhysical = Math.max(0, Math.round(requestedPanelWidth * safeScaleFactor));
  const requestedVerticalExtraPhysical = Math.max(
    0,
    Math.round((requestedLogicalHeight - anchorHeight) * safeScaleFactor)
  );

  let horizontalPlacement: DesktopPetMenuHorizontalPlacement = "left";
  let verticalPlacement: DesktopPetMenuVerticalPlacement = "above";
  let panelPhysical = requestedPanelPhysical;
  let verticalExtraPhysical = requestedVerticalExtraPhysical;

  if (workArea) {
    const workX = finiteInteger(workArea.x, collapsedX);
    const workY = finiteInteger(workArea.y, collapsedY);
    const workWidth = Math.max(0, finiteInteger(workArea.width, 0));
    const workHeight = Math.max(0, finiteInteger(workArea.height, 0));
    const workRight = workX + workWidth;
    const workBottom = workY + workHeight;
    const spaceLeft = Math.max(0, collapsedX - workX);
    const spaceRight = Math.max(0, workRight - (collapsedX + collapsedWidth));
    const spaceAbove = Math.max(0, collapsedY - workY);
    const spaceBelow = Math.max(0, workBottom - (collapsedY + collapsedHeight));

    horizontalPlacement = choosePlacement(
      spaceLeft,
      spaceRight,
      requestedPanelPhysical,
      "left",
      "right"
    );
    verticalPlacement = choosePlacement(
      spaceAbove,
      spaceBelow,
      requestedVerticalExtraPhysical,
      "above",
      "below"
    );
    panelPhysical = Math.min(
      requestedPanelPhysical,
      horizontalPlacement === "left" ? spaceLeft : spaceRight
    );
    verticalExtraPhysical = Math.min(
      requestedVerticalExtraPhysical,
      verticalPlacement === "above" ? spaceAbove : spaceBelow
    );
  }

  const physicalWidth = collapsedWidth + panelPhysical;
  const physicalHeight = collapsedHeight + verticalExtraPhysical;
  const anchorPhysicalX = horizontalPlacement === "left" ? panelPhysical : 0;
  const anchorPhysicalY = verticalPlacement === "above" ? verticalExtraPhysical : 0;
  const logicalWidth = physicalWidth / safeScaleFactor;
  const logicalHeight = physicalHeight / safeScaleFactor;
  const panelWidth = panelPhysical / safeScaleFactor;
  const targetListHeight = Math.min(
    requestedTargetListHeight,
    Math.max(0, logicalHeight - DESKTOP_PET_MENU_VERTICAL_CHROME)
  );

  return {
    logicalWidth,
    logicalHeight,
    physicalWidth,
    physicalHeight,
    x: collapsedX - anchorPhysicalX,
    y: collapsedY - anchorPhysicalY,
    anchorX: anchorPhysicalX / safeScaleFactor,
    anchorY: anchorPhysicalY / safeScaleFactor,
    anchorWidth,
    anchorHeight,
    panelWidth,
    targetListHeight,
    horizontalPlacement,
    verticalPlacement,
  };
}

export interface LatestAsyncTaskContext {
  revision: number;
  isLatest: () => boolean;
}

export interface LatestAsyncTaskRunner<T> {
  schedule: (value: T) => number;
  whenIdle: () => Promise<void>;
  dispose: () => void;
}

export function createLatestAsyncTaskRunner<T>(
  apply: (value: T, context: LatestAsyncTaskContext) => Promise<void>,
  onError?: (error: unknown) => void
): LatestAsyncTaskRunner<T> {
  let latestRevision = 0;
  let pending: { value: T; revision: number } | null = null;
  let running = false;
  let disposed = false;
  let idlePromise = Promise.resolve();
  let resolveIdle: (() => void) | null = null;

  const finishIdle = () => {
    resolveIdle?.();
    resolveIdle = null;
    idlePromise = Promise.resolve();
  };

  const start = () => {
    if (running || disposed || !pending) return;
    running = true;
    idlePromise = new Promise<void>((resolve) => {
      resolveIdle = resolve;
    });
    void (async () => {
      try {
        while (!disposed && pending) {
          const task = pending;
          pending = null;
          try {
            await apply(task.value, {
              revision: task.revision,
              isLatest: () => !disposed && task.revision === latestRevision,
            });
          } catch (error) {
            try {
              onError?.(error);
            } catch {
              // Error reporting must not stall later desired states.
            }
          }
        }
      } finally {
        running = false;
        if (!disposed && pending) {
          start();
        } else {
          finishIdle();
        }
      }
    })();
  };

  return {
    schedule(value) {
      latestRevision += 1;
      if (disposed) return latestRevision;
      pending = { value, revision: latestRevision };
      start();
      return latestRevision;
    },
    whenIdle() {
      return idlePromise;
    },
    dispose() {
      disposed = true;
      latestRevision += 1;
      pending = null;
      if (!running) finishIdle();
    },
  };
}
