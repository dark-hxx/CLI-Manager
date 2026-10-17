// 對話搜尋的比對：不分大小寫；逐字轉換，長度不變，位置才對得回原文。移植自 Tap-Code（web/src/ChatSearch.tsx）。
// Tap-Code 另外把簡繁視為相同（OpenCC 字典），這裡沒有那份字典，只做大小寫。

/** 目前的搜尋：query 是正規化後的關鍵字；test 判斷一段文字有沒有符合（摺起來的內容用它決定要不要展開）。 */
export type Hits = { query: string; test: (text: string) => boolean };

/** 搜尋用的正規化：逐字轉小寫；轉了會變長的字保持原樣，位置與原文一一對應。 */
export function foldText(text: string): string {
  let out = "";
  for (const char of text) {
    const lower = char.toLowerCase();
    out += lower.length === char.length ? lower : char;
  }
  return out;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * 建立一次搜尋：判斷符合用同一個不分大小寫的正規表示式，掃過整段對話時不必為每一則複製一份小寫字串。
 * 關鍵字是空白時傳回 null（沒有在搜尋）。
 */
export function createHits(text: string): Hits | null {
  const query = foldText(text.trim());
  if (!query) return null;
  const pattern = new RegExp(escape(query), "iu");
  return { query, test: (value) => Boolean(value) && pattern.test(value) };
}

/** 一段文字有沒有符合目前的搜尋；沒有在搜尋時一律為否。 */
export const hitIn = (text: string | undefined, hits: Hits | null | undefined) => Boolean(hits && text && hits.test(text));

/** 正規化後的文字裡每一處符合的起點（不重疊，照順序）。 */
export function matchOffsets(folded: string, query: string): number[] {
  const offsets: number[] = [];
  if (!query) return offsets;
  for (let at = folded.indexOf(query); at !== -1; at = folded.indexOf(query, at + query.length)) offsets.push(at);
  return offsets;
}

/**
 * 某個位置落在哪一個文字節點：starts 是各節點在整段文字裡的起點。結尾落在兩個節點交界時用前一個節點的末端，
 * 範圍才不會多包一個空節點。
 */
export function locate(starts: number[], offset: number, end: boolean): { index: number; offset: number } {
  let index = starts.length - 1;
  while (index > 0 && (end ? starts[index]! >= offset : starts[index]! > offset)) index--;
  return { index, offset: offset - (starts[index] ?? 0) };
}
