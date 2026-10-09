export type ConflictColumnSizes = [number, number, number];
export type ConflictDivider = 0 | 1;

export const DEFAULT_CONFLICT_COLUMNS: ConflictColumnSizes = [1 / 3, 1 / 3, 1 / 3];
export const CONFLICT_DIVIDER_WIDTH = 6;

/** width excludes the two dividers; very narrow hosts must still fit all three panes. */
export function conflictColumnMinimum(width: number): number {
  return width > 0 ? Math.min(1 / 3, 100 / width) : 1 / 3;
}

/** Project preferred proportions into the available width without overwriting the preference. */
export function fitConflictColumns(sizes: ConflictColumnSizes, width: number): ConflictColumnSizes {
  const minimum = conflictColumnMinimum(width);
  const deficit = sizes.reduce((sum, size) => sum + Math.max(0, minimum - size), 0);
  if (deficit === 0) return sizes;
  const spare = sizes.reduce((sum, size) => sum + Math.max(0, size - minimum), 0);
  if (spare === 0) return [...DEFAULT_CONFLICT_COLUMNS];
  return sizes.map((size) => size <= minimum ? minimum : size - deficit * (size - minimum) / spare) as ConflictColumnSizes;
}

/** A divider transfers width only between its adjacent panes; the opposite pane stays fixed. */
export function resizeConflictColumns(
  sizes: ConflictColumnSizes, divider: ConflictDivider, delta: number, width: number,
): ConflictColumnSizes {
  const next = [...fitConflictColumns(sizes, width)] as ConflictColumnSizes;
  const minimum = conflictColumnMinimum(width);
  const pair = next[divider] + next[divider + 1];
  next[divider] = Math.max(minimum, Math.min(pair - minimum, next[divider] + delta));
  next[divider + 1] = pair - next[divider];
  return next;
}
