import { useCallback, useEffect, useRef, useState } from "react";
import type { JsonObject, JsonValue, TerminalStream } from "./protocol";
import type { TranscriptEvent } from "./transcript";
import { acceptOlder, acceptPage, linesUp, parsePage, type PageMeta, type PageState } from "./transcriptPage";

/** 會話執行中的輪詢間隔；終端有新輸出時可以提早，但兩次讀取的開始至少隔這麼久。 */
const POLL_MS = 1200;
/** 讀取失敗時逐次加倍重試，最久隔這麼久（每次讀取都是一個主機 operation）。 */
const RETRY_MAX_MS = 15_000;
/** 終端最後一次輸出之後多久內，算 CLI 還在輸出。 */
const FLOWING_MS = 1800;
const KIND = "terminal.transcript_events";
const EMPTY_META: PageMeta = { available: false, loaded: false, more: false };
const NO_EVENTS: TranscriptEvent[] = [];

type Run = (kind: string, payload: JsonObject) => Promise<JsonValue>;
type Timer = ReturnType<typeof setTimeout>;

export type TranscriptStatus = {
  /** 已對上 CLI 的紀錄檔（檔案可能還沒寫出第一行）。 */
  available: boolean;
  loaded: boolean;
  events: TranscriptEvent[];
  /** 前面還有沒讀進來的紀錄；older 是正在讀更早的一段。 */
  more: boolean;
  older: boolean;
  /** 讀不到紀錄的原因：unbound（還沒對上 CLI 的對話）、missing、unsupported。 */
  reason?: string;
  /** 還沒讀到任何內容就失敗了（執行中的會話會照節奏重試）。 */
  failed: boolean;
  /** 手上已有內容，但更新連續失敗（例如主機暫時讀不到）：畫面保留內容，另外提示正在重試。 */
  stale: boolean;
  /** 終端剛有新輸出（CLI 多半正在工作）。 */
  flowing: boolean;
  loadOlder: () => void;
  retry: () => void;
};

/**
 * 讀 CLI 自己寫下的對話紀錄（比照 Tap-Code 的 useTranscript）。只在對話視圖看得到、會話是目前選中的、
 * 頁面沒有隱藏時讀：會話執行中每 1.2 秒取一次增量，已結束的拿一次就停。終端有新輸出時可以提早讀，
 * 但請求會合併、不會重疊。綁定的對話換了、解析方式變了、紀錄檔被改寫時，丟掉手上的事件重讀。
 */
