import type { HistoryMessage, HistorySessionDetail } from "../../../shared/types/index";
import { parseDiffBlocksFromMessages, type ParsedDiffBlock } from "../api/diffParser";
import type { TranslationKey } from "../../../shared/i18n/index";

export type SessionEventKind = "user" | "assistant" | "tool" | "file" | "test" | "error" | "context" | "subtask";

export interface SessionEvent {
  id: string;
  kind: SessionEventKind;
  title: string;
  detail: string;
  messageIndex: number | null;
  timestamp: string | null;
  filePath?: string;
  patch?: string;
  toolName?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface SessionFileChangeGroup {
  filePath: string;
  events: SessionEvent[];
  additions: number;
  deletions: number;
}

export interface SessionProcessModel {
  events: SessionEvent[];
  diffBlocks: ParsedDiffBlock[];
  fileGroups: SessionFileChangeGroup[];
  toolEvents: SessionEvent[];
  errorEvents: SessionEvent[];
  subtaskEvents: SessionEvent[];
}

type Translate = (key: TranslationKey, params?: Record<string, string | number>) => string;

const ERROR_PATTERN = /\b(error|failed|failure|exception|panic|traceback|denied|timeout|timed out|报错|失败|异常)\b/i;
const TEST_PATTERN = /\b(npm run test|npm test|vitest|jest|cargo test|pytest|pnpm test|yarn test|tsc --noEmit|cargo check)\b/i;
const SUBTASK_PATTERN = /\b(SubagentStart|SubagentStop|subagent|子 Agent|子任务|agentId|agentTranscriptPath)\b/i;

const TOOL_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: "shell", pattern: /\b(shell|bash|powershell|cmd|command|exec_command|shell_command)\b/i },
  { label: "read", pattern: /\b(read|Get-Content|cat|sed|file read)\b/i },
  { label: "search", pattern: /\b(rg|grep|search|Select-String|web_search)\b/i },
  { label: "patch", pattern: /\b(apply_patch|Begin Patch|Update File|Add File|Delete File)\b/i },
  { label: "test", pattern: TEST_PATTERN },
];

function compactText(text: string, maxLength = 220): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}…`;
}

function messageTitle(role: string, index: number, t: Translate): string {
  const normalized = role.toLowerCase();
  const displayIndex = index + 1;
  if (normalized === "user") return t("history.events.userMessage", { index: displayIndex });
  if (normalized === "assistant") return t("history.events.assistantReply", { index: displayIndex });
  if (normalized === "tool") return t("history.events.toolResult", { index: displayIndex });
  if (normalized === "system") return t("history.events.systemMessage", { index: displayIndex });
  return t("history.events.genericMessage", { role: normalized || "message", index: displayIndex });
}

function inferMessageKind(message: HistoryMessage): SessionEventKind {
  const role = message.role.toLowerCase();
  if (ERROR_PATTERN.test(message.content)) return "error";
  if (SUBTASK_PATTERN.test(message.content)) return "subtask";
  if (TEST_PATTERN.test(message.content)) return "test";
  if (role === "user") return "user";
  if (role === "assistant") return "assistant";
  if (role === "tool") return "tool";
  return "tool";
}

function inferToolName(content: string): string | undefined {
  for (const item of TOOL_PATTERNS) {
    if (item.pattern.test(content)) return item.label;
  }
  const toolUse = content.match(/(?:调用工具|tool_use|function_call|custom_tool_call)[:：\s]+([\w.-]+)/i);
  return toolUse?.[1];
}

function countPatchLines(patch: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }
  return { additions, deletions };
}

function buildMessageEvents(session: HistorySessionDetail, t: Translate): SessionEvent[] {
  return session.messages.map((message, index) => {
    const input = message.input_tokens ?? 0;
    const output = message.output_tokens ?? 0;
    return {
      id: `message-${index}`,
      kind: inferMessageKind(message),
      title: messageTitle(message.role, index, t),
      detail: compactText(message.content) || t("history.detail.noText"),
      messageIndex: index,
      timestamp: message.timestamp ?? null,
      toolName: inferToolName(message.content),
      inputTokens: input,
      outputTokens: output,
      totalTokens: input + output + (message.cache_read_tokens ?? 0) + (message.cache_creation_tokens ?? 0),
    } satisfies SessionEvent;
  });
}

function buildFileEvents(diffBlocks: ParsedDiffBlock[], t: Translate): SessionEvent[] {
  return diffBlocks.map((block) => {
    const changes = countPatchLines(block.patch);
    return {
      id: `file-${block.id}`,
      kind: "file",
      title: t("history.events.fileChanged", { path: block.filePath }),
      detail: t("history.files.eventFromMessage", {
        index: block.messageIndex + 1,
        additions: changes.additions,
        deletions: changes.deletions,
      }),
      messageIndex: block.messageIndex,
      timestamp: block.timestamp ?? null,
      filePath: block.filePath,
      patch: block.patch,
      totalTokens: changes.additions + changes.deletions,
    } satisfies SessionEvent;
  });
}

function buildContextEvents(session: HistorySessionDetail, t: Translate): SessionEvent[] {
  const trend = session.usage?.token_trend ?? [];
  return trend.map((point, index) => ({
    id: `context-${index}`,
    kind: "context",
    title: t("history.events.tokenDelta", { index: index + 1 }),
    detail: t("history.events.contextDetail", {
      input: point.input_tokens,
      output: point.output_tokens,
      cache: point.cache_read_tokens + point.cache_creation_tokens,
    }),
    messageIndex: null,
    timestamp: null,
    inputTokens: point.input_tokens,
    outputTokens: point.output_tokens,
    totalTokens: point.total_tokens,
  }));
}

function buildFileGroups(fileEvents: SessionEvent[]): SessionFileChangeGroup[] {
  const groups = new Map<string, SessionFileChangeGroup>();
  for (const event of fileEvents) {
    const filePath = event.filePath ?? "unknown-file";
    const current = groups.get(filePath) ?? { filePath, events: [], additions: 0, deletions: 0 };
    current.events.push(event);
    if (event.patch) {
      const changes = countPatchLines(event.patch);
      current.additions += changes.additions;
      current.deletions += changes.deletions;
    }
    groups.set(filePath, current);
  }
  return Array.from(groups.values()).sort((a, b) => b.events.length - a.events.length || a.filePath.localeCompare(b.filePath));
}

export function buildSessionProcessModel(session: HistorySessionDetail | null, t: Translate): SessionProcessModel {
  if (!session) {
    return { events: [], diffBlocks: [], fileGroups: [], toolEvents: [], errorEvents: [], subtaskEvents: [] };
  }

  const diffBlocks = parseDiffBlocksFromMessages(session.messages);
  const messageEvents = buildMessageEvents(session, t);
  const fileEvents = buildFileEvents(diffBlocks, t);
  const contextEvents = buildContextEvents(session, t);
  const events = [...messageEvents, ...fileEvents, ...contextEvents].sort((a, b) => {
    const ai = a.messageIndex ?? Number.MAX_SAFE_INTEGER;
    const bi = b.messageIndex ?? Number.MAX_SAFE_INTEGER;
    if (ai !== bi) return ai - bi;
    return a.id.localeCompare(b.id);
  });

  const toolEvents = events.filter((event) => event.kind === "tool" || event.toolName);
  const errorEvents = events.filter((event) => event.kind === "error");
  const subtaskEvents = events.filter((event) => event.kind === "subtask");

  return {
    events,
    diffBlocks,
    fileGroups: buildFileGroups(fileEvents),
    toolEvents,
    errorEvents,
    subtaskEvents,
  };
}
