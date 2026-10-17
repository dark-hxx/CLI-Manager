// `terminal.transcript_events` 回傳的一頁事件：驗證形狀、合併到手上的事件、決定下一步。
// 讀取節奏與重讀規則比照 Tap-Code 的 useTranscript；這裡只放純邏輯，方便測試。
import type { Hunk, TranscriptEvent } from "./transcript";
import type { JsonValue } from "./protocol";

export type TranscriptReason = "unsupported" | "unbound" | "missing";

export type TranscriptPage = {
  /** 主機解析紀錄的方式的版本：和手上事件的版本不同時整份重讀。 */
  parser?: number;
  available: boolean;
  reason?: TranscriptReason;
  agentSessionId?: string;
  /** 這一頁在紀錄檔裡的位元組範圍：start 之前還有更早的內容，cursor 是下次增量讀取的起點。 */
  start: number;
  cursor: number;
  size: number;
  /** 紀錄檔被改寫或截短，這一頁是重新讀的最新一段。 */
  reset?: boolean;
  more: boolean;
  /** 增量讀取因單次結果的上限提早停下：游標之後還有已寫完的內容，應該馬上再讀。 */
  partial?: boolean;
  events: TranscriptEvent[];
};

/** 手上的事件：屬於哪一段 CLI 對話、哪一版解析方式，以及在紀錄檔裡的範圍。 */
export type PageState = { id: string; parser?: number; events: TranscriptEvent[]; start: number; cursor: number };
export type PageMeta = { available: boolean; loaded: boolean; more: boolean; reason?: string };

type Json = { [key: string]: unknown };
const object = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string";
const count = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const flag = (value: unknown): value is boolean => typeof value === "boolean";
const REASONS = new Set<string>(["unsupported", "unbound", "missing"]);

/** 可有可無的欄位：型別不對就拿掉，畫面不會拿到奇怪的值。 */
function optional(event: Json, check: (value: unknown) => boolean, ...keys: string[]) {
  for (const key of keys) if (key in event && !check(event[key])) delete event[key];
}

function hunk(value: unknown): value is Hunk {
  return object(value) && count(value.oldStart) && count(value.oldLines) && count(value.newStart) && count(value.newLines)
    && Array.isArray(value.lines) && value.lines.every(text);
}

/** 每種事件必備的欄位；不認得的事件、缺欄位的事件整個略過，不顯示。 */
function event(value: unknown): TranscriptEvent | null {
  if (!object(value) || !text(value.kind)) return null;
  const item: Json = { ...value };
  optional(item, count, "at", "ms", "images", "added", "removed", "attempt", "max", "retryInMs", "messages");
  optional(item, text, "uuid", "args", "ansi", "model", "detail", "subject", "status", "effort", "speed", "code");
  optional(item, flag, "fast", "truncated");
  const required = (...keys: string[]) => keys.every((key) => text(item[key]));
  switch (item.kind) {
    case "user": case "queued": case "assistant": case "commandOutput": case "title": case "error": case "notice":
      if (!required("text")) return null;
      break;
    case "command":
      if (!required("name")) return null;
      break;
    case "thinking":
      optional(item, text, "text");
      break;
    case "tool":
      if (!required("id", "name", "summary")) return null;
      break;
    case "result":
      if (!required("id") || typeof item.ok !== "boolean") return null;
      optional(item, text, "text");
      if ("diff" in item && !(Array.isArray(item.diff) && item.diff.every(hunk))) delete item.diff;
      break;
    case "task":
      if (!required("id") || (item.op !== "create" && item.op !== "update")) return null;
      break;
    case "tasks":
      if (!Array.isArray(item.items)) return null;
      // 主機的任務項目可以沒有狀態，和單筆 task 事件一樣當成 pending，不要整項丟掉。
      item.items = item.items.filter((task) => object(task) && text(task.id) && text(task.subject))
        .map((task) => ({ ...task, status: text(task.status) ? task.status : "pending" }));
      break;
    case "turn":
      if (!count(item.ms)) return null;
      break;
    case "compact": case "status":
      break;
    default:
      return null;
  }
  return item as unknown as TranscriptEvent;
}

