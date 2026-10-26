import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ArrowDown, ArrowUpToLine, Check, ChevronRight, Clock, Copy, LoaderCircle, MessageSquareDashed, SquareTerminal,
} from "lucide-react";
import type { JsonObject, JsonValue, TerminalStream, TerminalTranscript, TranscriptMessage } from "./protocol";
import { fill, type Translate } from "./i18n";
import { clock, duration, fullTime, modelName } from "./format";
import { stableTurns, mergeTranscript, type Turn } from "./turns";
import type { createTranscriptSignals } from "./transcriptSignals";
import { ConversationCodeBlock, ConversationCodeI18n } from "./ConversationCodeBlock";
import { ConversationActivity } from "./ConversationActivity";
import { ConversationStep } from "./ConversationStep";
import { SearchProvider, useChatSearch } from "./ChatSearch";
import { TurnRail } from "./ConversationTurnRail";
import { railPrompts, type RailPrompt } from "./rail";
import { captureAnchor, restoreAnchor, scrollToItem, type ScrollAnchor } from "./chatScroll";
import { hitIn, type Hits } from "./chatFind";
import { processText, stepViews, turnChanges, type TurnChanges } from "./tools";

/** Visible chats use bounded revision reads; legacy/hidden chats never poll full history. */
export function Conversation({ sessionId, context, run, stream, active, supported, incremental = false, changes, scope = "", chatSize, onTerminal, onReconnect, t }: {
  sessionId: string; context: JsonObject; run: (kind: string, payload: JsonObject) => Promise<JsonValue>;
  stream: TerminalStream; active: boolean; supported: boolean; chatSize: number; onTerminal: () => void; onReconnect: () => void; t: Translate;
  incremental?: boolean; changes?: ReturnType<typeof createTranscriptSignals>; scope?: string;
}) {
  const [page, setPage] = useState<TerminalTranscript>();
  const [messages, setMessages] = useState<TranscriptMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [away, setAway] = useState(false);
  const [unread, setUnread] = useState(false);
  const [flowing, setFlowing] = useState(false);
  const flowTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const turnCache = useRef<Turn[]>([]);
  const turns = useMemo(() => (turnCache.current = stableTurns(messages, turnCache.current)), [messages]);
  const reading = useRef<{ height: number; top: number } | undefined>(undefined);
  // 讀更早的內容前畫面最上面那一項；換完內容後放回原處，比整體高度差準（上面那一輪重新分組時也對）。
  const anchor = useRef<ScrollAnchor | undefined>(undefined);
  const wrap = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLOListElement>(null);
  const scrolling = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const binding = useRef<string | undefined>(undefined);
  const revision = useRef<string | undefined>(undefined);
  const epoch = useRef<string | undefined>(undefined);
  const generation = useRef(0);
  const identity = JSON.stringify([scope, sessionId, context.projectId, context.worktreeId]);
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const previousIdentity = useRef(identity);
  const busy = useRef(false);
  const again = useRef(false);
  const queuedBefore = useRef<number | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const alive = useRef(true);
  const options = useRef({ active, context, run }); options.current = { active, context, run };

  const load = useCallback(async (before?: number) => {
    if (!supported || !options.current.active || document.visibilityState === "hidden") return;
    if (busy.current) { again.current = true; if (before !== undefined) queuedBefore.current = before; return; }
    const owner = generation.current;
    const owns = () => alive.current && generation.current === owner && identityRef.current === identity;
    busy.current = true;
    if (before !== undefined && box.current) {
      reading.current = { height: box.current.scrollHeight, top: box.current.scrollTop };
      anchor.current = captureAnchor(box.current);
    }
    setLoading(true);
    try {
      const result = await options.current.run("terminal.transcript", {
        ...options.current.context, sessionId, includeDetails: true, ...(before !== undefined ? { before } : {}),
        ...(incremental && before === undefined && revision.current ? { revision: revision.current } : {}),
      });
      if (!owns()) return;
      const value = result as unknown as TerminalTranscript;
      if (!value || !Array.isArray(value.messages)) throw new Error("invalid_transcript");
      const changed = value.cliSessionId !== binding.current || (value.epoch !== undefined && value.epoch !== epoch.current);
      binding.current = value.cliSessionId;
      epoch.current = value.epoch;
      revision.current = value.revision;
      if (value.unchanged && !changed) { setError(false); return; }
      setPage((old) => before !== undefined ? { ...value, start: value.start } : { ...value, start: changed ? value.start : Math.min(old?.start ?? value.start, value.start) });
      setMessages((old) => {
        return mergeTranscript(old, value, changed || !value.available);
      });
      setError(false);
    } catch (caught) {
      // 讀更早的內容失敗：不留讀取前的位置，免得之後的刷新把畫面拉回那裡。
      if (owns() && before !== undefined) { reading.current = undefined; anchor.current = undefined; }
      if (owns() && !(caught instanceof DOMException && caught.name === "AbortError")) setError(true);
    }
    finally {
      if (owns()) {
        busy.current = false;
        setLoading(false);
        if (again.current) {
          again.current = false;
          const nextBefore = queuedBefore.current; queuedBefore.current = undefined;
          timer.current = setTimeout(() => { timer.current = undefined; void load(nextBefore); }, incremental ? 0 : 2000);
        }
      }
    }
  }, [sessionId, supported, incremental, identity]);

  useEffect(() => {
    generation.current++;
    alive.current = true;
    busy.current = false; again.current = false; queuedBefore.current = undefined;
    if (previousIdentity.current !== identity) {
      previousIdentity.current = identity;
      binding.current = undefined; revision.current = undefined; epoch.current = undefined;
      reading.current = undefined; anchor.current = undefined;
      pinned.current = true; setMessages([]); setPage(undefined); setError(false); setAway(false); setUnread(false);
    }
    if (active) void load();
    const schedule = () => {
      if (!options.current.active || document.visibilityState === "hidden" || timer.current) return;
      if (busy.current) { again.current = true; return; }
      timer.current = setTimeout(() => { timer.current = undefined; void load(); }, incremental ? 400 : 2000);
    };
    const unsubscribe = stream.subscribe(sessionId, () => {
      if (!options.current.active || document.visibilityState === "hidden") return;
      setFlowing(true); clearTimeout(flowTimer.current);
      flowTimer.current = setTimeout(() => setFlowing(false), 4000);
      schedule();
    });
    const unsubscribeChanges = changes?.subscribe(sessionId, schedule);
    // Renews the bounded host lease and recovers lost notifications/final delayed log writes.
    // Never turn this on for hosts whose reader still scans the complete history.
    let fallback: ReturnType<typeof setTimeout> | undefined;
    const check = () => { schedule(); fallback = setTimeout(check, 5000); };
    if (incremental && active && supported) fallback = setTimeout(check, 5000);
    const visible = () => { if (document.visibilityState === "visible") void load(); };
    document.addEventListener("visibilitychange", visible);
    return () => {
      alive.current = false; generation.current++; clearTimeout(timer.current); clearTimeout(fallback);
      timer.current = undefined; unsubscribe(); unsubscribeChanges?.(); document.removeEventListener("visibilitychange", visible);
    };
  }, [active, load, sessionId, stream, incremental, supported, changes, identity]);

  useLayoutEffect(() => {
    if (!box.current) return;
    if (reading.current) {
      if (!restoreAnchor(box.current, anchor.current)) box.current.scrollTop = reading.current.top + box.current.scrollHeight - reading.current.height;
      reading.current = undefined;
      anchor.current = undefined;
    } else if (pinned.current) box.current.scrollTop = box.current.scrollHeight;
    else setUnread(true);
  }, [messages]);
  useEffect(() => () => { clearTimeout(flowTimer.current); clearTimeout(scrolling.current); }, []);
  const bottom = () => { if (box.current) box.current.scrollTop = box.current.scrollHeight; setUnread(false); };

  // 跳轉點、搜尋列與對話頂端的按鈕讀更早的內容都走同一個請求，保持同一套閱讀位置。
  const start = supported && page ? page.start : 0;
  const older = useCallback(() => { if (start > 0) void load(start); }, [load, start]);
  const search = useChatSearch({ root: wrap, list, scroller: box, items: turns, more: start > 0, older: loading, onOlder: older, t });
  const railCache = useRef<RailPrompt[]>([]);
  const prompts = useMemo(() => (railCache.current = railPrompts(turns, railCache.current)), [turns]);

  const notice = !supported ? "noChat" : page?.available === false ? page.reason ?? "missing" : undefined;
  return <SearchProvider value={search.hits}>
    <div ref={wrap} className="tap-chat-wrap" style={{ "--chat-text": `${chatSize}px` } as CSSProperties}>
      {search.bar}
      <div className="tap-chat" ref={box} onScroll={() => {
        const element = box.current;
        if (!element) return;
        pinned.current = element.scrollHeight - element.clientHeight - element.scrollTop < 48;
        setAway(!pinned.current);
        if (pinned.current) setUnread(false);
        // 往上翻閱時先藏起右上角的搜尋鈕，停下來再出現；跟著新內容捲到底時不動它。
        const frame = wrap.current;
        if (frame && !pinned.current) {
          frame.classList.add("is-scrolling");
          clearTimeout(scrolling.current);
          scrolling.current = setTimeout(() => frame.classList.remove("is-scrolling"), 800);
        }
      }}>
        <div className="tap-chat-column">
          {supported && page && page.start > 0 && <div className="tap-load-older">
            {loading ? <LoaderCircle size={15} className="tap-spin" aria-label={t("loading")} />
              : <button type="button" onClick={() => void load(page.start)}>{t("older")}</button>}
          </div>}
          {notice && <div className="tap-chat-notice" role="status"><MessageSquareDashed size={14} /><p>{t(notice as "noChat")}</p>
            {!supported && <button type="button" className="tap-text-button" onClick={onReconnect}>{t("reconnect")}</button>}
            <button type="button" className="tap-text-button" onClick={onTerminal}><SquareTerminal size={14} />{t("openTerminal")}</button>
          </div>}
          {error && <div className="tap-chat-notice is-error" role="alert"><p>{t("error")}</p>
            <button type="button" className="tap-text-button" onClick={() => void load()}>{t("retry")}</button></div>}
          {loading && !page && <p className="tap-chat-empty" role="status">{t("loading")}</p>}
          {page?.available && !messages.length && <p className="tap-chat-empty">{t("chatEmpty")}</p>}
          <ol className="tap-chat-list" ref={list}>
            {turns.map((turn, index) => <MemoTurnView key={turn.key} turn={turn} live={flowing && index === turns.length - 1}
              hits={search.hits} t={t} />)}
          </ol>
        </div>
        {search.layer}
      </div>
      {messages.length > 0 && search.button}
      {supported && <TurnRail prompts={prompts} scroller={box} more={start > 0} older={loading} onOlder={older} t={t} />}
      {away && <button type="button" className="tap-jump" aria-label={t("jumpLatest")} title={t("jumpLatest")} onClick={bottom}>
        <ArrowDown size={17} />{unread && <i aria-hidden />}
      </button>}
    </div>
  </SearchProvider>;
}

