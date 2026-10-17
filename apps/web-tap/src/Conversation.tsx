// 對話視圖：把 CLI 自己的對話紀錄排成時間軸。輸入照樣送進終端；CLI 等你選擇時，原生選單在終端裡回應。
// 移植自 Tap-Code（web/src/Conversation.tsx），改寫成不依賴 TanStack 的一般 React。
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type UIEvent } from "react";
import { ArrowDown, LoaderCircle, MessageSquareDashed, SquareTerminal } from "lucide-react";
import type { JsonObject, JsonValue, TerminalStream } from "./protocol";
import { fill, type Translate } from "./i18n";
import { duration } from "./format";
import { quietFor, watchActivity } from "./activity";
import { jumping, REVEAL_EVENT, scrollToItem } from "./chatScroll";
import { overlayOpen } from "./overlay";
import { ChatItem, ModelTag, Tasks, WorkFoldRows } from "./ChatItem";
import { SearchProvider, useChatSearch } from "./ChatSearch";
import { toolLabel } from "./ChatSteps";
import { TurnRail } from "./TurnRail";
import { railPrompts, type RailPrompt } from "./turnRail";
import {
  alignStart, buildTimeline, insertedKeys, keepUnchanged, statusModel, workFolds, type Item, type KeptItems, type ModelUsed, type ToolStep,
  type WorkFold,
} from "./transcript";
import { useTranscript } from "./useTranscript";

/** 長對話一次只畫最後這麼多項；往上捲到頂端附近再往前多畫這麼多。 */
const RENDER_STEP = 80;
/** 停下來時在背景往前補畫，每次這麼多項（一次畫太多，剛好要點、要捲時會頓一下）。 */
const FILL_STEP = 30;
/** 使用者停手（點、捲動；iOS 的慣性捲動也會一直發 scroll）這麼久之後才補畫。 */
const FILL_QUIET = 1000;

/** 離頂端多近就先讀更早的內容：一個半螢幕，至少 600px。 */
const nearTop = (element: HTMLElement) => Math.max(600, element.clientHeight * 1.5);

/** 畫面最上面看得到的那一項（收起來的過程那一列不算，它的 key 會跟著範圍變）。 */
function topItem(scroller: HTMLElement): { key: string; top: number } | null {
  const top = scroller.getBoundingClientRect().top;
  for (const item of scroller.querySelectorAll<HTMLElement>(".tap-chat-list > li[data-key]:not(.tap-chat-work)")) {
    const rect = item.getBoundingClientRect();
    if (rect.bottom > top) return { key: item.dataset.key!, top: rect.top };
  }
  return null;
}

/**
 * 工作中的膠囊：模型、「工作中」、這一輪已經工作多久，第二行是正在跑的工具。用時每秒更新，
 * 獨立成一個元件，更新時只重繪膠囊，不重繪整串對話；頁面隱藏時不走。
 */
function LiveCapsule({ model, since, tool, done, t }: {
  model: ModelUsed | null; since?: number; tool?: ToolStep; done: boolean; t: Translate;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const start = () => {
      clearInterval(timer);
      setNow(Date.now());
      timer = setInterval(() => setNow(Date.now()), 1000);
    };
    const change = () => {
      if (document.visibilityState === "visible") start();
      else clearInterval(timer);
    };
    start();
    document.addEventListener("visibilitychange", change);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", change);
    };
  }, []);
  const elapsed = since ? now - since : 0;
  // 剛開始的一秒多不顯示用時，但位置先留著，時間出現時膠囊不變寬。
  const pending = elapsed > 1500 ? "" : " is-pending";
  return <div className="tap-chat-live" role="status">
    <i className="tap-live-dot" aria-hidden />
    <span className="tap-live-lines">
      <span className="tap-live-line">
        {model && <ModelTag used={model} />}
        <span className="tap-live-text">{t("working")}</span>
        <i className={`tap-live-sep${pending}`} aria-hidden />
        <span className={`tap-live-time${pending}`} aria-hidden>{duration(elapsed)}</span>
      </span>
      {tool && <span className={`tap-live-tool${done ? " is-done" : ""}`}>
        {toolLabel(tool.name, t)} <span className="tap-live-summary">{tool.summary}</span>
      </span>}
    </span>
  </div>;
}

