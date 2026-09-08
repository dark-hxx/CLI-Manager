import type { HistoryToolEvent, HistoryToolCount } from "../../../shared/types/index";

export function inferredToolActivity(events: readonly HistoryToolEvent[] = []) {
  const builtin = new Map<string, number>();
  const mcp = new Map<string, number>();
  const seen = new Set<string>();
  let total = 0;
  for (const [index, event] of events.entries()) {
    if (event.evidence?.kind !== "inferred") continue;
    const id = event.call_id ?? `${index}`;
    if (seen.has(id)) continue;
    seen.add(id);
    total += 1;
    const server = event.category.startsWith("mcp:") ? event.category.slice(4) : null;
    const counts = server ? mcp : builtin;
    const name = server || event.name;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const sorted = (counts: Map<string, number>): HistoryToolCount[] => Array.from(counts, ([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return { total, builtin: sorted(builtin), mcp: sorted(mcp) };
}