/**
 * Process details always start folded, including while new output arrives.
 * hits：對話搜尋命中收起來的過程或長提問時暫時展開；關掉搜尋就回到使用者原本的選擇。
 */
const MemoTurnView = memo(TurnView);
function TurnView({ turn, live, hits, t }: { turn: Turn; live: boolean; hits?: Hits | null; t: Translate }) {
  const [open, setOpen] = useState(false);
  const steps = turn.steps.length;
  // 工具步驟的摘要只在這一輪的內容換了時重算；同一個呼叫與結果沿用上一次推導的結果。
  const views = useMemo(() => stepViews(turn.steps), [turn.steps]);
  const changes = useMemo(() => turnChanges(turn, views), [turn, views]);
  const processHit = useMemo(() => Boolean(hits) && hitIn(processText(turn.steps, views), hits), [hits, turn.steps, views]);
  const expanded = open || processHit;
  const [mounted, setMounted] = useState(expanded);
  useEffect(() => { if (expanded) setMounted(true); }, [expanded]);
  const model = modelName(turn.answer?.model ?? turn.steps.at(-1)?.model);
  const label = steps ? fill(t("processSteps"), { n: steps })
    : turn.elapsed !== undefined ? fill(t("workedFor"), { time: duration(turn.elapsed) }) : "";
  return <li className="tap-turn" data-key={turn.key}>
    {turn.prompt && <UserBubble message={turn.prompt} hit={hitIn(turn.prompt.text, hits)} t={t} />}
    {(steps > 0 || (label && model)) && <button type="button" className="tap-fold" aria-expanded={expanded}
      disabled={!steps} onClick={() => setOpen(!expanded)}>
      {steps > 0 && <ChevronRight size={13} className={expanded ? "is-open" : undefined} />}
      {live && <LoaderCircle size={13} className="tap-spin" aria-label={t("statusRunning")} />}
      {model && <span className="tap-fold-model">{model}</span>}<span>{label}</span>
      {steps > 0 && turn.elapsed !== undefined && <span>{fill(t("workedFor"), { time: duration(turn.elapsed) })}</span>}
    </button>}
    <div className="tap-process" hidden={!expanded}>
      {(mounted || expanded) && turn.steps.map((message) => {
        const view = views.get(message.id);
        if (view) return <ConversationStep key={message.id} view={view} t={t} />;
        return message.parts
          ? <ConversationActivity key={message.id} message={message} t={t}
            hit={Boolean(hits) && hitIn(message.parts.map((part) => part.text).join("\n"), hits)} />
          : <Message key={message.id} message={message} t={t} />;
      })}
    </div>
    {turn.answer && <Message message={turn.answer} t={t} />}
    {turn.answer && <Footer message={turn.answer} turn={turn} changes={changes} t={t} />}
  </li>;
}

