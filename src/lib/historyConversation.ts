import type {
  HistoryMessage,
  HistoryMessagePart,
  HistoryMessagePartKind,
} from "./types";

const INJECTED_PROMPT_MARKERS = [
  "<system-reminder",
  "<codex_internal_context",
  "<session-context",
  "<skills_instructions",
  "<permissions instructions",
  "<environment_context>",
  "<collaboration_mode>",
  "<workflow-state:",
  "### available skills",
] as const;

export function isInjectedPromptContent(content: string): boolean {
  const trimmed = content.trimStart();
  const lowerTrimmed = trimmed.toLowerCase();
  const firstLine = lowerTrimmed.split(/\r?\n/, 1)[0]?.replace(/^#+\s*/, "").trim() ?? "";
  return (
    firstLine.startsWith("agents.md instructions for ")
    || firstLine.startsWith("base directory for this skill:")
    || firstLine.startsWith("base directory for this skill ")
    || firstLine.startsWith("system prompt")
    || firstLine.startsWith("developer instructions")
    || INJECTED_PROMPT_MARKERS.some((marker) => lowerTrimmed.includes(marker))
  );
}

export function normalizeHistoryMessageRole(role: string): "user" | "assistant" | "other" {
  const normalized = role.toLowerCase();
  if (normalized === "user" || normalized.includes("human")) return "user";
  if (normalized === "assistant" || normalized.includes("model") || normalized.includes("llm")) return "assistant";
  return "other";
}

export function fallbackHistoryMessageParts(message: HistoryMessage): HistoryMessagePart[] {
  const role = normalizeHistoryMessageRole(message.role);
  let kind: HistoryMessagePartKind = "unknown";
  if (isInjectedPromptContent(message.content)) kind = "system";
  else if (role === "user" || role === "assistant") kind = "text";
  else if (message.role.toLowerCase().includes("tool")) kind = "tool_result";
  else if (message.role.toLowerCase().includes("system")) kind = "system";
  return [{ kind, content: message.content }];
}

export function effectiveHistoryMessageParts(message: HistoryMessage): HistoryMessagePart[] {
  return message.parts?.length ? message.parts : fallbackHistoryMessageParts(message);
}

export function isConversationVisibleMessage(message: HistoryMessage): boolean {
  const role = normalizeHistoryMessageRole(message.role);
  if (role !== "user" && role !== "assistant") return false;
  return effectiveHistoryMessageParts(message).some(
    (part) => part.kind === "text" && part.content.trim().length > 0,
  );
}

export function conversationText(message: HistoryMessage): string {
  return effectiveHistoryMessageParts(message)
    .filter((part) => part.kind === "text")
    .map((part) => part.content.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();
}
