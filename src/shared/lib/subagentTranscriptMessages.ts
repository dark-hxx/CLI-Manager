export type TranscriptKind = "text" | "context" | "tool_call" | "tool_result" | "reasoning" | "unknown";
export interface RenderedMessage {
  id: number;
  role: string;
  text: string;
  kind: TranscriptKind;
  actor: "parent" | "child" | "unknown";
  phase?: "final" | "progress";
  timestamp?: string;
  notice?: "encrypted";
}

/** Bounded evidence only; never retain a second copy of the transcript. */
export interface TranscriptParserState {
  child?: boolean;
  createdAt?: string;
  turnId?: string;
  metaSeen?: boolean;
  agentPath?: string;
}
interface TranscriptLabels { toolCall: string; toolResult: string }
type RecordValue = Record<string, unknown>;
type Part = { kind: TranscriptKind; text: string };

function asRecord(value: unknown): RecordValue | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : null;
}
function string(value: unknown): string { return typeof value === "string" ? value : ""; }

/** Do not expand binary attachments into the DOM or transport snapshot. */
function readable(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(item => {
    const block = asRecord(item);
    return block ? string(block.text) : string(item);
  }).filter(Boolean).join("\n");
  return value == null ? "" : JSON.stringify(value);
}

function extractText(content: unknown, labels: TranscriptLabels): Part[] {
  if (typeof content === "string") return content.trim() ? [{ kind: "text", text: content }] : [];
  if (!Array.isArray(content)) return [];
  const parts: Part[] = [];
  for (const value of content) {
    const b = asRecord(value);
    if (!b) continue;
    const type = string(b.type);
    let kind: TranscriptKind = "unknown";
    let text = "";
    if (["text", "output_text", "input_text", "summary_text"].includes(type)) {
      kind = "text"; text = string(b.text);
    } else if (["thinking", "reasoning"].includes(type)) {
      kind = "reasoning"; text = string(b.thinking) || readable(b.summary);
    } else if (["tool_use", "function_call", "custom_tool_call"].includes(type)) {
      kind = "tool_call";
      text = [labels.toolCall, string(b.name), readable(b.arguments ?? b.input)].filter(Boolean).join("\n");
    } else if (["tool_result", "function_call_output", "custom_tool_call_output"].includes(type)) {
      kind = "tool_result";
      text = [labels.toolResult, readable(b.output ?? b.content)].filter(Boolean).join("\n") || `[${type}]`;
    } else {
      // Preserve inspectable text for unknown blocks, but not base64/image URLs.
      text = string(b.text) || `[${type || "unknown"}]`;
    }
    if (text.trim()) parts.push({ kind, text });
  }
  return parts;
}

