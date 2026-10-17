// 對話右側的跳轉點（參考 ChatGPT 網頁版）：每一輪的提問一條短橫線，讀到的那條加深加長。
// 電腦上滑過展開提問清單，點刻度或清單都跳過去；觸控裝置點這一排打開清單面板。
// 移植自 Tap-Code（web/src/TurnRail.tsx）。只列已讀進來的輪次，
// 清單頂端可以讀更早的對話（與對話頂端的「讀取更早的對話」同一個請求）。
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { LoaderCircle } from "lucide-react";
import { Sheet } from "./Sheet";
import { scrollToItem } from "./chatScroll";
import { clock } from "./format";
import { fill, type Translate } from "./i18n";
import { PHONE_QUERY } from "./preferences";
import { activeTick, buckets, readingAt, type RailPrompt } from "./turnRail";

/** 刻度之間至少隔這麼多 px；提問太多時一條刻度代表好幾輪。 */
const PITCH = 8;
/** 目前位置：提問的頂端在畫面頂端往下這麼多 px 以內，就算讀到這一輪（跳過去時停在頂端附近）。 */
const READING_LINE = 96;
/** 讀更早的對話一次最多多出這麼多輪；一批最多讀這麼多頁（那幾頁都是工具輸出時）。 */
const BATCH = 20;
const BATCH_PAGES = 8;
/** 手機面板先畫讀到的那一輪前後各幾列；面板滑出來（320ms）之後再補齊。 */
const SHEET_FIRST = 9;
const SHEET_FILL_DELAY = 360;

