import type { HistoryMessage } from "./types";

export const HISTORY_SORTABLE_DETAIL_VIEWS = [
  "conversation",
  "transcript",
  "timeline",
  "changes",
  "tools",
  "subtasks",
] as const;

export type HistorySortableDetailView = (typeof HISTORY_SORTABLE_DETAIL_VIEWS)[number];
export type HistoryDetailSortDirection = "ascending" | "descending";
export type HistoryDetailSortDirections = Record<
  HistorySortableDetailView,
  HistoryDetailSortDirection
>;

export const DEFAULT_HISTORY_DETAIL_SORT_DIRECTIONS: HistoryDetailSortDirections = {
  conversation: "ascending",
  transcript: "ascending",
  timeline: "ascending",
  changes: "ascending",
  tools: "ascending",
  subtasks: "ascending",
};

export interface HistoryMessageEntry {
  message: HistoryMessage;
  messageIndex: number;
}

export function isHistorySortableDetailView(value: string): value is HistorySortableDetailView {
  return (HISTORY_SORTABLE_DETAIL_VIEWS as readonly string[]).includes(value);
}

export function sortHistoryItems<T>(
  items: readonly T[],
  direction: HistoryDetailSortDirection,
): T[] {
  return direction === "descending" ? [...items].reverse() : [...items];
}

/**
 * Keep messageIndex tied to the raw transcript position while projecting the
 * currently visible window in display order. Descending mode starts at the
 * tail so loading more can reveal earlier messages without reordering data.
 */
export function buildVisibleHistoryMessageEntries(
  messages: readonly HistoryMessage[],
  visibleCount: number,
  direction: HistoryDetailSortDirection,
): HistoryMessageEntry[] {
  const total = messages.length;
  const count = Math.max(0, Math.min(total, visibleCount));
  const firstIndex = direction === "descending" ? total - count : 0;
  const lastIndex = direction === "descending" ? total : count;
  const entries: HistoryMessageEntry[] = [];

  if (direction === "descending") {
    for (let messageIndex = lastIndex - 1; messageIndex >= firstIndex; messageIndex -= 1) {
      entries.push({ message: messages[messageIndex], messageIndex });
    }
  } else {
    for (let messageIndex = firstIndex; messageIndex < lastIndex; messageIndex += 1) {
      entries.push({ message: messages[messageIndex], messageIndex });
    }
  }

  return entries;
}
