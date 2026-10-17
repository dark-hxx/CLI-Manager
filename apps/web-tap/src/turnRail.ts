// 對話右側跳轉點的純計算：刻度分配、目前讀到哪一輪、每一輪開頭的提問。
// 移植自 Tap-Code（web/src/TurnRail.tsx）；資料改接 groupTurns 分出的每一輪。
import type { Turn } from "./turns";

/** 一輪的提問：key 是那一輪的 key（畫面上 `data-key`），at 是提問的時間。 */
export type RailPrompt = { key: string; text: string; at?: string | null };

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

/**
 * 有提問的每一輪（讀取範圍從一輪中間開始時，那一段沒有提問，不列）；內容沒變時沿用上一次的陣列，
 * 跳轉點不必重繪。讀進更早的紀錄時新的提問接在前面，原本的 key 不變。
 */
export function railPrompts(turns: readonly Turn[], previous: RailPrompt[] = []): RailPrompt[] {
  const next = turns.flatMap((turn) => turn.prompt ? [{ key: turn.key, text: turn.prompt.text, at: turn.prompt.at }] : []);
  const same = previous.length === next.length && previous.every((prompt, index) =>
    prompt.key === next[index]!.key && prompt.text === next[index]!.text && prompt.at === next[index]!.at);
  return same ? previous : next;
}