function injected(text: string): boolean {
  return /^(?:#\s*AGENTS\.md instructions for |<INSTRUCTIONS>|<environment_context>|<skills_instructions>|<permissions instructions>|<collaboration_mode>)/i.test(text.trimStart());
}

function messagesFromParts(
  obj: RecordValue, message: RecordValue, parts: Part[], state: TranscriptParserState,
): Omit<RenderedMessage, "id">[] {
  const role = string(message.role) || string(obj.type);
  const meta = asRecord(message.internal_chat_message_metadata_passthrough);
  const turnId = string(meta?.turn_id);
  const timestamp = string(obj.timestamp);
  const older = !!(timestamp && state.createdAt && Date.parse(timestamp) < Date.parse(state.createdAt));
  const inherited = older || !!(state.child && state.turnId && turnId && turnId !== state.turnId);
  const proven = state.child && state.turnId && turnId === state.turnId && !inherited;
  const actor = proven && role === "user" ? "parent" : proven && role === "assistant" ? "child" : "unknown";
  const kinds = Array.isArray(meta?.content_item_kinds) ? meta.content_item_kinds : [];
  return parts.map((part, index) => {
    // Only map per-block provenance when the cardinality actually matches.
    const origin = kinds.length === parts.length ? string(kinds[index]) : "";
    const context = inherited || role === "system" || role === "developer"
      || origin.endsWith(".instructions") || origin === "environments.environment_context"
      || (part.kind === "text" && injected(part.text));
    const kind = context ? "context" : message.channel === "analysis" ? "reasoning" : part.kind;
    const phase = message.phase === "final_answer" || message.channel === "final" ? "final"
      : message.phase === "commentary" || message.channel === "commentary" ? "progress" : undefined;
    return { ...part, kind, role, actor: context ? "unknown" : actor, phase, timestamp: timestamp || undefined };
  });
}

function parseClaudeTranscriptItem(obj: RecordValue, labels: TranscriptLabels, state: TranscriptParserState) {
  if (obj.type !== "user" && obj.type !== "assistant") return [];
  const message = asRecord(obj.message);
  if (!message) return [];
  const parts = extractText(message.content, labels);
  const metadata = asRecord(obj.cliManagerSubagent);
  if (metadata?.version === 1 && metadata.notice === "encrypted" && parts.length === 0) {
    parts.push({ kind: "text", text: "" });
  }
  // Optional versioned snapshot metadata; legacy wrappers remain readable.
  if (metadata?.version === 1 && parts.length === 1
    && ["text", "context", "tool_call", "tool_result", "reasoning", "unknown"].includes(string(metadata.kind))
    && ["parent", "child", "unknown"].includes(string(metadata.actor))) {
    return [{ ...parts[0], role: string(message.role) || string(obj.type),
      kind: metadata.kind as TranscriptKind, actor: metadata.actor as RenderedMessage["actor"],
      phase: metadata.phase === "final" || metadata.phase === "progress" ? metadata.phase : undefined,
      timestamp: typeof metadata.timestamp === "string" ? metadata.timestamp : undefined,
      ...(metadata.notice === "encrypted" ? { notice: "encrypted" as const } : {}),
    } satisfies Omit<RenderedMessage, "id">];
  }
  return messagesFromParts(obj, message, parts, state);
}

function parseCodexResponseItem(obj: RecordValue, labels: TranscriptLabels, state: TranscriptParserState) {
  if (obj.type !== "response_item") return [];
  const payload = asRecord(obj.payload);
  if (!payload) return [];
  if (payload.type === "agent_message") return parseAgentMessage(obj, payload, labels, state);
  const message = asRecord(payload.message) ?? (payload.type === "message" ? payload : null);
  if (message) return messagesFromParts(obj, message, extractText(message.content, labels), state);
  const kind = string(payload.type);
  if (!["function_call", "custom_tool_call", "function_call_output", "custom_tool_call_output", "reasoning"].includes(kind)) return [];
  return messagesFromParts(obj, { ...payload, role: "tool" }, extractText([payload], labels), state);
}

function agentPath(value: unknown): string {
  const path = string(value);
  return path.length <= 512 && /^\/root(?:\/[a-zA-Z0-9_-]+)*$/.test(path) ? path : "";
}

/** v2 communication has explicit endpoints; a role alone never proves its author. */
function parseAgentMessage(obj: RecordValue, payload: RecordValue, labels: TranscriptLabels, state: TranscriptParserState) {
  const author = agentPath(payload.author), recipient = agentPath(payload.recipient);
  const current = state.agentPath;
  const incoming = !!(current && recipient === current && author && author !== current);
  const outgoing = !!(current && author === current && recipient && recipient !== current);
  const parent = current?.slice(0, current.lastIndexOf("/"));
  const role = outgoing ? "assistant" : "user";
  const content = Array.isArray(payload.content) ? payload.content : [];
  const encrypted = content.some(value => asRecord(value)?.type === "encrypted_content");
  let messageType = "";
  const parts = extractText(typeof payload.content === "string" ? payload.content
    : content.filter(value => asRecord(value)?.type !== "encrypted_content"), labels).map(part => {
    // Remove only the verified transport envelope, not arbitrary task text.
    const envelope = /^Message Type: ([A-Z_]+)\nTask name: ([^\n]+)\nSender: ([^\n]+)\nPayload:\n/.exec(part.text);
    if (part.kind !== "text" || !envelope || envelope[3] !== author
      || (envelope[2] !== author && envelope[2] !== recipient)) return part;
    messageType = envelope[1];
    return { ...part, text: part.text.slice(envelope[0].length) };
  }).filter(part => part.text.trim());
  if (encrypted && !parts.some(part => part.kind === "text")) parts.unshift({ kind: "text", text: "" });
  const messages = messagesFromParts(obj, { ...payload, role }, parts, state);
  let noticeAdded = false;
  return messages.map(message => {
    const unrelated = !!(current && author && recipient && !incoming && !outgoing);
    const context = unrelated || message.kind === "context";
    const actor = context ? "unknown" : state.child && incoming && author === parent ? "parent"
      : state.child && outgoing ? "child" : "unknown";
    const notice = encrypted && message.kind === "text" && !noticeAdded ? "encrypted" : undefined;
    if (notice) noticeAdded = true;
    return { ...message, kind: context ? "context" : message.kind, actor,
      phase: messageType === "FINAL_ANSWER" ? "final" : message.phase, notice,
    } satisfies Omit<RenderedMessage, "id">;
  });
}

/** Complete JSONL lines only. Callers carry state across appends and discard it on reset/head trimming. */
export function parseTranscriptLines(
  chunk: string, firstId: number, labels = { toolCall: "", toolResult: "" }, previous: TranscriptParserState = {},
): { messages: RenderedMessage[]; nextId: number; state: TranscriptParserState } {
  const messages: RenderedMessage[] = [];
  const state = { ...previous };
  let nextId = firstId;
  for (const line of chunk.split("\n")) {
    let obj: RecordValue | null;
    try { obj = asRecord(JSON.parse(line)); } catch { continue; }
    if (!obj) continue;
    const payload = asRecord(obj.payload);
    if (obj.type === "session_meta" && !state.metaSeen) {
      const spawn = asRecord(asRecord(asRecord(payload?.source)?.subagent)?.thread_spawn);
      state.metaSeen = true;
      state.child = !!(string(spawn?.parent_thread_id) || string(payload?.parent_thread_id));
      state.createdAt = string(payload?.timestamp) || undefined;
      state.agentPath = agentPath(payload?.agent_path) || agentPath(spawn?.agent_path) || undefined;
      state.turnId = undefined;
    } else if (obj.type === "event_msg" && payload?.type === "task_started") {
      const attribution = asRecord(payload.turn_attribution);
      state.turnId = state.child && string(attribution?.parent_turn_id)
        ? string(attribution?.turn_id) || string(payload.turn_id) : undefined;
    }
    // event_msg duplicates response_item text; only its attribution is consumed.
    const parts = obj.type === "response_item" ? parseCodexResponseItem(obj, labels, state)
      : parseClaudeTranscriptItem(obj, labels, state);
    const snapshot = asRecord(obj.cliManagerSubagent);
    for (const part of parts) {
      // Stable source coordinates keep expanded rows attached to the same entry
      // when a bounded Web snapshot drops older rows from its front.
      const sourceId = snapshot?.version === 1 && Number.isSafeInteger(snapshot.sourceId)
        && Number(snapshot.sourceId) > 0 && parts.length === 1 ? Number(snapshot.sourceId) : nextId;
      messages.push({ ...part, id: sourceId });
      nextId = Math.max(nextId + 1, sourceId + 1);
    }
  }
  return { messages, nextId, state };
}
