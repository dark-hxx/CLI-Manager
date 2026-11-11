const MAX_HEADER_CHARS = 256 * 1024;

/** Keep identity only, never carry base instructions, cwd or inherited history into the prefix. */
function identityPrefix(content: string): string {
  const end = content.indexOf("\n");
  if (end < 0 || end > MAX_HEADER_CHARS) return "";
  try {
    const row = JSON.parse(content.slice(0, end));
    if (row?.type !== "session_meta" || !row.payload) return "";
    const p = row.payload;
    const spawn = p.source?.subagent?.thread_spawn;
    const short = (value: unknown) => typeof value === "string" && value.length <= 512 ? value : undefined;
    const parent = short(p.parent_thread_id) || short(spawn?.parent_thread_id);
    if (!parent) return "";
    return JSON.stringify({ type: "session_meta", payload: {
      id: short(p.id), parent_thread_id: parent, timestamp: short(p.timestamp),
      agent_path: short(p.agent_path) || short(spawn?.agent_path),
    } }) + "\n";
  } catch { return ""; }
}

/** Bounded whole-line tail plus compact authoritative identity; used by Store and both parsers. */
export function boundSubagentTranscript(previous: string, append: string, maxChars: number, reset = false) {
  const before = reset ? "" : previous;
  const total = before.length + append.length;
  if (total <= maxChars) return { content: before + append, droppedChars: 0 };
  const identity = identityPrefix(before || append);
  const prefix = identity.length < maxChars ? identity : "";
  const budget = Math.max(0, maxChars - prefix.length);
  let tail = append.length >= budget ? append.slice(-budget)
    : before.slice(-(budget - append.length)) + append;
  // A cut may be inside a JSON string or a UTF-8/UTF-16 sequence; never feed a partial row.
  const newline = tail.indexOf("\n");
  tail = newline < 0 ? "" : tail.slice(newline + 1);
  const content = prefix + tail;
  return { content, droppedChars: total - content.length };
}
