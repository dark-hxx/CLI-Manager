export interface RenderedMessage {
  id: number;
  role: string;
  text: string;
}

interface TranscriptLabels { toolCall: string; toolResult: string }

/** 从 Claude transcript 的 message.content（string 或 block 数组）提取可读文本。 */
function extractText(content: unknown, labels: TranscriptLabels): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    const type = typeof b.type === "string" ? b.type : "";
    if ((type === "text" || type === "output_text" || type === "input_text") && typeof b.text === "string") {
      parts.push(b.text);
    } else if (type === "thinking" && typeof b.thinking === "string") {
      parts.push(`💭 ${b.thinking}`);
    } else if (type === "tool_use" && typeof b.name === "string") {
      parts.push(`⚙ ${labels.toolCall ? labels.toolCall + ": " : ""}${b.name}`);
    } else if (type === "function_call" && typeof b.name === "string") {
      const args = typeof b.arguments === "string" && b.arguments.trim() ? `\n${b.arguments}` : "";
      parts.push(`⚙ ${labels.toolCall ? labels.toolCall + ": " : ""}${b.name}${args}`);
    } else if (type === "function_call_output") {
      const output = typeof b.output === "string" ? b.output : "";
      parts.push(output ? `↳ ${labels.toolResult ? labels.toolResult + ": " : ""}${output}` : `↳ ${labels.toolResult}`);
    } else if (type === "tool_result") {
      const inner = b.content;
      const text = typeof inner === "string" ? inner : Array.isArray(inner) ? extractText(inner, labels) : "";
      parts.push(text ? `↳ ${labels.toolResult ? labels.toolResult + ": " : ""}${text}` : `↳ ${labels.toolResult}`);
    }
  }
  return parts.join("\n").trim();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function parseClaudeTranscriptItem(obj: Record<string, unknown>, id: number, labels: TranscriptLabels): RenderedMessage | null {
  const type = typeof obj.type === "string" ? obj.type : "";
  if (type !== "user" && type !== "assistant") return null;
  const message = asRecord(obj.message);
  if (!message) return null;
  const role = typeof message.role === "string" ? message.role : type;
  const text = extractText(message.content, labels);
  if (!text) return null;
  return { id, role, text };
}

function parseCodexResponseItem(obj: Record<string, unknown>, id: number, labels: TranscriptLabels): RenderedMessage | null {
  if (obj.type !== "response_item") return null;
  const payload = asRecord(obj.payload);
  if (!payload) return null;

  const message = asRecord(payload.message) ?? (payload.type === "message" ? payload : null);
  if (message) {
    const role = typeof message.role === "string" ? message.role : "assistant";
    const text = extractText(message.content, labels);
    if (!text) return null;
    return { id, role, text };
  }

  if (payload.type === "function_call" && typeof payload.name === "string") {
    const args = typeof payload.arguments === "string" && payload.arguments.trim() ? `\n${payload.arguments}` : "";
    return { id, role: "tool", text: `⚙ ${labels.toolCall ? labels.toolCall + ": " : ""}${payload.name}${args}` };
  }

  if (payload.type === "function_call_output") {
    const output = typeof payload.output === "string" ? payload.output : "";
    return { id, role: "tool", text: output ? `↳ ${labels.toolResult ? labels.toolResult + ": " : ""}${output}` : `↳ ${labels.toolResult}` };
  }

  return null;
}

/** 逐行解析 jsonl 片段为可渲染消息（跳过解析失败行），id 从 firstId 起连续分配。 */
export function parseTranscriptLines(chunk: string, firstId: number, labels = { toolCall: "调用工具", toolResult: "工具结果" }): { messages: RenderedMessage[]; nextId: number } {
  const out: RenderedMessage[] = [];
  let nextId = firstId;
  for (const line of chunk.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) continue;
    const message = parseClaudeTranscriptItem(obj, nextId, labels) ?? parseCodexResponseItem(obj, nextId, labels);
    if (!message) continue;
    out.push(message);
    nextId += 1;
  }
  return { messages: out, nextId };
}
