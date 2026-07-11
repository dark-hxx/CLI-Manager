export const DND_ACTIVATION_CONSTRAINT = { distance: 3 } as const;

export const DND_SORTABLE_TRANSITION = {
  duration: 100,
  easing: "cubic-bezier(0.2, 0, 0, 1)",
} as const;

export const POINTER_DRAG_START_PX = DND_ACTIVATION_CONSTRAINT.distance;