function UserBubble({ message, hit = false, t }: { message: TranscriptMessage; hit?: boolean; t: Translate }) {
  const long = message.text.length > 900 || message.text.split("\n").length > 12;
  const [open, setOpen] = useState(false);
  const expanded = open || hit;
  return <div className="tap-user" data-anchor={message.id}>
    <div className={`tap-bubble${long && !expanded ? " is-clamped" : ""}`} data-find="">{message.text}</div>
    {long && <button type="button" className="tap-bubble-more" onClick={() => setOpen(!expanded)}>{t(expanded ? "collapse" : "expand")}</button>}
  </div>;
}

/** Message HTML remains escaped; links can only navigate through Markdown's safe URL handling. */
function Message({ message, t }: { message: TranscriptMessage; t: Translate }) {
  return <article className="tap-message" data-anchor={message.id} data-find="">
    <ConversationCodeI18n value={t}><Markdown remarkPlugins={[remarkGfm]} components={{
      a: ({ children, href }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
      table: ({ children }) => <div className="tap-table"><table>{children}</table></div>,
      // A stable component type preserves folding/copy state while transcript text refreshes.
      pre: ConversationCodeBlock,
    }}>{message.text}</Markdown></ConversationCodeI18n>
    {message.truncated && <small className="tap-truncated">{t("truncated")}</small>}
  </article>;
}

/** 複製到剪貼簿；不是安全連線（例如內網的 http）時沒有 Clipboard API，改用選取文字複製。 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (window.isSecureContext && navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* 改用下方的相容做法。 */ }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.cssText = "position:fixed;top:0;left:0;opacity:0;";
  document.body.append(area);
  area.select();
  let copied = false;
  try { copied = document.execCommand("copy"); } catch { copied = false; }
  area.remove();
  return copied;
}

