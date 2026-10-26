import type { TranscriptMessage } from "./protocol";

export type Turn = {
  key: string;
  prompt?: TranscriptMessage;
  /** Interim text and canonical activity groups, in source order. */
  steps: TranscriptMessage[];
  answer?: TranscriptMessage;
  /** Elapsed time from the prompt to the final answer, when both carry timestamps. */
  elapsed?: number;
};

const time = (message?: TranscriptMessage) => {
  const value = message?.at ? Date.parse(message.at) : Number.NaN;
  return Number.isFinite(value) ? value : undefined;
};

const sources = new WeakMap<Turn, TranscriptMessage[]>();

/** Rebuild only changed turns; source identity is stable after page reconciliation. */
export function stableTurns(messages: TranscriptMessage[], previous: Turn[]): Turn[] {
  const old = new Map(previous.map((turn) => [turn.key, turn]));
  const segments: TranscriptMessage[][] = [];
  for (const message of messages) {
    if (!segments.length || (message.role === "user" && message.text.trim())) segments.push([]);
    segments.at(-1)!.push(message);
  }
  const next = segments.map((segment) => {
    const cached = old.get(segment[0]!.id);
    const before = cached && sources.get(cached);
    if (before?.length === segment.length && before.every((message, index) => message === segment[index])) return cached!;
    const turn = groupTurns(segment)[0]!;
    sources.set(turn, segment);
    return turn;
  });
  return next.length === previous.length && next.every((turn, index) => turn === previous[index]) ? previous : next;
}

/** Bounded response pages overlap; reuse identical rows instead of repainting old Markdown. */
export function mergeTranscript(old: TranscriptMessage[], page: { messages: TranscriptMessage[]; total: number }, reset: boolean): TranscriptMessage[] {
  const existing = new Map((reset ? [] : old).filter((m) => Number(m.id.slice(m.id.lastIndexOf(":") + 1)) < page.total).map((m) => [m.id, m]));
  for (const message of page.messages) {
    const cached = existing.get(message.id);
    if (!cached || JSON.stringify(cached) !== JSON.stringify(message)) existing.set(message.id, message);
  }
  const next = [...existing.values()].sort((a, b) => Number(a.id.slice(a.id.lastIndexOf(":") + 1)) - Number(b.id.slice(b.id.lastIndexOf(":") + 1)));
  return next.length === old.length && next.every((m, index) => m === old[index]) ? old : next;
}

/** Tool results never start a user turn; pair tools only by an explicit call ID. */
export function groupTurns(messages: TranscriptMessage[]): Turn[] {
  const turns: Turn[] = [];
  let current: Turn | undefined;
  let replies: TranscriptMessage[] = [];
  let calls = new Map<string, TranscriptMessage>();
  const close = () => {
    if (!current) return;
    const last = replies.at(-1);
    current.answer = last?.role === "assistant" && last.text.trim() ? last : undefined;
    current.steps = current.answer ? replies.slice(0, -1) : replies;
    const start = time(current.prompt);
    const end = time(current.answer);
    if (start !== undefined && end !== undefined && end >= start && end - start < 86_400_000) current.elapsed = end - start;
    turns.push(current);
  };
  for (const message of messages) {
    const prompt = message.role === "user" && Boolean(message.text.trim());
    if (prompt) {
      close();
      current = { key: message.id, prompt: message, steps: [] };
      replies = [];
      calls = new Map();
    }
    if (!current) current = { key: message.id, steps: [] };
    const parts = message.parts ?? [];
    let textIndex = -1;
    parts.forEach((part, index) => { if (part.kind === "text") textIndex = index; });
    const appendText = () => {
      if (!prompt && message.role === "assistant" && message.text.trim())
        replies.push({ ...message, parts: undefined, partsTruncated: undefined });
    };
    if (message.partsTruncated) replies.push({ ...message, id: `${message.id}:omitted`, role: "tool", text: "", parts: [] });
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index]!;
      if (part.kind === "text") { if (index === textIndex) appendText(); continue; }
      if (part.kind !== "tool_call" && part.kind !== "tool_result" && part.kind !== "reasoning") continue;
      const key = part.kind !== "reasoning" ? part.callId : undefined;
      const paired = key ? calls.get(key) : undefined;
      if (paired) { paired.parts!.push(part); continue; }
      const activity: TranscriptMessage = { ...message, id: key ? `tool:${key}` : part.id,
        role: "tool", text: "", parts: [part], truncated: false, partsTruncated: undefined };
      if (key) calls.set(key, activity);
      replies.push(activity);
    }
    // Old hosts return no parts; a bounded detailed page may also omit text blocks.
    if (textIndex < 0) appendText();
  }
  close();
  return turns;
}
