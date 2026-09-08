import type { HistoryIndexStatus } from "../../../shared/types/index";
import { type StatsCacheEntry, type StatsProjectOptionsCacheEntry } from "../types/historyStoreTypes";

export const SESSION_PAGE_SIZE = 20;

export const SESSION_PAGE_FETCH_LIMIT = SESSION_PAGE_SIZE + 1;

export const DEFAULT_SEARCH_LIMIT = 120;

export const MIN_GLOBAL_SEARCH_CHARS = 3;

export const DEFAULT_HISTORY_INDEX_STATUS: HistoryIndexStatus = {
  rootsKey: "",
  phase: "idle",
  indexedFiles: 0,
  totalFiles: 0,
  generation: 0,
  partial: true,
  lastCompletedAt: null,
  error: null,
};

export const STATS_CACHE_TTL_MS = 5 * 60 * 1000;

export const STATS_CACHE_MAX = 16;

export const STATS_PROJECT_OPTIONS_CACHE_MAX = 8;

export const statsCache = new Map<string, StatsCacheEntry>();

export const statsProjectOptionsCache = new Map<string, StatsProjectOptionsCacheEntry>();

export function statsCacheGet(key: string): StatsCacheEntry | undefined {
  const entry = statsCache.get(key);
  if (entry) {
    // Refresh LRU recency
    statsCache.delete(key);
    statsCache.set(key, entry);
  }
  return entry;
}

export function statsCacheSet(key: string, entry: StatsCacheEntry): void {
  if (statsCache.has(key)) {
    statsCache.delete(key);
  } else if (statsCache.size >= STATS_CACHE_MAX) {
    const oldestKey = statsCache.keys().next().value;
    if (oldestKey !== undefined) statsCache.delete(oldestKey);
  }
  statsCache.set(key, entry);
}

export function statsProjectOptionsCacheGet(key: string): StatsProjectOptionsCacheEntry | undefined {
  const entry = statsProjectOptionsCache.get(key);
  if (entry) {
    statsProjectOptionsCache.delete(key);
    statsProjectOptionsCache.set(key, entry);
  }
  return entry;
}

export function statsProjectOptionsCacheSet(key: string, entry: StatsProjectOptionsCacheEntry): void {
  if (statsProjectOptionsCache.has(key)) {
    statsProjectOptionsCache.delete(key);
  } else if (statsProjectOptionsCache.size >= STATS_PROJECT_OPTIONS_CACHE_MAX) {
    const oldestKey = statsProjectOptionsCache.keys().next().value;
    if (oldestKey !== undefined) statsProjectOptionsCache.delete(oldestKey);
  }
  statsProjectOptionsCache.set(key, entry);
}