/** 對話區裡的說明：讀不到紀錄的原因、讀取失敗、主機版本太舊；終端一直可以用。 */
function ChatNotice({ text, error = false, onRetry, onTerminal, t }: {
  text: string; error?: boolean; onRetry?: () => void; onTerminal: () => void; t: Translate;
}) {
  return <div className={`tap-chat-notice${error ? " is-error" : ""}`} role={error ? "alert" : undefined}>
    <MessageSquareDashed size={14} aria-hidden /><p>{text}</p>
    {onRetry && <button type="button" className="tap-text-button" onClick={onRetry}>{t("retry")}</button>}
    <button type="button" className="tap-text-button" onClick={onTerminal}><SquareTerminal size={14} />{t("openTerminal")}</button>
  </div>;
}

/** 主機能力：events 讀結構化的事件；legacy 只有舊版的純文字讀取，請使用者更新桌面端。 */
export type ChatMode = "events" | "legacy";

type Props = {
  sessionId: string; context: JsonObject; run: (kind: string, payload: JsonObject) => Promise<JsonValue>; stream: TerminalStream;
  /** 對話視圖看得到、會話是目前選中的：只有這時才向主機讀。 */
  active: boolean;
  mode: ChatMode;
  /** 會話進程執行中而且設備在線：每 1.2 秒取增量；否則拿一次即停。 */
  running: boolean;
  /** CLI 的顯示名稱（Claude Code、Codex…）。 */
  agent: string;
  chatSize: number;
  phone: boolean;
  onTerminal: () => void;
  /** CLI 給這段對話取的標題（沒有時是 undefined）。 */
  onTitle?: (title: string | undefined) => void;
  t: Translate;
};

export function Conversation(props: Props) {
  if (props.mode === "events") return <TranscriptView {...props} />;
  return <div className="tap-chat" style={{ "--chat-text": `${props.chatSize}px` } as CSSProperties}>
    <div className="tap-chat-pane"><div className="tap-chat-scroll">
      <ChatNotice text={props.t("upgradeDesktop")} onTerminal={props.onTerminal} t={props.t} />
    </div></div>
  </div>;
}