/** 捲動時算出正在讀哪一輪：只在換輪時更新，不會每一幀都重繪。 */
function useReading(scroller: RefObject<HTMLDivElement | null>, keys: string[]) {
  const [reading, setReading] = useState(keys.length - 1);
  useEffect(() => {
    const element = scroller.current;
    if (!element || !keys.length) return;
    let tops: number[] = [];
    const update = () => {
      const bottom = element.scrollHeight - element.scrollTop - element.clientHeight < 4;
      setReading(bottom ? keys.length - 1 : readingAt(tops, element.scrollTop + Math.min(READING_LINE, element.clientHeight * 0.3)));
    };
    const measure = () => {
      const base = element.getBoundingClientRect().top - element.scrollTop;
      let last = 0;
      tops = keys.map((key) => {
        const item = element.querySelector(`[data-key="${CSS.escape(key)}"]`);
        // 找不到的（還沒畫出來）沿用上一則的位置，保持遞增。
        if (item) last = item.getBoundingClientRect().top - base;
        return last;
      });
      update();
    };
    let frame = 0;
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(() => {
        frame = 0;
        update();
      });
    };
    measure();
    element.addEventListener("scroll", onScroll, { passive: true });
    // 內容高度變了（展開、讀進更早的內容、新的回覆）就重新量。
    const observer = new ResizeObserver(measure);
    const list = element.querySelector(".tap-chat-list");
    if (list) observer.observe(list);
    return () => {
      element.removeEventListener("scroll", onScroll);
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [scroller, keys]);
  return Math.min(reading, keys.length - 1);
}

export const TurnRail = memo(function TurnRail({ prompts, scroller, more, older, onOlder, t }: {
  prompts: RailPrompt[];
  scroller: RefObject<HTMLDivElement | null>;
  /** 前面還有沒讀進來的對話、正在讀、讀更早的一段（和對話頂端的按鈕同一套）。 */
  more: boolean;
  older: boolean;
  onOlder: () => void;
  t: Translate;
}) {
  // 觸控裝置：刻度太小點不準，整排是一個按鈕，打開清單面板。
  const [touch] = useState(() => matchMedia("(pointer: coarse)").matches || matchMedia(PHONE_QUERY).matches);
  const keys = useMemo(() => prompts.map((prompt) => prompt.key), [prompts]);
  const reading = useReading(scroller, keys);
  const [open, setOpen] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const rail = useRef<HTMLElement>(null);
  const closing = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // 刻度數量跟著可用高度：最多佔對話區的六成。對話欄右邊的留白太窄時（視窗窄、右側欄打開）不顯示，免得蓋到回覆。
  const [room, setRoom] = useState(0);
  const [tight, setTight] = useState(false);
  const shown = prompts.length >= 2;
  useLayoutEffect(() => {
    const chat = rail.current?.parentElement;
    if (!chat) return;
    const measure = () => {
      setRoom(Math.floor((chat.clientHeight * 0.6) / PITCH));
      const column = chat.querySelector(".tap-chat-list")?.getBoundingClientRect();
      const edge = chat.getBoundingClientRect().right;
      setTight(Boolean(column) && edge - column!.right < 34);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(chat);
    return () => observer.disconnect();
  }, [shown]);
  const ticks = useMemo(() => buckets(prompts.length, Math.max(2, room)), [prompts.length, room]);
  const current = useMemo(() => activeTick(ticks, reading), [ticks, reading]);

  useEffect(() => () => clearTimeout(closing.current), []);
  const show = () => {
    clearTimeout(closing.current);
    setOpen(true);
  };
  const hide = () => {
    clearTimeout(closing.current);
    closing.current = setTimeout(() => {
      setOpen(false);
      setHover(null);
    }, 160);
  };
  const jump = (index: number) => {
    const prompt = prompts[index];
    if (!prompt) return;
    scrollToItem(prompt.key, scroller.current);
    setOpen(false);
    setSheet(false);
  };

  if (!shown) return null;
  return <>
    <nav ref={rail} className={`tap-turn-rail${open ? " is-open" : ""}${tight && !touch ? " is-tight" : ""}${touch ? " is-touch" : ""}`}
      aria-label={t("jumpTurn")} onMouseEnter={touch ? undefined : show} onMouseLeave={touch ? undefined : hide}
      onFocus={touch ? undefined : show}
      onBlur={(event) => { if (!touch && !event.currentTarget.contains(event.relatedTarget)) hide(); }}
      onWheel={touch ? undefined : (event) => {
        // 在刻度上滾滾輪：打開清單並捲動它（清單自己會接住捲到頂端、讀更早的對話）。
        if ((event.target as Element).closest(".tap-turn-list")) return;
        show();
        const box = rail.current?.querySelector<HTMLElement>(".tap-turn-list");
        if (!box) return;
        if (event.deltaY < 0 && box.scrollTop <= 0) box.dispatchEvent(new WheelEvent("wheel", { deltaY: event.deltaY }));
        else box.scrollTop += event.deltaY;
      }}>
      {touch ? <button type="button" className={`tap-turn-ticks${more ? " has-more" : ""}`}
        aria-label={fill(t("jumpTurnCount"), { n: prompts.length })} onClick={() => setSheet(true)}>
        {ticks.map((start, index) => <i key={start} className={`tap-turn-tick${index === current ? " is-active" : ""}`} />)}
      </button> : <div className={`tap-turn-ticks${more ? " has-more" : ""}`}>
        {ticks.map((start, index) => <button key={start} type="button"
          className={`tap-turn-tick${index === current ? " is-active" : ""}${hover !== null && start <= hover
            && (ticks[index + 1] ?? Number.POSITIVE_INFINITY) > hover ? " is-hover" : ""}`}
          tabIndex={index === current ? 0 : -1}
          aria-label={more ? prompts[start]!.text.slice(0, 60) : fill(t("turnLabel"), { n: start + 1, text: prompts[start]!.text.slice(0, 60) })}
          onClick={() => jump(start)} onMouseEnter={() => setHover(start)}
          onKeyDown={(event) => {
            const step = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
            if (!step) return;
            event.preventDefault();
            const buttons = event.currentTarget.parentElement?.querySelectorAll("button");
            buttons?.[Math.max(0, Math.min(ticks.length - 1, index + step))]?.focus();
          }} />)}
      </div>}
      {open && !touch && <TurnList prompts={prompts} reading={reading} hover={hover} onHover={setHover} onJump={jump}
        more={more} older={older} onOlder={onOlder} t={t} />}
    </nav>
    {sheet && <Sheet title={t("jumpTurn")} onClose={() => setSheet(false)} t={t}>
      <TurnList prompts={prompts} reading={reading} onJump={jump} more={more} older={older} onOlder={onOlder} sheet t={t} />
    </Sheet>}
  </>;
});

/** 提問清單：電腦上是刻度旁的浮動卡片，手機上放在底部面板裡。 */
function TurnList({ prompts, reading, hover, onHover, onJump, sheet = false, more, older, onOlder, t }: {
  prompts: RailPrompt[]; reading: number; hover?: number | null; onHover?: (index: number | null) => void;
  onJump: (index: number) => void; sheet?: boolean; more: boolean; older: boolean; onOlder: () => void; t: Translate;
}) {
  const list = useRef<HTMLOListElement>(null);
  // 捲動的是清單本身（電腦的浮動卡片）或底部面板。
  const box = () => sheet ? list.current?.closest<HTMLElement>(".tap-sheet-body") ?? null : list.current;
  // 清單從哪一輪開始顯示（那一輪的 key）：讀進來的更早提問先藏著，點一次「读取更早的对话」多顯示 BATCH 輪，
  // 藏著的用完了才向主機讀下一段。一頁紀錄常常就有上百輪，全部一次塞進來清單會一直往上長、跳個不停。
  const [shownKey, setShownKey] = useState<string | null>(() => prompts[0]?.key ?? null);
  const shownAt = shownKey ? prompts.findIndex((prompt) => prompt.key === shownKey) : 0;
  const start = Math.max(0, shownAt);
  // 手機面板先只畫讀到的那一輪前後各一段，面板滑出來之後再補齊：一百多輪一次畫完，面板的第一幀要等好幾十毫秒，
  // 滑出來就卡一下。補齊時讀到的那一列留在原地。
  const [full, setFull] = useState(() => !sheet || prompts.length - start <= SHEET_FIRST * 2 + 1);
  const from = full ? start : Math.max(start, reading - SHEET_FIRST);
  const to = full ? prompts.length : Math.min(prompts.length, Math.max(reading, start) + SHEET_FIRST + 1);
  const pinned = useRef<{ index: number; top: number } | null>(null);
  const readingRef = useRef(reading);
  readingRef.current = reading;
  useEffect(() => {
    if (full) return;
    const timer = setTimeout(() => {
      const index = readingRef.current;
      const row = list.current?.querySelector<HTMLElement>(`[data-index="${index}"]`);
      if (row) pinned.current = { index, top: row.getBoundingClientRect().top };
      setFull(true);
    }, SHEET_FILL_DELAY);
    return () => clearTimeout(timer);
  }, [full]);
  useLayoutEffect(() => {
    const saved = pinned.current;
    const element = box();
    pinned.current = null;
    const row = saved && list.current?.querySelector<HTMLElement>(`[data-index="${saved.index}"]`);
    if (row && element) element.scrollTop += row.getBoundingClientRect().top - saved.top;
    // box 只讀 ref，只在補齊時執行。
  }, [full]);
  // 打開時把讀到的那一輪捲進清單中間（面板要等打開、排好版之後才捲得動）；之後讀進更早的提問、讀到的位置變了都不再跳。
  useLayoutEffect(() => {
    const row = list.current?.querySelector<HTMLElement>(`[data-index="${readingRef.current}"]`);
    const element = list.current;
    if (!row || !element) return;
    if (sheet) {
      const frame = requestAnimationFrame(() => row.scrollIntoView({ block: "center" }));
      return () => cancelAnimationFrame(frame);
    }
    element.scrollTop = row.offsetTop - element.clientHeight / 2 + row.offsetHeight / 2;
    // 只在打開時捲一次。
  }, []);

  // 多顯示更早的一批：上面多出來的列不推動看到的那幾列（多出來的高度補進 scrollTop），手機面板再往上露出一點新出現的，
  // 看得出多了；開始前記下高度（不是每次重畫都量 scrollHeight，那會強制排版）。
  const grown = useRef<number | null>(null);
  const reveal = (key: string) => {
    grown.current = box()?.scrollHeight ?? null;
    setShownKey(key);
  };
  useLayoutEffect(() => {
    const before = grown.current;
    const element = box();
    grown.current = null;
    if (before === null || !element) return;
    const added = element.scrollHeight - before;
    element.scrollTop += sheet ? added - Math.min(added, element.clientHeight * 0.3) : added;
  }, [shownKey]);
  // 藏著的用完了：向主機讀，讀到多出提問（中間那幾頁可能全是工具輸出，最多讀 BATCH_PAGES 頁）再顯示其中最近的 BATCH 輪。
  // 讀的時候新讀到的都先藏著，清單不動。
  const batch = useRef<{ count: number; pages: number } | null>(null);
  const [batching, setBatching] = useState(false);
  const latest = useRef({ more, older, onOlder, full, start, prompts });
  latest.current = { more, older, onOlder, full, start, prompts };
  const load = () => {
    const { more, older, onOlder, full, start, prompts } = latest.current;
    // 面板還沒補齊時清單頂端不是第一輪。
    if (!full || batch.current) return;
    if (start > 0) {
      reveal(prompts[Math.max(0, start - BATCH)]!.key);
      return;
    }
    if (!more || older) return;
    batch.current = { count: prompts.length, pages: 1 };
    setBatching(true);
    onOlder();
  };
  useEffect(() => {
    const current = batch.current;
    if (!current || older) return;
    const added = prompts.length - current.count;
    if (added <= 0 && more && current.pages < BATCH_PAGES) {
      current.pages += 1;
      onOlder();
      return;
    }
    batch.current = null;
    setBatching(false);
    if (added > 0) reveal(prompts[Math.max(0, start - BATCH)]!.key);
  }, [more, older, prompts]);
  // 電腦：往上捲到清單頂端（或在頂端繼續往上滾）就多顯示一批。手機面板只在點「读取更早的对话」時才多：
  // 慣性捲動中清單從上面長出來、改 scrollTop，iOS 會當場停住、跳一下。
  useEffect(() => {
    const element = box();
    if (!element || sheet) return;
    // 第一次捲動才讀位置：一掛上就讀 scrollTop 會強制排版。
    let last: number | null = null;
    const onScroll = () => {
      const top = element.scrollTop;
      const up = last !== null && top < last;
      last = top;
      if (up && top < 40) load();
    };
    const onWheel = (event: WheelEvent) => { if (event.deltaY < 0 && element.scrollTop <= 0) load(); };
    element.addEventListener("scroll", onScroll, { passive: true });
    element.addEventListener("wheel", onWheel, { passive: true });
    return () => {
      element.removeEventListener("scroll", onScroll);
      element.removeEventListener("wheel", onWheel);
    };
  }, [sheet]);

  return <ol ref={list} className={`tap-turn-list${sheet ? " is-sheet" : ""}`}>
    {(start > 0 || more) && from === start && <li className="tap-turn-more">
      {older || batching ? <span role="status"><LoaderCircle size={13} className="tap-spin" aria-hidden />{t("olderTurnsLoading")}</span>
        : <button type="button" onClick={load}>{t("older")}</button>}
    </li>}
    {prompts.slice(from, to).map((prompt, offset) => {
      const index = from + offset;
      // 前面還有沒讀進來的輪次時，第幾輪只是相對於已讀範圍，不標，免得讀進更早的對話後編號跟著變。
      const number = sheet && !more ? fill(t("turnNumber"), { n: index + 1 }) : "";
      const time = clock(prompt.at);
      return <li key={prompt.key} data-index={index}>
        <button type="button" className={`tap-turn-row${index === reading ? " is-active" : ""}${index === hover ? " is-hover" : ""}`}
          aria-current={index === reading || undefined} onMouseEnter={onHover ? () => onHover(index) : undefined} onClick={() => onJump(index)}>
          {/* 最多兩行：很長的提問（貼上的紀錄）只留開頭，不用排整段字。 */}
          <span className="tap-turn-row-text">{prompt.text.slice(0, 240).replace(/\s+/g, " ").trim()}</span>
          <span className="tap-turn-row-meta">{[number, time].filter(Boolean).join(" · ")}</span>
        </button>
      </li>;
    })}
  </ol>;
}