/** 收窄主機的回傳；形狀不對時傳回 null（當作讀取失敗）。 */
export function parsePage(value: JsonValue | unknown): TranscriptPage | null {
  if (!object(value) || typeof value.available !== "boolean" || !count(value.start) || !count(value.cursor)) return null;
  const events = Array.isArray(value.events) ? value.events.map(event).filter((item): item is TranscriptEvent => item !== null) : [];
  return {
    parser: count(value.parser) ? value.parser : undefined,
    available: value.available,
    reason: text(value.reason) && REASONS.has(value.reason) ? value.reason as TranscriptReason : undefined,
    agentSessionId: text(value.agentSessionId) && value.agentSessionId ? value.agentSessionId : undefined,
    start: value.start,
    cursor: value.cursor,
    size: count(value.size) ? value.size : value.cursor,
    reset: value.reset === true || undefined,
    more: value.more === true,
    partial: value.partial === true || undefined,
    events,
  };
}

/** 合併新一頁事件：增量接在後面，較早的頁面接在前面，重設時整個換掉。 */
export function mergePage(current: { events: TranscriptEvent[]; start: number; cursor: number } | null, page: TranscriptPage,
  direction: "initial" | "newer" | "older"): { events: TranscriptEvent[]; start: number; cursor: number } {
  if (!current || direction === "initial" || page.reset) return { events: page.events, start: page.start, cursor: page.cursor };
  if (direction === "older") return { events: [...page.events, ...current.events], start: page.start, cursor: current.cursor };
  return { events: page.events.length ? [...current.events, ...page.events] : current.events, start: current.start, cursor: page.cursor };
}

export type Accepted =
  /** 還沒對上 CLI 的對話（或讀不到）：丟掉手上的事件，顯示原因。 */
  | { kind: "unbound"; meta: PageMeta }
  /** 換了對話（例如在 CLI 裡 /clear），或主機更新後解析方式變了：丟掉手上的事件，從最新的一段重讀。 */
  | { kind: "rebind" }
  | { kind: "merged"; state: PageState; meta: PageMeta };

/**
 * 輪詢拿到一頁之後怎麼處理。還沒寫出第一行的新對話（missing 但已經知道是哪段對話）也算對上了，
 * 對話視圖先顯示空白狀態。`more` 是目前已知的「前面還有更早的內容」，增量讀取不改變它。
 */
export function acceptPage(held: PageState | null, more: boolean, page: TranscriptPage): Accepted {
  const bound = page.available || (page.reason === "missing" && Boolean(page.agentSessionId));
  if (!bound) return { kind: "unbound", meta: { available: false, loaded: true, more: false, reason: page.reason ?? "missing" } };
  const id = page.agentSessionId ?? "";
  // 同一段對話還是空白的（紀錄檔還沒寫出第一行）：下一頁直接當成第一頁，不因版本號不同而重讀。
  const current = held && held.id === id && !held.events.length && held.cursor === 0 ? null : held;
  if (!page.available) {
    // 紀錄暫時讀不到：同一段對話時保留手上的內容與游標，不能把游標歸零（下次會從頭重讀、內容重複）。
    if (current && current.id !== id) return { kind: "rebind" };
    return {
      kind: "merged", state: current ?? { id, parser: page.parser, events: [], start: 0, cursor: 0 },
      meta: { available: true, loaded: true, more: current ? more : false },
    };
  }
  if (current && (current.id !== id || current.parser !== page.parser)) return { kind: "rebind" };
  const merged = mergePage(current, page, current ? "newer" : "initial");
  return {
    kind: "merged", state: { id, parser: page.parser, ...merged },
    meta: { available: true, loaded: true, more: current && !page.reset ? more : page.more },
  };
}

/**
 * 增量讀取回來時，手上的事件還接得上這一頁嗎：讀取期間只會多出更早的內容（同一段對話、游標不變），
 * 其他變化（重讀、換了對話）都表示這一頁已經對不上。
 */
export function linesUp(requested: PageState | null, current: PageState | null): boolean {
  if (!requested || !current) return requested === current;
  return current.id === requested.id && current.parser === requested.parser && current.cursor === requested.cursor;
}

/**
 * 讀更早的一頁回來時：同一段對話、手上的範圍也沒變（期間沒有重讀）才接在前面；
 * 對話換了傳回 "rebind"（要重讀），範圍變了傳回 null（這一頁作廢）。
 */
export function acceptOlder(current: PageState | null, requested: { id: string; parser?: number; start: number }, page: TranscriptPage):
  { state: PageState; more: boolean } | "rebind" | null {
  if (!page.available || (page.agentSessionId ?? "") !== requested.id || page.parser !== requested.parser) return "rebind";
  if (!current || current.id !== requested.id || current.start !== requested.start) return null;
  return { state: { ...current, ...mergePage(current, page, "older") }, more: page.more };
}