function TranscriptView({ sessionId, context, run, stream, active, running, agent, chatSize, phone, onTerminal, onTitle, t }: Props) {
  const transcript = useTranscript({ sessionId, context, run, stream, enabled: active, running });
  const timeline = useMemo(() => buildTimeline(transcript.events), [transcript.events]);
  const titleRef = useRef(onTitle);
  titleRef.current = onTitle;
  useEffect(() => { titleRef.current?.(timeline.title?.trim() || undefined); }, [timeline.title]);
  useEffect(() => { watchActivity(); }, []);
  const [touch] = useState(() => matchMedia("(pointer: coarse)").matches);
  const root = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLOListElement>(null);
  const pinned = useRef(true);
  const scrolling = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(scrolling.current), []);
  const [away, setAway] = useState(false);
  const [unread, setUnread] = useState(false);
  const lastEvent = timeline.items[timeline.items.length - 1];
  // CLI 正在工作：終端剛有輸出而且這一輪還沒寫下收尾列，或還有工具在跑（或等批准）。
  const working = transcript.flowing && lastEvent?.type !== "turn";
  const live = running && (working || Boolean(timeline.open));
  const { model, effort, speed } = timeline.status ?? {};
  const liveModel = useMemo(() => statusModel({ model, effort, speed }), [model, effort, speed]);
  // 內容沒變的項目沿用上一次的物件，新內容進來時只重繪變了的那幾列。
  const kept = useRef<KeptItems>(new Map());
  const items = useMemo(() => {
    const next = keepUnchanged(timeline.items, kept.current);
    kept.current = next.cache;
    return next.items;
  }, [timeline.items]);
  // 做完的每一輪只留最後的回答，過程收成「工作了 X」（參考 Codex）；搜尋要看得到收起來的字。
  const folds = useMemo(() => workFolds(items, live), [items, live]);
  // 搜尋：只搜已載入的紀錄；還有更早的紀錄時，搜尋列提示並可以接著載入。
  const search = useChatSearch({
    root, list, scroller, items, more: transcript.more, older: transcript.older, onOlder: transcript.loadOlder, t,
  });

  // 長對話先只畫最後一段：手機上一次畫幾百項要半秒以上（打開、切換都會卡）。往上捲到頂端附近先往前多畫一段，
  // 全部畫完才向主機讀更早的紀錄；搜尋時全部畫出來（搜尋找的是畫面上的字）。起點記成那一項的 key：
  // 新內容接在後面、更早的紀錄接在前面，畫的範圍都不跟著跑。
  const [startKey, setStartKey] = useState<string | null>(null);
  const windowStart = useMemo(() => {
    if (search.hits || items.length === 0) return 0;
    const pinnedAt = startKey ? items.findIndex((item) => item.key === startKey) : -1;
    return alignStart(items, folds, pinnedAt >= 0 ? pinnedAt : items.length - RENDER_STEP);
  }, [search.hits, startKey, items, folds]);
  useLayoutEffect(() => {
    if (search.hits) return;
    const key = items[windowStart]?.key ?? null;
    if (key !== startKey) setStartKey(key);
  }, [search.hits, items, windowStart, startKey]);
  const windowRef = useRef({ items, windowStart });
  windowRef.current = { items, windowStart };
  /** 往前多畫一段；已經全部畫出來時傳回 false。 */
  const grow = useCallback((step = RENDER_STEP) => {
    const { items, windowStart } = windowRef.current;
    if (windowStart <= 0) return false;
    setStartKey(items[Math.max(0, windowStart - step)]!.key);
    return true;
  }, []);
  // 畫面停著的時候在背景一段一段往前補畫，往上捲時多半已經畫好，不必邊捲邊畫：捲動中補畫完要把畫面放回原處
  // （改 scrollTop），iOS 上慣性捲動會當場停住、畫面跳一下。使用者停手一陣子、沒有彈層或抽屜開著時才補，
  // 只補看得到的對話。
  useEffect(() => {
    if (!active || windowStart <= 0 || search.hits) return;
    let timer = 0;
    let idle = 0;
    const wait = () => {
      if (typeof window.requestIdleCallback === "function") idle = window.requestIdleCallback(step, { timeout: 2000 });
      else timer = window.setTimeout(step, 50);
    };
    function step() {
      idle = 0;
      if (quietFor() < FILL_QUIET || !root.current?.getClientRects().length || overlayOpen() || document.querySelector(".tap-drawer.is-open")) {
        timer = window.setTimeout(wait, FILL_QUIET);
        return;
      }
      grow(FILL_STEP);
    }
    timer = window.setTimeout(wait, FILL_QUIET);
    return () => {
      clearTimeout(timer);
      if (idle) window.cancelIdleCallback(idle);
    };
  }, [active, windowStart, search.hits, grow]);
  // 往上翻閱時內容有變，畫面最上面那一項要留在原處（見下方）；記下的位置放在這裡。
  const anchor = useRef<{ key: string; top: number } | null>(null);
  // 跳到還沒畫出來的那一項（跳轉點、回到提问）：先往前畫到它，畫好再捲過去。
  const revealing = useRef<string | null>(null);
  useEffect(() => {
    const chat = root.current;
    if (!chat) return;
    const reveal = (event: Event) => {
      const key = (event as CustomEvent<string>).detail;
      const { items, windowStart } = windowRef.current;
      const at = items.findIndex((item) => item.key === key);
      if (at < 0 || at >= windowStart) return;
      revealing.current = key;
      setStartKey(items[Math.max(0, at - 1)]!.key);
    };
    chat.addEventListener(REVEAL_EVENT, reveal);
    return () => chat.removeEventListener(REVEAL_EVENT, reveal);
  }, []);
  useLayoutEffect(() => {
    const key = revealing.current;
    if (!key) return;
    revealing.current = null;
    pinned.current = false;
    // 這一次要捲到那一項，不用保持原本畫面最上面那一項的位置（那會改 scrollTop，打斷捲動）。
    anchor.current = null;
    scrollToItem(key, root.current);
  }, [windowStart]);
  const inserted = useMemo(() => insertedKeys(items), [items]);
  // 右側跳轉點：每一輪開頭的提問（中途插入的不算）；內容沒變時沿用同一個陣列。
  const railCache = useRef<RailPrompt[]>([]);
  const prompts = useMemo(() => (railCache.current = railPrompts(items, inserted, railCache.current)), [items, inserted]);

  // 往上翻閱時內容有變（讀進更早的內容、上面的過程收起來），畫面最上面那一項要留在原處。Safari 沒有捲動錨定
  // （overflow-anchor），前面插入內容會把畫面往下推，所以自己做：render 時 DOM 還是舊的，先記下那一項的位置，
  // 換完再放回去。最上面「读取更早的对话」那一列讀完時會變或消失，也會推動畫面，一起算。
  const shown = useRef({ items, more: transcript.more, older: transcript.older, windowStart });
  if (shown.current.items !== items || shown.current.more !== transcript.more || shown.current.older !== transcript.older
    || shown.current.windowStart !== windowStart) {
    shown.current = { items, more: transcript.more, older: transcript.older, windowStart };
    const element = scroller.current;
    anchor.current = element && !pinned.current ? topItem(element) : null;
  }
  useLayoutEffect(() => {
    const saved = anchor.current;
    const element = scroller.current;
    anchor.current = null;
    if (!saved || !element || pinned.current) return;
    const item = element.querySelector<HTMLElement>(`.tap-chat-list > li[data-key="${CSS.escape(saved.key)}"]`);
    if (!item) return;
    const shift = item.getBoundingClientRect().top - saved.top;
    if (Math.abs(shift) >= 1) element.scrollTop += shift;
  }, [items, transcript.more, transcript.older, windowStart]);

  // 內容不夠長（捲不起來）或讀完還在頂端附近時，接著往上讀到夠長為止。上一次讀取沒有帶來新內容（例如失敗）
  // 就不自己重試，等使用者捲動。看不到的對話不讀。
  const requested = useRef<Item[] | null>(null);
  const { more, older, loadOlder } = transcript;
  useEffect(() => {
    const element = scroller.current;
    if (!active || !element || jumping(element) || element.scrollTop >= nearTop(element)) return;
    if (grow()) return;
    if (!more || older || requested.current === items) return;
    requested.current = items;
    loadOlder();
  }, [active, items, windowStart, grow, more, older, loadOlder]);

  // 停在底部時跟著新內容捲動；往上翻閱時不打擾，改顯示「回到最新」，有新內容時標一個點。
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && pinned.current) element.scrollTop = element.scrollHeight;
  }, [items, live, timeline.tasks.length]);
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const observer = new ResizeObserver(() => { if (pinned.current) element.scrollTop = element.scrollHeight; });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const newest = useRef<Item | undefined>(undefined);
  useEffect(() => {
    const last = items[items.length - 1];
    if (last === newest.current) return;
    if (newest.current && !pinned.current) setUnread(true);
    newest.current = last;
  }, [items]);
  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
    pinned.current = atBottom;
    setAway(!atBottom);
    if (atBottom) setUnread(false);
    // 往上翻閱時先藏起右上角的搜尋鈕，停下來再出現；跟著新內容捲到底時不動它。
    const chat = root.current;
    if (chat && !atBottom) {
      chat.classList.add("is-scrolling");
      clearTimeout(scrolling.current);
      scrolling.current = setTimeout(() => chat.classList.remove("is-scrolling"), 800);
    }
    // 離頂端還有一個半螢幕就先讀更早的內容，捲到頂之前通常已經讀好；跳到某一項的途中先不讀。
    if (!jumping(element) && element.scrollTop < nearTop(element) && !grow() && more && !older) loadOlder();
  };

  const open = timeline.open;
  // 膠囊第二行：這一輪最後一個工具。工具之間的空檔仍顯示上一個（淡一點），膠囊不會在一行、兩行之間跳來跳去；
  // 換下一輪就清掉。
  const lastTool = useRef<{ turn?: number; tool: ToolStep } | null>(null);
  if (open) lastTool.current = { turn: timeline.lastPromptAt, tool: open };
  const shownTool = open ?? (lastTool.current?.turn === timeline.lastPromptAt ? lastTool.current?.tool : undefined);
  const row = (item: Item, index: number) => <ChatItem key={item.key} item={item} last={index === items.length - 1}
    live={live && index === items.length - 1} inserted={inserted.has(item.key)} t={t} />;
  // 收起來的過程展開時才用到：穩定的函式，WorkFoldRows 的 memo 才擋得住。
  const rowRef = useRef(row);
  rowRef.current = row;
  const renderRow = useCallback((item: Item, index: number) => rowRef.current(item, index), []);
  // 每一段過程的項目陣列：裡面的項目都沒變就沿用同一個陣列。
  const slices = useRef(new Map<string, Item[]>());
  const rows = (): ReactNode[] => {
    const next = new Map<string, Item[]>();
    const sliceOf = (fold: WorkFold) => {
      const slice = items.slice(fold.start, fold.end);
      const old = slices.current.get(fold.key);
      const kept = old && old.length === slice.length && old.every((item, index) => item === slice[index]) ? old : slice;
      next.set(fold.key, kept);
      return kept;
    };
    const out: ReactNode[] = [];
    let at = windowStart;
    for (const fold of folds) {
      if (fold.end <= windowStart) continue;
      for (; at < fold.start; at++) out.push(row(items[at]!, at));
      out.push(<WorkFoldRows key={fold.key} fold={fold} items={sliceOf(fold)} answer={items[fold.end]} renderRow={renderRow} t={t} />);
      at = fold.end;
    }
    for (; at < items.length; at++) out.push(row(items[at]!, at));
    slices.current = next;
    return out;
  };
  const jumpButton = <button type="button" className="tap-jump" aria-label={t("jumpLatest")} title={t("jumpLatest")} onClick={() => {
    const element = scroller.current;
    if (!element) return;
    pinned.current = true;
    element.scrollTop = element.scrollHeight;
    setAway(false);
    setUnread(false);
  }}><ArrowDown size={17} />{unread && <i aria-hidden />}</button>;

  const reason = transcript.loaded && !transcript.available ? transcript.reason : undefined;
  const body = transcript.failed && !transcript.loaded
    ? <ChatNotice text={t("error")} error onRetry={transcript.retry} onTerminal={onTerminal} t={t} />
    : !transcript.loaded ? <p className="tap-chat-empty" role="status">{t("chatLoading")}</p>
    : reason ? <ChatNotice text={t(reason === "unbound" || reason === "unsupported" ? reason : "missing")} onTerminal={onTerminal} t={t} />
    : !items.length ? <p className="tap-chat-empty">{fill(t("chatEmpty"), { agent })}</p>
    : <ol className="tap-chat-list" ref={list}>{rows()}</ol>;
  return <SearchProvider value={search.hits}>
    <div ref={root} className={`tap-chat${live ? " is-live" : ""}${live && shownTool ? " has-tool" : ""}`}
      style={{ "--chat-text": `${chatSize}px` } as CSSProperties}>
      {search.bar}
      <div className="tap-chat-pane">
        <div className="tap-chat-scroll" ref={scroller} onScroll={onScroll}>
          {/* 上面還有更早的內容：固定高度的一列，讀取中只有一個小轉圈，讀完或改變時不推動畫面；通常離頂端還遠就先讀好了，
            看不到它。沒有自動讀到（例如剛才讀取失敗）才有按鈕。 */}
          {more && <div className="tap-chat-older">
            {older ? <LoaderCircle size={15} className="tap-spin" aria-label={t("olderLoading")} />
              : <button type="button" onClick={loadOlder}>{t("older")}</button>}
          </div>}
          {body}
          {transcript.stale && transcript.loaded && <ChatNotice text={t("chatStale")} error onRetry={transcript.retry} onTerminal={onTerminal} t={t} />}
          {search.layer}
        </div>
        {/* 工作中的膠囊浮在對話區底部、輸入卡正上方（周圍透明，內容從它後面捲過去）：往上翻看之前的內容時也看得到進度。 */}
        {live && <div className="tap-chat-live-bar">
          <LiveCapsule model={liveModel} since={timeline.lastPromptAt} tool={shownTool} done={!open} t={t} />
          {away && jumpButton}
        </div>}
      </div>
      {items.length > 0 && search.button}
      <TurnRail prompts={prompts} scroller={scroller} more={more} older={older} onOlder={loadOlder} touch={phone || touch} t={t} />
      {/* 任務全部完成、這一輪也結束後就收起清單，不再佔位置。 */}
      {timeline.tasks.length > 0 && (live || timeline.tasks.some((task) => task.status !== "completed")) && <Tasks tasks={timeline.tasks} t={t} />}
      {/* 工作中時「回到最新」放在工作中那一列的右邊，不疊在它或任務清單上。 */}
      {away && !live && jumpButton}
    </div>
  </SearchProvider>;
}
