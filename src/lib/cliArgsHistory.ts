export interface CliArgsHistoryEntry {
  cliTool: string;
  cliArgs: string;
  count: number;
  lastUsedAt: number;
}

export const CLI_ARGS_HISTORY_LIMIT = 10;

function normalizeCliTool(value: string): string {
  return value.trim().toLowerCase();
}

function entryKey(cliTool: string, cliArgs: string): string {
  return `${cliTool}\u0000${cliArgs}`;
}

export function normalizeCliArgsHistory(value: unknown): CliArgsHistoryEntry[] {
  if (!Array.isArray(value)) return [];

  const merged = new Map<string, CliArgsHistoryEntry>();
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Record<string, unknown>;
    if (typeof raw.cliTool !== "string" || typeof raw.cliArgs !== "string") continue;

    const cliTool = normalizeCliTool(raw.cliTool);
    const cliArgs = raw.cliArgs.trim();
    const count = typeof raw.count === "number" && Number.isFinite(raw.count)
      ? Math.floor(raw.count)
      : 0;
    const lastUsedAt = typeof raw.lastUsedAt === "number" && Number.isFinite(raw.lastUsedAt)
      ? Math.max(0, raw.lastUsedAt)
      : 0;
    if (!cliTool || !cliArgs || count < 1) continue;

    const key = entryKey(cliTool, cliArgs);
    const current = merged.get(key);
    merged.set(key, current
      ? {
          ...current,
          count: current.count + count,
          lastUsedAt: Math.max(current.lastUsedAt, lastUsedAt),
        }
      : { cliTool, cliArgs, count, lastUsedAt });
  }

  return Array.from(merged.values());
}

export function recordCliArgsUsage(
  history: unknown,
  cliTool: string,
  cliArgs: string,
  usedAt = Date.now(),
): CliArgsHistoryEntry[] {
  const normalized = normalizeCliArgsHistory(history);
  const normalizedTool = normalizeCliTool(cliTool);
  const normalizedArgs = cliArgs.trim();
  if (!normalizedTool || !normalizedArgs) return normalized;

  const key = entryKey(normalizedTool, normalizedArgs);
  const index = normalized.findIndex((entry) => entryKey(entry.cliTool, entry.cliArgs) === key);
  const lastUsedAt = Number.isFinite(usedAt) ? Math.max(0, usedAt) : Date.now();
  if (index < 0) {
    return [...normalized, { cliTool: normalizedTool, cliArgs: normalizedArgs, count: 1, lastUsedAt }];
  }

  return normalized.map((entry, currentIndex) => currentIndex === index
    ? { ...entry, count: entry.count + 1, lastUsedAt }
    : entry);
}

export function getCliArgsHistorySuggestions(
  history: unknown,
  cliTool: string,
  limit = CLI_ARGS_HISTORY_LIMIT,
  query = "",
): CliArgsHistoryEntry[] {
  const normalizedTool = normalizeCliTool(cliTool);
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedTool || limit <= 0) return [];

  return normalizeCliArgsHistory(history)
    .filter((entry) => entry.cliTool === normalizedTool && (!normalizedQuery || entry.cliArgs.toLowerCase().includes(normalizedQuery)))
    .sort((left, right) =>
      right.count - left.count ||
      right.lastUsedAt - left.lastUsedAt ||
      left.cliArgs.localeCompare(right.cliArgs)
    )
    .slice(0, limit);
}
