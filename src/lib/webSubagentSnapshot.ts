import { parseTranscriptLines } from "./subagentTranscriptMessages";
import type { WebWorkspaceSnapshot } from "./webDevice";

type Session = { id: string; title: string; kind?: string; subagent?: { parentSessionId: string; source?: { kind: string } } };
type Transcript = { content: string; ended: boolean; source: { kind: string } };
const encoder = new TextEncoder();
const MAX_CONTENT_BYTES = 128 * 1024;
const parseCache = new Map<string, { content: string; total: number; messages: ReturnType<typeof parseTranscriptLines>["messages"] }>();

// Send readable JSONL only, never local transcript paths or unbounded tool payloads.
export function buildWebSubagentSnapshots(sessions: Session[], transcripts: Record<string, Transcript>, parentIds: Set<string>): NonNullable<WebWorkspaceSnapshot["subagents"]> {
  const children = sessions.filter((session) => session.kind === "subagent-transcript" && session.subagent && parentIds.has(session.subagent.parentSessionId)).slice(-64);
  const liveIds = new Set(children.map((session) => session.id));
  for (const id of parseCache.keys()) if (!liveIds.has(id)) parseCache.delete(id);
  const budget = Math.min(32 * 1024, Math.floor(MAX_CONTENT_BYTES / Math.max(1, children.length)));
  return children.map((session) => {
    const transcript = transcripts[session.id];
    const original = transcript?.content ?? "";
    let cached = parseCache.get(session.id);
    if (!cached || cached.content !== original) {
      const messages = parseTranscriptLines(original.slice(-2 * 1024 * 1024), 1, { toolCall: "", toolResult: "" }).messages;
      cached = { content: original, total: messages.length, messages: messages.slice(-120) };
      parseCache.set(session.id, cached);
    }
    const parsed = cached.messages;
    let remaining = budget;
    let truncated = original.length > 2 * 1024 * 1024 || cached.total > 120;
    const lines: string[] = [];
    for (const message of parsed.slice(-120).reverse()) {
      const encode = (text: string) => JSON.stringify({ type: "assistant", message: { role: message.role, content: text } }) + "\n";
      let line = encode(message.text);
      if (encoder.encode(line).length > remaining) {
        truncated = true;
        if (lines.length) break;
        let low = 0, high = message.text.length;
        while (low < high) {
          const mid = Math.ceil((low + high) / 2);
          if (encoder.encode(encode(message.text.slice(-mid))).length <= remaining) low = mid;
          else high = mid - 1;
        }
        line = encode(message.text.slice(-low));
      }
      remaining -= encoder.encode(line).length;
      lines.unshift(line);
    }
    return {
      sessionId: session.id,
      parentSessionId: session.subagent!.parentSessionId,
      title: session.title.slice(0, 128),
      sourceKind: transcript?.source.kind ?? session.subagent?.source?.kind ?? "pending",
      ended: transcript?.ended ?? false,
      content: lines.join(""),
      truncated,
    };
  });
}
