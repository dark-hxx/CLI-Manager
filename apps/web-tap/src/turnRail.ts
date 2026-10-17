// 對話右側跳轉點的純計算：刻度分配、目前讀到哪一輪、每一輪開頭的提問。移植自 Tap-Code（web/src/TurnRail.tsx）。
import type { Item } from "./transcript";

export type RailPrompt = { key: string; text: string; at?: number };

/** 把提問平均分給每一條刻度；刻度夠多時一條一輪。 */
export function buckets(count: number, ticks: number): number[] {
  if (count <= ticks) return Array.from({ length: count }, (_, index) => index);
  return Array.from({ length: ticks }, (_, index) => Math.floor((index * count) / ticks));
}

/** 最後一則頂端在 `line` 以上的提問；`tops` 由上到下遞增。都在下面時是 0。 */
export function readingAt(tops: number[], line: number): number {
  let low = 0;
  let high = tops.length - 1;
  let found = 0;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (tops[middle]! <= line) {
      found = middle;
      low = middle + 1;
    } else high = middle - 1;
  }
  return found;
}

/** 讀到的那一輪落在哪一條刻度。 */
export function activeTick(ticks: number[], reading: number): number {
  let found = 0;
  ticks.forEach((start, index) => { if (start <= reading) found = index; });
  return found;
}

/** 每一輪開頭的提問（中途插入的不算）；內容沒變時沿用上一次的陣列，跳轉點不必重繪。 */
export function railPrompts(items: Item[], inserted: ReadonlySet<string>, previous: RailPrompt[] = []): RailPrompt[] {
  const next = items.flatMap((item) => item.type === "user" && !item.queued && !inserted.has(item.key)
    ? [{ key: item.key, text: item.text, at: item.at }] : []);
  const same = previous.length === next.length && previous.every((prompt, index) =>
    prompt.key === next[index]!.key && prompt.text === next[index]!.text && prompt.at === next[index]!.at);
  return same ? previous : next;
}