/**
 * 一輪的收尾列：複製最終回答、回到這一輪的提問、完成時刻（24 小時制）、用時（提問到最終回答）與本輪增刪行數。
 * 回答超過主機的 4000 字上限時只複製得到顯示的部分，回饋文字會說明；行數不完整時標「約」並說明原因。
 */
function Footer({ message, turn, changes, t }: { message: TranscriptMessage; turn: Turn; changes?: TurnChanges; t: Translate }) {
  const [copied, setCopied] = useState<"idle" | "done" | "failed">("idle");
  useEffect(() => {
    if (copied === "idle") return;
    const timer = setTimeout(() => setCopied("idle"), copied === "failed" ? 3000 : 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  const time = clock(message.at);
  const copyLabel = t(copied === "failed" ? "copyAnswerFailed" : copied === "done" ? (message.truncated ? "answerCopiedPartial" : "answerCopied") : "copyAnswer");
  const changeLabel = changes && fill(t(changes.approximate ? "turnChangesApprox" : "turnChanges"), { added: changes.added, removed: changes.removed });
  // 一般的複製成功只換圖示；只複製到一部分或失敗時另外寫出來。
  const feedback = copied === "failed" || (copied === "done" && message.truncated) ? copyLabel : "";
  return <footer className="tap-turn-foot">
    <button type="button" aria-label={copyLabel} title={copyLabel}
      onClick={() => void copyText(message.text).then((done) => setCopied(done ? "done" : "failed"))}>
      {copied === "done" ? <Check size={13} /> : <Copy size={13} />}
    </button>
    {turn.prompt && <button type="button" aria-label={t("toPrompt")} title={t("toPrompt")}
      onClick={(event) => scrollToItem(turn.key, event.currentTarget)}><ArrowUpToLine size={13} /></button>}
    {time && <time className="tap-meta" dateTime={message.at ?? undefined} title={fill(t("finishedAt"), { time: fullTime(message.at) })}>{time}</time>}
    {turn.elapsed !== undefined && <span className="tap-meta" title={fill(t("turnTime"), { time: duration(turn.elapsed) })}>
      <Clock size={12} aria-hidden />{duration(turn.elapsed)}
    </span>}
    {changes && <span className="tap-meta tap-turn-changes" role="img" aria-label={changeLabel} title={changeLabel}>
      {changes.approximate && <span>{t("approx")}</span>}<span className="tap-add">+{changes.added}</span><span className="tap-del">−{changes.removed}</span>
    </span>}
    <span className="tap-turn-feedback" role="status">{feedback}</span>
  </footer>;
}
