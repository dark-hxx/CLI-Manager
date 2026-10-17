// 對話視圖的捲動：捲到某一輪並短暫標示（跳轉點、收尾列的「回到提問」共用），以及讀進更早的內容時保持閱讀位置。
// 捲動與標示移植自 Tap-Code（web/src/chatScroll.ts）。
// 這裡只操作 DOM，不依賴對話元件：捲動區是 `.tap-chat`，外框是 `.tap-chat-wrap`。

/** 讀取前畫面最上面看得到的那一項（`data-anchor` 是穩定的訊息或步驟 id）與它當時的位置。 */
export type ScrollAnchor = { key: string; top: number };

const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const timers = new WeakMap<Element, ReturnType<typeof setTimeout>>();

/** 短暫標示一項（加上 is-jump，1.6 秒後拿掉；連續觸發時重新開始）。 */
export function flashItem(element: Element) {
  element.classList.remove("is-jump");
  // 讀一次版面讓動畫重新開始。
  void (element as HTMLElement).offsetWidth;
  element.classList.add("is-jump");
  clearTimeout(timers.get(element));
  timers.set(element, setTimeout(() => element.classList.remove("is-jump"), 1600));
}

/**
 * 把對話裡 `data-key` 為 key 的那一輪捲到可視範圍頂端（減少動態時直接跳過去），並短暫標示。
 * root 是對話外框或其中任一元素；那一輪不在畫面上（還沒讀進來）時傳回 false。
 */
export function scrollToItem(key: string, root: Element | null | undefined): boolean {
  const wrap = root?.closest(".tap-chat-wrap") ?? null;
  const item = wrap?.querySelector<HTMLElement>(`.tap-chat-list [data-key="${CSS.escape(key)}"]`);
  const scroller = item?.closest<HTMLElement>(".tap-chat");
  if (!item || !scroller) return false;
  const top = item.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
  scroller.scrollTo({ top: Math.max(0, top - 12), behavior: reduced() ? "auto" : "smooth" });
  flashItem(item);
  return true;
}

/** 記下捲動區裡最上面看得到的那一項；收起來（display: none）的項目不算。 */
export function captureAnchor(scroller: HTMLElement): ScrollAnchor | undefined {
  const top = scroller.getBoundingClientRect().top;
  for (const element of scroller.querySelectorAll<HTMLElement>("[data-anchor]")) {
    const rect = element.getBoundingClientRect();
    if (rect.height > 0 && rect.bottom > top) return { key: element.dataset.anchor!, top: rect.top };
  }
  return undefined;
}

/**
 * 內容換過之後把記下的那一項放回原來的位置（前面插入了更早的內容、上面那一輪重新分組都一樣）。
 * 找不到那一項時傳回 false，由呼叫端改用整體高度差。
 */
export function restoreAnchor(scroller: HTMLElement, anchor: ScrollAnchor | undefined): boolean {
  if (!anchor) return false;
  const element = scroller.querySelector<HTMLElement>(`[data-anchor="${CSS.escape(anchor.key)}"]`);
  const rect = element?.getBoundingClientRect();
  if (!rect || rect.height <= 0) return false;
  const shift = rect.top - anchor.top;
  if (Math.abs(shift) >= 1) scroller.scrollTop += shift;
  return true;
}
