// 對話視圖的導覽：捲到某一項並短暫標示（收尾列的「回到提问」、跳轉點共用）。
// 不依賴對話視圖的元件。移植自 Tap-Code（web/src/chatScroll.ts）。

const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * 長對話只畫了最後一段：要跳到還沒畫出來的那一項時，請對話視圖往前多畫到它（畫好後它自己捲過去）。
 * detail 是那一項的 key。
 */
export const REVEAL_EVENT = "cli-manager-tap:reveal";

const timers = new WeakMap<Element, ReturnType<typeof setTimeout>>();
const jumps = new WeakMap<HTMLElement, () => void>();

/**
 * 跳到某一項的平滑捲動還在進行：這時對話視圖不往前補畫、不讀更早的內容。不然捲到頂端附近時前面插入內容，
 * 保持畫面位置的修正會改 scrollTop，平滑捲動當場停住，停在別的地方。
 */
export const jumping = (scroller: HTMLElement) => "jumping" in scroller.dataset;

function markJump(scroller: HTMLElement) {
  jumps.get(scroller)?.();
  scroller.dataset.jumping = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const done = () => {
    clearTimeout(timer);
    scroller.removeEventListener("scrollend", done);
    if (jumps.get(scroller) !== done) return;
    jumps.delete(scroller);
    delete scroller.dataset.jumping;
  };
  // 有的瀏覽器沒有 scrollend，最多等這麼久。
  timer = setTimeout(done, 1200);
  scroller.addEventListener("scrollend", done);
  jumps.set(scroller, done);
}

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
 * 把對話裡 `data-key` 為 key 的那一項捲到可視範圍頂端（減少動態時直接跳過去），並短暫標示。
 * root 是那個對話視圖（或其中任一元素）；這一項還沒畫出來時請對話視圖先畫，傳回 false。
 */
export function scrollToItem(key: string, root: Element | null | undefined): boolean {
  const chat = root?.closest(".tap-chat") ?? null;
  const item = chat?.querySelector<HTMLElement>(`.tap-chat-list [data-key="${CSS.escape(key)}"]`);
  const scroller = item?.closest<HTMLElement>(".tap-chat-scroll");
  if (!item || !scroller) {
    chat?.dispatchEvent(new CustomEvent(REVEAL_EVENT, { detail: key }));
    return false;
  }
  const top = item.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
  const smooth = !reduced();
  if (smooth) markJump(scroller);
  scroller.scrollTo({ top: Math.max(0, top - 12), behavior: smooth ? "smooth" : "auto" });
  flashItem(item);
  return true;
}