export function useTranscript({ sessionId, context, run, stream, enabled, running }: {
  sessionId: string; context: JsonObject; run: Run; stream: TerminalStream; enabled: boolean; running: boolean;
}): TranscriptStatus {
  const [state, setState] = useState<PageState | null>(null);
  const [meta, setMeta] = useState<PageMeta>(EMPTY_META);
  const [older, setOlder] = useState(false);
  const [failed, setFailed] = useState(false);
  const [stale, setStale] = useState(false);
  const [flowing, setFlowing] = useState(false);
  // 手上的事件與狀態另外放在 ref：輪詢的回呼不必等重繪才讀到最新的值。
  const data = useRef<PageState | null>(null);
  const known = useRef<PageMeta>(EMPTY_META);
  const latest = useRef({ context, run, enabled, running });
  latest.current = { context, run, enabled, running };
  const control = useRef({
    alive: true, flight: false, again: false, older: false, timer: undefined as Timer | undefined,
    due: 0, started: 0, failures: 0, rebinds: 0,
  });

  const publish = useCallback((next: PageState | null, nextMeta?: PageMeta) => {
    data.current = next;
    setState(next);
    if (nextMeta) {
      known.current = nextMeta;
      setMeta(nextMeta);
    }
  }, []);
  const readable = useCallback(() => control.current.alive && latest.current.enabled && document.visibilityState !== "hidden", []);
  const stop = useCallback(() => {
    clearTimeout(control.current.timer);
    control.current.timer = undefined;
  }, []);
  // 計時器到點時呼叫最新的 tick（tick 也會排下一次，兩者經由 ref 互相找到）。
  const tickRef = useRef(() => {});
  const schedule = useCallback((delay: number) => {
    const loop = control.current;
    clearTimeout(loop.timer);
    loop.due = Date.now() + delay;
    loop.timer = setTimeout(() => {
      loop.timer = undefined;
      tickRef.current();
    }, delay);
  }, []);

  const tick = useCallback(async (): Promise<void> => {
    const loop = control.current;
    stop();
    if (!readable()) return;
    if (loop.flight) {
      loop.again = true;
      return;
    }
    loop.flight = true;
    loop.again = false;
    loop.started = Date.now();
    const requested = data.current;
    const { context, run } = latest.current;
    // 下一次讀取要等多久；undefined 表示停下來（已結束的會話拿一次即停）。
    let next: number | undefined;
    try {
      const page = parsePage(await run(KIND, { ...context, sessionId, ...(requested ? { cursor: requested.cursor } : {}) }));
      if (!loop.alive) return;
      if (!page) throw new Error("invalid_transcript");
      loop.failures = 0;
      setFailed(false);
      setStale(false);
      // 讀取期間可能讀進了更早的一頁：接在最新的事件後面，不能蓋掉它；接不上時這一頁作廢、馬上重讀。
      const current = data.current;
      const accepted = linesUp(requested, current) ? acceptPage(current, known.current.more, page) : null;
      if (!accepted) next = 0;
      else if (accepted.kind === "rebind") {
        publish(null, { ...known.current, loaded: false });
        // 馬上從最新的一段重讀；主機一直換來換去時不要變成連續請求。
        next = loop.rebinds++ < 2 ? 0 : POLL_MS;
      } else {
        loop.rebinds = 0;
        publish(accepted.kind === "merged" ? accepted.state : null, accepted.meta);
        // 主機因單次結果的上限只讀了一部分：馬上接著讀，已結束的會話也要讀完。
        next = accepted.kind === "merged" && page.partial ? 0 : latest.current.running ? POLL_MS : undefined;
      }
    } catch (error) {
      // 換了設備或登出：範圍已經不是這裡的了，不再讀。
      if (!loop.alive || (error instanceof DOMException && error.name === "AbortError")) return;
      loop.failures++;
      if (!data.current) setFailed(true);
      else if (loop.failures >= 2) setStale(true);
      next = latest.current.running ? Math.min(RETRY_MAX_MS, POLL_MS * 2 ** loop.failures) : undefined;
    } finally {
      loop.flight = false;
    }
    if (!readable()) return;
    // 讀取中又有人要讀（終端有輸出、手動重試）：從這一次開始算 1.2 秒後再讀一次。
    if (loop.again) next = Math.min(next ?? Number.POSITIVE_INFINITY, Math.max(0, loop.started + POLL_MS - Date.now()));
    if (next !== undefined && Number.isFinite(next)) schedule(next);
  }, [sessionId, publish, readable, stop, schedule]);
  tickRef.current = () => { void tick(); };

  useEffect(() => {
    const loop = control.current;
    loop.alive = true;
    return () => {
      loop.alive = false;
      clearTimeout(loop.timer);
    };
  }, []);

  // 看得到時馬上讀一次；換成執行中、或已結束（要拿最後一次）也馬上讀。看不到時停。
  useEffect(() => {
    if (!enabled) {
      stop();
      return;
    }
    void tick();
    const visible = () => {
      if (document.visibilityState === "visible") void tick();
      else stop();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      document.removeEventListener("visibilitychange", visible);
      stop();
    };
  }, [enabled, running, tick, stop]);

  // 終端有新輸出：標記 CLI 正在輸出，並把下一次讀取提早到「上一次開始後 1.2 秒」。
  useEffect(() => {
    if (!enabled) return;
    let flowTimer: Timer | undefined;
    const unsubscribe = stream.subscribe(sessionId, (chunk) => {
      if (!chunk.frames.some((frame) => frame.kind === "output")) return;
      setFlowing(true);
      clearTimeout(flowTimer);
      flowTimer = setTimeout(() => setFlowing(false), FLOWING_MS);
      const loop = control.current;
      if (!latest.current.running || !readable()) return;
      if (loop.flight) {
        loop.again = true;
        return;
      }
      const wait = Math.max(0, loop.started + POLL_MS - Date.now());
      if (!loop.timer || Date.now() + wait < loop.due) schedule(wait);
    });
    return () => {
      unsubscribe();
      clearTimeout(flowTimer);
      setFlowing(false);
    };
  }, [enabled, sessionId, stream, schedule, readable]);

  const loadOlder = useCallback(() => {
    const loop = control.current;
    const current = data.current;
    if (!current || loop.older || current.start <= 0 || !known.current.more || !readable()) return;
    loop.older = true;
    setOlder(true);
    const requested = { id: current.id, parser: current.parser, start: current.start };
    const { context, run } = latest.current;
    run(KIND, { ...context, sessionId, before: current.start }).then((value) => {
      if (!loop.alive) return;
      const page = parsePage(value);
      if (!page) return;
      const result = acceptOlder(data.current, requested, page);
      // 對話換了：照一般的讀取重新對上；手上的範圍變了（期間重讀過）：這一頁作廢。
      if (result === "rebind") void tick();
      else if (result) publish(result.state, { ...known.current, more: result.more });
    }, () => {}).finally(() => {
      loop.older = false;
      if (loop.alive) setOlder(false);
    });
  }, [sessionId, tick, publish, readable]);

  const retry = useCallback(() => { void tick(); }, [tick]);

  return {
    available: meta.available, loaded: meta.loaded, events: state?.events ?? NO_EVENTS, more: meta.more, older,
    reason: meta.reason, failed, stale, flowing, loadOlder, retry,
  };
}
