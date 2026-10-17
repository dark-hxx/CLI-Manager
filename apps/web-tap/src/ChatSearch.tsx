// 對話裡的搜尋：只搜已讀取的紀錄（你的訊息、回覆、過程回覆、工具摘要與展開內容），不分大小寫。
// 符合處用 CSS Custom Highlight API 標示，不支援的瀏覽器改在內容上方疊半透明色塊；
// 收起來的執行過程、工具詳情與長提問有符合時暫時展開，關掉搜尋就回到使用者原本的折疊狀態。
// 移植自 Tap-Code（web/src/ChatSearch.tsx）。
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { flushSync } from "react-dom";
import { ChevronDown, ChevronUp, LoaderCircle, Search, X } from "lucide-react";
import { createHits, foldText, hitIn, locate, matchOffsets, type Hits } from "./chatFind";
import { overlayOpen } from "./overlay";
import { fill, type Translate } from "./i18n";

const SearchContext = createContext<Hits | null>(null);
export const SearchProvider = SearchContext.Provider;

/** 這段文字有沒有符合目前的搜尋；收起來的區塊用它決定要不要暫時展開。 */
export function useHit(text: string | undefined): boolean {
  return hitIn(text, useContext(SearchContext));
}

/** 在 `[data-find]` 標記的內容裡找出所有符合處（照文件順序）；同一個區塊裡跨元素的文字（例如粗體中間）也找得到。 */
function findRanges(root: ParentNode, hits: Hits): Range[] {
  const ranges: Range[] = [];
  for (const element of root.querySelectorAll("[data-find]")) {
    // 收起來（display: none）的內容沒有位置，標了也看不到。
    if (!(element as HTMLElement).getClientRects().length) continue;
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    const starts: number[] = [];
    let text = "";
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      nodes.push(node as Text);
      starts.push(text.length);
      text += (node as Text).data;
    }
    for (const at of matchOffsets(foldText(text), hits.query)) {
      const start = locate(starts, at, false);
      const end = locate(starts, at + hits.query.length, true);
      const range = document.createRange();
      range.setStart(nodes[start.index]!, start.offset);
      range.setEnd(nodes[end.index]!, end.offset);
      ranges.push(range);
    }
  }
  return ranges;
}

const highlights = () => typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined" ? CSS.highlights : null;
// 標示是整頁共用的；記下是哪個對話設的，關掉時只清自己的。
let owner: object | null = null;

function paint(self: object, ranges: Range[], current: Range | null, layer: HTMLElement | null) {
  owner = self;
  const registry = highlights();
  if (registry) {
    const all = new Highlight();
    for (const range of ranges) all.add(range);
    registry.set("tap-chat-find", all);
    if (current) registry.set("tap-chat-find-current", new Highlight(current));
    else registry.delete("tap-chat-find-current");
    return;
  }
  // 不支援 Custom Highlight 的瀏覽器：在捲動區內疊色塊（跟著內容捲動）。數字都是量出來的，不帶原文。
  const parent = layer?.parentElement;
  if (!layer || !parent) return;
  const box = parent.getBoundingClientRect();
  const marks: string[] = [];
  for (const range of ranges) {
    for (const rect of range.getClientRects()) {
      const top = rect.top - box.top + parent.scrollTop;
      const left = rect.left - box.left + parent.scrollLeft;
      marks.push(`<i class="${range === current ? "is-current" : ""}" style="top:${top}px;left:${left}px;width:${rect.width}px;height:${rect.height}px"></i>`);
    }
  }
  layer.innerHTML = marks.join("");
}

function clear(self: object, layer: HTMLElement | null | undefined) {
  if (layer) layer.innerHTML = "";
  if (owner !== self) return;
  owner = null;
  const registry = highlights();
  registry?.delete("tap-chat-find");
  registry?.delete("tap-chat-find-current");
}

/** 捲到這一處：外層對話捲到畫面上方約三分之一，左右捲動的區塊（表格、命令輸出、程式碼）也捲過去。 */
function reveal(range: Range, scroller: HTMLElement) {
  const rect = range.getBoundingClientRect();
  for (let element = range.startContainer.parentElement; element && element !== scroller; element = element.parentElement) {
    if (element.scrollWidth <= element.clientWidth + 1 && element.scrollHeight <= element.clientHeight + 1) continue;
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    if (["auto", "scroll"].includes(style.overflowX) && (rect.left < box.left + 8 || rect.right > box.right - 8)) {
      element.scrollLeft += rect.left - box.left - box.width / 3;
    }
    if (["auto", "scroll"].includes(style.overflowY) && (rect.top < box.top + 8 || rect.bottom > box.bottom - 8)) {
      element.scrollTop += rect.top - box.top - box.height / 3;
    }
  }
  const after = range.getBoundingClientRect();
  const box = scroller.getBoundingClientRect();
  if (after.top < box.top + 24 || after.bottom > box.bottom - 24) scroller.scrollTop += after.top - box.top - box.height / 3;
}

