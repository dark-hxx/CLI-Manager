export const DND_ACTIVATION_CONSTRAINT = { distance: 3 } as const;

export const DND_SORTABLE_TRANSITION = {
  duration: 100,
  easing: "cubic-bezier(0.2, 0, 0, 1)",
} as const;

export const POINTER_DRAG_START_PX = DND_ACTIVATION_CONSTRAINT.distance;

export const WORKSPAN_DRAG_PREFIX = "workspan:";
export const WORKSPAN_DRAG_AUTO_ACTIVATE_MS = 500;

export function parseWorkspanDragId(value: string): string | null {
  return value.startsWith(WORKSPAN_DRAG_PREFIX)
    ? value.slice(WORKSPAN_DRAG_PREFIX.length) || null
    : null;
}

export function resolveWorkspanDragHoverTarget(sourceWorkspanId: string, overId: string): string | null {
  const targetWorkspanId = parseWorkspanDragId(overId);
  return targetWorkspanId && targetWorkspanId !== sourceWorkspanId ? targetWorkspanId : null;
}