// 測試環境沒有 navigator；只有 Apple 平台用 ⌘F。
const mac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/**
 * 對話的搜尋列：電腦上 Ctrl/⌘+F 打開（終端聚焦時 Ctrl+F 屬於 CLI），也可以點右上角的放大鏡。
 * 只在使用者打開搜尋並輸入時才有 hits；即時刷新進來的內容只重新標示，不會因此展開任何東西。
 */
export function useChatSearch({ root, list, scroller, items, more, older, onOlder, t }: {
  /** 對話外框：判斷是不是正在顯示（Ctrl/⌘+F 只給看得到的那一個）。 */
  root: RefObject<HTMLElement | null>;
  list: RefObject<HTMLElement | null>;
  scroller: RefObject<HTMLElement | null>;
  /** 內容換了（新內容、讀進更早的紀錄）就重新找。 */
  items: unknown;
  /** 前面還有沒讀進來的紀錄、正在讀取、讀更早的一段。 */
  more: boolean;
  older: boolean;
  onOlder: () => void;
  t: Translate;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const self = useRef({});
  const restore = useRef<HTMLElement | null>(null);
  const ranges = useRef<Range[]>([]);
  // active 從最新（最下面）算起：0 是最新的一處，往上是更早的。
  const [active, setActive] = useState(0);
  const [total, setTotal] = useState(0);
  const anchor = useRef<{ node: Node; offset: number } | null>(null);
  const searched = useRef<Hits | null>(null);

  // 打字時稍等一下再找，長對話不會每個字都重排。
  useEffect(() => {
    const timer = setTimeout(() => setQuery(text.trim()), text ? 140 : 0);
    return () => clearTimeout(timer);
  }, [text]);

  const hits = useMemo(() => open ? createHits(query) : null, [open, query]);
  // 同步畫出搜尋列再聚焦：iOS 只在點擊的當下聚焦才會彈出鍵盤。
  const show = useCallback(() => {
    if (!open) restore.current = document.activeElement as HTMLElement | null;
    flushSync(() => setOpen(true));
    input.current?.focus();
    input.current?.select();
  }, [open]);
  const hide = useCallback(() => {
    setOpen(false);
    setText("");
    setQuery("");
    const previous = restore.current;
    restore.current = null;
    if (previous?.isConnected) previous.focus({ preventScroll: true });
  }, []);

  // 搜尋中內容自己變了（手動展開步驟、新的回覆）也重找；用 rAF 合併同一格的多次變動。
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const element = list.current;
    if (!hits || !element) return;
    let frame = 0;
    const observer = new MutationObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setVersion((value) => value + 1));
    });
    observer.observe(element, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["hidden"] });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [hits, list]);

  // 畫面更新後重新找出符合處、標示並（關鍵字剛換時）捲到目前這一處。active 只在這裡算出來，不放進依賴。
  useLayoutEffect(() => {
    const element = list.current;
    const scroll = scroller.current;
    if (!hits || !element || !scroll) {
      searched.current = null;
      ranges.current = [];
      clear(self.current, layer.current);
      setTotal(0);
      return;
    }
    // 關鍵字換了：從目前看到的位置附近開始，並捲過去；只是內容更新就停在原本那一處。
    const jump = searched.current !== hits;
    searched.current = hits;
    if (jump) anchor.current = null;
    const found = findRanges(element, hits);
    ranges.current = found;
    setTotal(found.length);
    if (!found.length) {
      clear(self.current, layer.current);
      return;
    }
    let index: number;
    const kept = anchor.current;
    const same = kept ? found.findIndex((range) => range.startContainer === kept.node && range.startOffset === kept.offset) : -1;
    if (same !== -1) index = same;
    else if (jump || !kept) {
      // 從看得到的範圍往上找最近的一處（對話從下往上讀）；上面都沒有就取下面最近的。
      const bottom = scroll.getBoundingClientRect().bottom;
      index = 0;
      for (let at = found.length - 1; at >= 0; at--) {
        if (found[at]!.getBoundingClientRect().top < bottom) {
          index = at;
          break;
        }
      }
    } else index = Math.min(found.length - 1, Math.max(0, found.length - 1 - active));
    const current = found[index]!;
    anchor.current = { node: current.startContainer, offset: current.startOffset };
    setActive(found.length - 1 - index);
    paint(self.current, found, current, layer.current);
    // 剛有第一處（例如讀進更早的紀錄後才找到）也捲過去。
    if (jump || !kept) reveal(current, scroll);
  }, [hits, items, version, list, scroller]);
  useEffect(() => {
    const owned = self.current;
    const marks = layer;
    return () => clear(owned, marks.current);
  }, []);

  /** 往更早（step 1）或更新（step −1）的一處移動，到底就繞回另一端。 */
  const go = (step: 1 | -1) => {
    const found = ranges.current;
    const scroll = scroller.current;
    if (!found.length || !scroll) return;
    const next = (active + step + found.length) % found.length;
    const current = found[found.length - 1 - next]!;
    anchor.current = { node: current.startContainer, offset: current.startOffset };
    setActive(next);
    paint(self.current, found, current, layer.current);
    reveal(current, scroll);
  };

  // 電腦：對話顯示中按 Ctrl/⌘+F 打開；終端聚焦時（非 macOS）Ctrl+F 留給 CLI，有彈層時不搶。
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      const modifier = mac() ? event.metaKey : event.ctrlKey;
      if (!modifier || event.altKey || event.shiftKey || event.key.toLowerCase() !== "f") return;
      const element = root.current;
      if (!element || !element.getClientRects().length || overlayOpen()) return;
      if (!mac() && (event.target as HTMLElement | null)?.closest?.(".tap-terminal")) return;
      event.preventDefault();
      show();
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [root, show]);

  const bar = open ? <div className="tap-chat-find" role="search">
    <div className="tap-chat-find-row">
      <Search size={15} className="tap-chat-find-icon" aria-hidden />
      <input ref={input} type="search" enterKeyHint="search" autoComplete="off" spellCheck={false} aria-label={t("searchChat")}
        placeholder={t("searchChat")} value={text} onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          const native = event.nativeEvent;
          if (native.isComposing || native.keyCode === 229) return;
          if (event.key === "Escape") {
            event.preventDefault();
            hide();
          } else if (event.key === "Enter") {
            event.preventDefault();
            // 關鍵字還在等待（剛打完字）時先套用，下一次再移動。
            if (text.trim() !== query) setQuery(text.trim());
            else go(event.shiftKey ? -1 : 1);
          }
        }} />
      <span className="tap-chat-find-count" aria-live="polite">{query ? (total ? `${active + 1} / ${total}` : t("noResults")) : ""}</span>
      <span className="tap-chat-find-sep" aria-hidden />
      <button type="button" className="tap-chat-find-button" aria-label={t("prevMatch")} title={t("prevMatchHint")} disabled={!total}
        onPointerDown={(event) => event.preventDefault()} onClick={() => go(1)}><ChevronUp size={17} /></button>
      <button type="button" className="tap-chat-find-button" aria-label={t("nextMatch")} title={t("nextMatchHint")} disabled={!total}
        onPointerDown={(event) => event.preventDefault()} onClick={() => go(-1)}><ChevronDown size={17} /></button>
      <button type="button" className="tap-chat-find-button" aria-label={t("closeSearch")} title={t("closeSearchHint")} onClick={hide}>
        <X size={16} />
      </button>
    </div>
    {more && query && <p className="tap-chat-find-note">
      <span>{t("searchedLoaded")}</span>
      <button type="button" className="tap-text-button" onPointerDown={(event) => event.preventDefault()} onClick={onOlder} disabled={older}>
        {older && <LoaderCircle size={13} className="tap-spin" aria-hidden />}{t(older ? "loading" : "older")}
      </button>
    </p>}
  </div> : null;

  const button = open ? null : <button type="button" className="tap-chat-find-open" aria-label={t("searchChat")}
    title={fill(t("searchShortcut"), { key: mac() ? "⌘F" : "Ctrl+F" })} onClick={show}><Search size={16} /></button>;

  return { hits, bar, button, layer: <div ref={layer} className="tap-chat-find-marks" aria-hidden /> };
}
