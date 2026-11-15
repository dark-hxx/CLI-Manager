import type {
  HistoryFileChangeOperation,
  HistoryFileChangeSummary,
  HistoryMessage,
  HistorySessionDetail,
  HistoryToolEvent,
} from "../../../shared/types/index";
import type { ReplayEvent, ReplayEventStatus } from "../api/replayStore";

export type ReplayProgressStatus = ReplayEventStatus | "incomplete";
export type ReplayProgressStepKind =
  | "tool"
  | "mcp"
  | "skill"
  | "validation"
  | "file"
  | "subtask"
  | "permission"
  | "notification"
  | "snapshot"
  | "error";

// 面向阅读的活动类别：同一工具名（如 exec_command）会按实际命令再细分。
export type ReplayProgressActivity =
  | "read"
  | "edit"
  | "search"
  | "command"
  | "web"
  | "plan"
  | "validation"
  | "mcp"
  | "skill"
  | "subtask"
  | "permission"
  | "notification"
  | "snapshot"
  | "error"
  | "file"
  | "other";

export interface ReplayProgressStep {
  id: string;
  kind: ReplayProgressStepKind;
  activity: ReplayProgressActivity;
  target: string | null;
  title: string;
  summary: string;
  status: ReplayProgressStatus;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  sourceLabel: string | null;
  inputSummary: string | null;
  outputSummary: string | null;
  rawEvents: ReplayEvent[];
  files: HistoryFileChangeSummary[];
  snapshotEvent: ReplayEvent | null;
}

export interface ReplayProgressPhase {
  id: string;
  activity: ReplayProgressActivity;
  status: ReplayProgressStatus;
  startedAt: string | null;
  endedAt: string | null;
  steps: ReplayProgressStep[];
  failed: number;
}

export interface ReplayProgressTurn {
  id: string;
  // 用户输入在历史会话 messages 中的下标；仅有 Hook 数据时为 null。
  messageIndex: number | null;
  prompt: string;
  images: number;
  response: string | null;
  assistantMessages: HistoryMessage[];
  status: ReplayProgressStatus;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  steps: ReplayProgressStep[];
  phases: ReplayProgressPhase[];
  replayEvents: ReplayEvent[];
  activityCounts: Partial<Record<ReplayProgressActivity, number>>;
  counts: {
    tools: number;
    files: number;
    validations: number;
    subtasks: number;
    errors: number;
  };
}

export interface ReplayProgressModel {
  turns: ReplayProgressTurn[];
  current: {
    title: string;
    summary: string;
    status: ReplayProgressStatus;
    timestamp: string | null;
  } | null;
  counts: {
    turns: number;
    tools: number;
    files: number;
    validations: number;
    errors: number;
    workMs: number;
  };
}

interface MutableTurn extends ReplayProgressTurn {
  historyIndex: number;
  replayPromptIndex: number | null;
}

interface MutableStep extends ReplayProgressStep {
  turnIndex: number;
  order: number;
}

interface PromptTurnLink {
  eventIndex: number;
  turnIndex: number;
}

interface UserPromptInfo {
  text: string;
  images: number;
  localOutput: string | null;
}

// CLI 注入到用户消息里的上下文块，不属于用户真实输入。
const PROMPT_NOISE_TAGS = [
  "system-reminder",
  "local-command-caveat",
  "local-command-stdout",
  "local-command-stderr",
  "command-name",
  "command-message",
  "command-args",
  "session-context",
  "current-state",
  "workflow",
  "codex_internal_context",
  "environment_context",
  "user_instructions",
  "user-prompt-submit-hook",
  "ide_selection",
  "ide_opened_file",
  "bash-input",
  "bash-stdout",
  "bash-stderr",
];
const INJECTED_PROMPT_LINE = /^#*\s*(?:agents\.md instructions for |base directory for this skill|system prompt|developer instructions)/i;

function tagContent(text: string, tag: string): string | null {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i").exec(text);
  return match ? match[1].trim() : null;
}

// 从一条用户消息中还原用户真实输入：去掉注入上下文与图片占位，斜杠命令还原为 `/cmd args`。
export function cleanUserPromptText(raw: string | null | undefined): UserPromptInfo {
  let text = (raw ?? "").replace(/\r\n?/g, "\n");
  const localOutput = tagContent(text, "local-command-stdout") ?? tagContent(text, "local-command-stderr");
  const commandName = tagContent(text, "command-name");
  const commandArgs = tagContent(text, "command-args");
  const bashInput = tagContent(text, "bash-input");

  const imageNumbers = new Set([...text.matchAll(/\[Image #(\d+)\]/gi)].map((match) => match[1]));
  const sourceImages = [...text.matchAll(/\[Image:\s*source:[^\]]*\]/gi)].length;
  const images = Math.max(imageNumbers.size, sourceImages);
  text = text.replace(/\[Image(?: #\d+|:\s*source:[^\]]*)\]/gi, " ").replace(/<\/?image\b[^>]*>/gi, " ");

  for (const tag of PROMPT_NOISE_TAGS) {
    text = text
      .replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, "gi"), " ")
      .replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*$`, "i"), " ");
  }
  text = text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  if (INJECTED_PROMPT_LINE.test(text.split("\n", 1)[0] ?? "")) text = "";

  if (commandName) {
    const command = commandName.startsWith("/") ? commandName : `/${commandName}`;
    text = [command, commandArgs, text].filter(Boolean).join(" ");
  } else if (bashInput) {
    text = `! ${bashInput}`;
  }
  return { text, images, localOutput: text ? null : localOutput };
}

function extractHistoryUserPrompt(message: HistoryMessage): UserPromptInfo {
  const parts = message.parts ?? [];
  if (parts.length > 0 && !parts.some((part) => part.kind === "text")) {
    return { text: "", images: 0, localOutput: null };
  }
  const content = parts.length > 0
    ? parts.filter((part) => part.kind === "text").map((part) => part.content).join("\n\n")
    : message.content;
  return cleanUserPromptText(content);
}

function promptMatchKey(text: string): string {
  return text.replace(/\s+/g, "").slice(0, 40).toLowerCase();
}

function promptKeysMatch(left: string, right: string): boolean {
  if (!left || !right) return false;
  return left === right || (Math.min(left.length, right.length) >= 6 && (left.startsWith(right) || right.startsWith(left)));
}

const VALIDATION_PATTERN = /\b(?:npm\s+(?:run\s+)?(?:test|build|lint)|pnpm\s+(?:run\s+)?(?:test|build|lint)|yarn\s+(?:test|build|lint)|npx\s+tsc(?:\s+--noEmit)?|tsc\s+--noEmit|vitest|jest|pytest|cargo\s+(?:check|test|clippy|build)|go\s+test|dotnet\s+test|mvn\s+(?:test|verify)|gradle\s+test)\b/i;

const READ_TOOL_PATTERN = /^(?:read|read_file|readfile|view|view_image|notebookread|ls|list_dir|list_directory)$/i;
const EDIT_TOOL_PATTERN = /^(?:edit|multiedit|write|write_file|create_file|apply_patch|notebookedit|str_replace(?:_editor)?|replace)$/i;
const SEARCH_TOOL_PATTERN = /^(?:grep|glob|search|find|file_search|codebase_search|search_files)$/i;
const WEB_TOOL_PATTERN = /^(?:webfetch|websearch|web_search|web_fetch|fetch)$/i;
const COMMAND_TOOL_PATTERN = /^(?:bash|shell|exec_command|local_shell|container\.exec|powershell|write_stdin|run_command|run_terminal_cmd|terminal)$/i;
const PLAN_TOOL_PATTERN = /^(?:todowrite|todoread|update_plan|exitplanmode|enterplanmode)$/i;
const SUBTASK_TOOL_PATTERN = /^(?:task|agent)$/i;
const READ_COMMAND_PATTERN = /^(?:cat|head|tail|less|more|nl|sed\s+-n|type|get-content|gc|bat|wc|stat)\b/i;
const SEARCH_COMMAND_PATTERN = /^(?:rg|grep|egrep|find|fd|ls|dir|tree|get-childitem|gci|select-string|git\s+(?:grep|ls-files))\b/i;
const SHELL_WRAPPER_PATTERN = /^(?:(?:bash|sh|zsh)\s+-l?c|(?:powershell|pwsh)(?:\.exe)?(?:\s+-\w+)*?\s+-command|cmd(?:\.exe)?\s+\/c)\s+/i;
const PHASE_ISOLATED: ReadonlySet<ReplayProgressActivity> = new Set(["snapshot", "error", "permission", "notification", "subtask"]);

function unquote(value: string): string {
  const trimmed = value.trim();
  const quote = trimmed[0];
  if (trimmed.length >= 2 && (quote === "\"" || quote === "'") && trimmed.endsWith(quote)) return trimmed.slice(1, -1);
  return trimmed;
}

function decodeJsonString(raw: string): string {
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return raw;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 输入摘要可能被截断成非法 JSON：先整体解析，失败再按字段名正则提取字符串或字符串数组的末项。
function readInputField(input: string | null, keys: string[]): string | null {
  const trimmed = input?.trim();
  if (!trimmed?.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    for (const key of keys) {
      const value = parsed[key];
      if (typeof value === "string" && value.trim()) return value.trim();
      if (Array.isArray(value)) {
        const parts = value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()));
        if (parts.length > 0) return parts[parts.length - 1].trim();
      }
    }
    return null;
  } catch {
    // 截断 JSON 走正则兜底。
  }
  for (const key of keys) {
    const field = escapeRegExp(key);
    const stringMatch = new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(trimmed);
    if (stringMatch?.[1]) return decodeJsonString(stringMatch[1]).trim();
    const arrayMatch = new RegExp(`"${field}"\\s*:\\s*\\[([^\\]]*)`).exec(trimmed);
    if (arrayMatch?.[1]) {
      const parts = [...arrayMatch[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) => decodeJsonString(match[1]));
      if (parts.length > 0) return parts[parts.length - 1].trim();
    }
  }
  return null;
}

function stripShellWrapper(command: string): string {
  let result = command.trim();
  for (let index = 0; index < 2; index += 1) {
    const next = result.replace(SHELL_WRAPPER_PATTERN, "");
    if (next === result) break;
    result = unquote(next);
  }
  return result;
}

function extractCommand(step: Pick<ReplayProgressStep, "inputSummary">): string | null {
  const command = readInputField(step.inputSummary, ["cmd", "command", "commandLine", "script"]);
  if (command) return stripShellWrapper(command);
  const raw = step.inputSummary?.trim();
  return raw && !raw.startsWith("{") ? stripShellWrapper(raw) : null;
}

function extractPatchFiles(input: string | null): string[] {
  if (!input) return [];
  const text = input.replace(/\\n/g, "\n");
  return [...text.matchAll(/\*\*\* (?:Update|Add|Delete) File: ([^\n"*]+)/g)].map((match) => match[1].trim());
}

function classifyToolActivity(step: ReplayProgressStep): ReplayProgressActivity {
  const name = step.title.trim();
  if (READ_TOOL_PATTERN.test(name)) return "read";
  if (EDIT_TOOL_PATTERN.test(name)) return "edit";
  if (SEARCH_TOOL_PATTERN.test(name)) return "search";
  if (WEB_TOOL_PATTERN.test(name)) return "web";
  if (PLAN_TOOL_PATTERN.test(name)) return "plan";
  if (SUBTASK_TOOL_PATTERN.test(name)) return "subtask";
  if (!COMMAND_TOOL_PATTERN.test(name)) return "other";
  const command = extractCommand(step) ?? "";
  if (/\bapply_patch\b/.test(command)) return "edit";
  if (SEARCH_COMMAND_PATTERN.test(command)) return "search";
  if (READ_COMMAND_PATTERN.test(command)) return "read";
  return "command";
}

function extractStepTarget(step: ReplayProgressStep): string | null {
  switch (step.activity) {
    case "command":
    case "validation":
      return extractCommand(step);
    case "read":
    case "edit": {
      const patchFiles = extractPatchFiles(step.inputSummary);
      if (patchFiles.length > 0) return patchFiles.join(", ");
      return readInputField(step.inputSummary, ["file_path", "path", "notebook_path", "file", "filename", "target_file"])
        ?? extractCommand(step);
    }
    case "search":
      return readInputField(step.inputSummary, ["pattern", "query", "regex", "glob"]) ?? extractCommand(step);
    case "web":
      return readInputField(step.inputSummary, ["url", "query", "q"]);
    case "subtask":
      return readInputField(step.inputSummary, ["description", "prompt"]) ?? step.inputSummary;
    case "file":
      return step.files.length === 1 ? step.files[0].file_path : null;
    case "plan":
      return null;
    default:
      return readInputField(step.inputSummary, ["description", "query", "path", "url"]);
  }
}

function phaseStatus(steps: ReplayProgressStep[]): ReplayProgressStatus {
  for (const status of ["running", "failed", "attention", "incomplete"] as const) {
    if (steps.some((step) => step.status === status)) return status;
  }
  return steps[steps.length - 1]?.status ?? "completed";
}

// 连续同类活动合并为一个阶段；快照、异常、权限、子任务等关键节点始终单独成段。
function buildPhases(steps: ReplayProgressStep[]): ReplayProgressPhase[] {
  const groups: ReplayProgressStep[][] = [];
  for (const step of steps) {
    if (step.activity === "file") continue;
    const previous = groups[groups.length - 1];
    const head = previous?.[0];
    if (head && head.activity === step.activity && !PHASE_ISOLATED.has(step.activity) && head.sourceLabel === step.sourceLabel) {
      previous.push(step);
    } else {
      groups.push([step]);
    }
  }
  return groups.map((group) => {
    const ended = [...group].reverse().find((step) => step.endedAt ?? step.startedAt);
    return {
      id: `phase-${group[0].id}`,
      activity: group[0].activity,
      status: phaseStatus(group),
      startedAt: group.find((step) => step.startedAt)?.startedAt ?? null,
      endedAt: ended?.endedAt ?? ended?.startedAt ?? null,
      steps: group,
      failed: group.filter((step) => step.status === "failed").length,
    };
  });
}

function compactText(value: string | null | undefined, maxLength = 180): string {
  const normalized = value?.replace(/\s+/g, " ").trim() ?? "";
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

function payloadString(event: ReplayEvent | null | undefined, key: string): string | null {
  const value = event?.payload?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function replayEventName(event: ReplayEvent): string {
  return payloadString(event, "event") ?? "";
}

function timestampMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function durationBetween(startedAt: string | null, endedAt: string | null): number | null {
  const start = timestampMs(startedAt);
  const end = timestampMs(endedAt);
  if (start === null || end === null) return null;
  return Math.max(0, end - start);
}

function sourceLabelFromHistory(tool: HistoryToolEvent): string | null {
  if (tool.category.startsWith("mcp:")) return tool.category.slice(4);
  if (tool.category === "skill") return tool.name;
  return null;
}

function isValidationTool(name: string, input: string | null, output: string | null): boolean {
  return VALIDATION_PATTERN.test(`${name} ${input ?? ""} ${output ?? ""}`);
}

function historyTurnIndexForMessage(messageTurnIndexes: number[], messageIndex: number | null | undefined): number {
  if (messageTurnIndexes.length === 0) return 0;
  if (messageIndex === null || messageIndex === undefined) return messageTurnIndexes.length - 1;
  return messageTurnIndexes[messageIndex] ?? messageTurnIndexes.length - 1;
}

function replayTurnIndexForEvent(promptTurns: PromptTurnLink[], event: ReplayEvent): number {
  let result = 0;
  for (const link of promptTurns) {
    if (link.eventIndex > event.eventIndex) break;
    result = link.turnIndex;
  }
  return result;
}

function groupFileChangesByTurn(
  fileChanges: HistoryFileChangeSummary[],
  messageTurnIndexes: number[],
  turnCount: number
): Map<number, HistoryFileChangeSummary[]> {
  const grouped = new Map<number, Map<string, HistoryFileChangeSummary>>();

  const append = (turnIndex: number, summary: HistoryFileChangeSummary, operation: HistoryFileChangeOperation | null) => {
    const safeTurnIndex = Math.max(0, Math.min(turnCount - 1, turnIndex));
    const files = grouped.get(safeTurnIndex) ?? new Map<string, HistoryFileChangeSummary>();
    const current = files.get(summary.file_path) ?? {
      ...summary,
      additions: 0,
      deletions: 0,
      operations: [],
    };
    if (operation) {
      current.additions += operation.additions;
      current.deletions += operation.deletions;
      current.operations.push(operation);
      current.latest_message_index = operation.message_index ?? current.latest_message_index ?? null;
      current.latest_operation_group_index = operation.operation_group_index ?? current.latest_operation_group_index ?? null;
      current.latest_timestamp = operation.timestamp ?? current.latest_timestamp ?? null;
    } else {
      current.additions += summary.additions;
      current.deletions += summary.deletions;
      current.operations = summary.operations;
    }
    files.set(summary.file_path, current);
    grouped.set(safeTurnIndex, files);
  };

  for (const summary of fileChanges) {
    if (summary.operations.length === 0) {
      append(historyTurnIndexForMessage(messageTurnIndexes, summary.latest_message_index), summary, null);
      continue;
    }
    for (const operation of summary.operations) {
      append(historyTurnIndexForMessage(messageTurnIndexes, operation.message_index), summary, operation);
    }
  }

  return new Map(
    Array.from(grouped.entries()).map(([turnIndex, files]) => [
      turnIndex,
      Array.from(files.values()).sort((a, b) => a.file_path.localeCompare(b.file_path)),
    ])
  );
}

function buildTurns(events: ReplayEvent[], historyDetail: HistorySessionDetail | null): {
  turns: MutableTurn[];
  messageTurnIndexes: number[];
  promptTurns: PromptTurnLink[];
} {
  const promptEvents = events.filter((event) => event.kind === "prompt");
  const historyTurns: Array<{ prompt: HistoryMessage; messageIndex: number; info: UserPromptInfo; assistants: HistoryMessage[]; localOutput: string | null }> = [];
  const messageTurnIndexes: number[] = [];

  for (const [messageIndex, message] of (historyDetail?.messages ?? []).entries()) {
    const role = message.role.toLowerCase();
    if (role === "user") {
      const info = extractHistoryUserPrompt(message);
      const last = historyTurns[historyTurns.length - 1];
      if (info.text || info.images > 0) {
        historyTurns.push({ prompt: message, messageIndex, info, assistants: [], localOutput: null });
      } else if (info.localOutput && last && !last.localOutput) {
        // 斜杠命令的本地输出（如 /model 的结果）作为该命令轮次的回复。
        last.localOutput = info.localOutput;
      }
    } else if (role === "assistant" && historyTurns.length > 0) {
      historyTurns[historyTurns.length - 1].assistants.push(message);
    }
    messageTurnIndexes[messageIndex] = Math.max(0, historyTurns.length - 1);
  }

  // Hook 的 prompt 不一定与历史中的每个用户轮一一对应（本地斜杠命令没有 Hook），按文本对齐，失败再顺延。
  const promptTurns: PromptTurnLink[] = [];
  const promptByTurn = new Map<number, { event: ReplayEvent; info: UserPromptInfo }>();
  const extraPrompts: Array<{ event: ReplayEvent; info: UserPromptInfo }> = [];
  let cursor = -1;
  for (const event of promptEvents) {
    const info = cleanUserPromptText(payloadString(event, "message") ?? event.detail ?? event.title);
    const key = promptMatchKey(info.text);
    let matched = -1;
    if (key) {
      for (let index = cursor + 1; index < historyTurns.length; index += 1) {
        if (promptKeysMatch(key, promptMatchKey(historyTurns[index].info.text))) {
          matched = index;
          break;
        }
      }
    }
    if (matched < 0 && cursor + 1 < historyTurns.length) matched = cursor + 1;
    if (matched >= 0) {
      cursor = matched;
      promptByTurn.set(matched, { event, info });
      promptTurns.push({ eventIndex: event.eventIndex, turnIndex: matched });
    } else {
      extraPrompts.push({ event, info });
      promptTurns.push({ eventIndex: event.eventIndex, turnIndex: historyTurns.length + extraPrompts.length - 1 });
    }
  }

  const count = Math.max(
    historyTurns.length + extraPrompts.length,
    events.length > 0 || Boolean(historyDetail?.messages.length) ? 1 : 0
  );
  const turns: MutableTurn[] = [];
  for (let index = 0; index < count; index += 1) {
    const historyTurn = historyTurns[index];
    const replay = historyTurn ? promptByTurn.get(index) : extraPrompts[index - historyTurns.length];
    const replayPrompt = replay?.event;
    const info = historyTurn?.info ?? replay?.info ?? cleanUserPromptText(events[0]?.detail ?? events[0]?.title);
    const assistantMessages = historyTurn?.assistants ?? [];
    const lastAssistant = assistantMessages[assistantMessages.length - 1]?.content ?? historyTurn?.localOutput ?? null;
    turns.push({
      id: replayPrompt ? `turn-${replayPrompt.eventIndex}` : `turn-history-${index}`,
      messageIndex: historyTurn?.messageIndex ?? null,
      historyIndex: index,
      replayPromptIndex: replayPrompt?.eventIndex ?? null,
      replayEvents: [],
      prompt: compactText(info.text, 600),
      images: info.images,
      response: lastAssistant ? compactText(lastAssistant, 600) : null,
      assistantMessages,
      status: "incomplete",
      startedAt: historyTurn?.prompt.timestamp ?? replayPrompt?.timestamp ?? null,
      endedAt: assistantMessages[assistantMessages.length - 1]?.timestamp ?? null,
      durationMs: null,
      steps: [],
      phases: [],
      activityCounts: {},
      counts: { tools: 0, files: 0, validations: 0, subtasks: 0, errors: 0 },
    });
  }

  for (const event of events) {
    const turnIndex = Math.min(turns.length - 1, replayTurnIndexForEvent(promptTurns, event));
    turns[turnIndex]?.replayEvents.push(event);
  }

  return { turns, messageTurnIndexes, promptTurns };
}

function createHistoryToolStep(tool: HistoryToolEvent, turnIndex: number, order: number): MutableStep {
  const sourceLabel = sourceLabelFromHistory(tool);
  const kind: ReplayProgressStepKind = tool.category.startsWith("mcp:")
    ? "mcp"
    : tool.category === "skill"
      ? "skill"
      : isValidationTool(tool.name, tool.input_summary ?? null, tool.output_summary ?? null)
        ? "validation"
        : "tool";
  return {
    id: tool.call_id ? `tool-${tool.call_id}` : `history-tool-${turnIndex}-${order}`,
    turnIndex,
    order,
    kind,
    activity: kind === "tool" ? "other" : kind,
    target: null,
    title: tool.name,
    summary: compactText(tool.output_summary ?? tool.input_summary ?? tool.name),
    status: tool.status === "failed" ? "failed" : tool.status === "completed" || Boolean(tool.output_summary) ? "completed" : "running",
    startedAt: tool.timestamp ?? null,
    endedAt: tool.status === "completed" || tool.status === "failed" ? tool.timestamp ?? null : null,
    durationMs: tool.duration_ms ?? null,
    sourceLabel,
    inputSummary: tool.input_summary ?? null,
    outputSummary: tool.output_summary ?? null,
    rawEvents: [],
    files: [],
    snapshotEvent: null,
  };
}

function applyReplayToolEvent(step: MutableStep, event: ReplayEvent): void {
  const name = replayEventName(event);
  const toolName = payloadString(event, "toolName");
  const mcpServer = payloadString(event, "mcpServer");
  const skillName = payloadString(event, "skillName");
  step.rawEvents.push(event);
  step.title = toolName ?? step.title ?? event.title;
  step.sourceLabel = mcpServer ?? skillName ?? step.sourceLabel;
  if (mcpServer) step.kind = "mcp";
  else if (skillName) step.kind = "skill";
  if (!step.inputSummary) step.inputSummary = payloadString(event, "message");
  if (!step.summary) step.summary = compactText(event.detail || event.title);

  if (name.endsWith("Start")) {
    step.startedAt = step.startedAt ?? event.timestamp;
    step.status = "running";
  } else if (name.endsWith("Stop")) {
    step.endedAt = event.timestamp;
    step.status = event.status === "failed" ? "failed" : "completed";
  } else {
    step.startedAt = step.startedAt ?? event.timestamp;
    step.status = event.status;
  }
  step.durationMs = event.durationMs ?? step.durationMs ?? durationBetween(step.startedAt, step.endedAt);
  if (step.kind === "tool" && isValidationTool(step.title, step.inputSummary, step.outputSummary)) {
    step.kind = "validation";
  }
}

function finalizeTurns(turns: MutableTurn[], steps: MutableStep[]): ReplayProgressTurn[] {
  for (const step of steps) turns[step.turnIndex]?.steps.push(step);

  for (const [turnIndex, turn] of turns.entries()) {
    const mutableSteps = turn.steps as MutableStep[];
    const latestTurn = turnIndex === turns.length - 1;
    if (!latestTurn) {
      for (const step of mutableSteps) {
        if (step.status === "running") step.status = "incomplete";
      }
    }
    mutableSteps.sort((a, b) => {
      const at = timestampMs(a.startedAt) ?? a.order;
      const bt = timestampMs(b.startedAt) ?? b.order;
      return at - bt || a.order - b.order;
    });
    const stopFailure = turn.replayEvents.find((event) => replayEventName(event) === "StopFailure");
    const stop = [...turn.replayEvents].reverse().find((event) => replayEventName(event) === "Stop");
    const running = turn.steps.some((step) => step.status === "running");
    const failed = Boolean(stopFailure) || turn.steps.some((step) => step.status === "failed" || step.kind === "error");
    turn.status = failed
      ? "failed"
      : latestTurn && running
        ? "running"
        : stop || turn.response || !latestTurn
          ? "completed"
          : "incomplete";
    turn.endedAt = stopFailure?.timestamp ?? stop?.timestamp ?? turn.endedAt;
    turn.durationMs = durationBetween(turn.startedAt, turn.endedAt);
    for (const step of turn.steps) {
      step.activity = step.kind === "tool" ? classifyToolActivity(step) : step.kind;
      step.target = extractStepTarget(step);
    }
    turn.phases = buildPhases(turn.steps);
    const activityCounts: Partial<Record<ReplayProgressActivity, number>> = {};
    for (const step of turn.steps) {
      if (step.activity !== "file") activityCounts[step.activity] = (activityCounts[step.activity] ?? 0) + 1;
    }
    turn.activityCounts = activityCounts;
    const filePaths = new Set(turn.steps.flatMap((step) => step.files.map((file) => file.file_path)));
    turn.counts = {
      tools: turn.steps.filter((step) => step.kind === "tool" || step.kind === "mcp" || step.kind === "skill").length,
      files: filePaths.size,
      validations: turn.steps.filter((step) => step.kind === "validation").length,
      subtasks: turn.steps.filter((step) => step.kind === "subtask").length,
      errors: turn.steps.filter((step) => step.kind === "error" || step.status === "failed").length,
    };
  }

  return [...turns].reverse();
}

export function buildReplayProgressModel(
  events: ReplayEvent[],
  historyDetail: HistorySessionDetail | null,
  sessionStatus: ReplayEventStatus | null = null
): ReplayProgressModel {
  if (events.length === 0 && !historyDetail?.messages.length) {
    return { turns: [], current: null, counts: { turns: 0, tools: 0, files: 0, validations: 0, errors: 0, workMs: 0 } };
  }

  const sortedEvents = [...events].sort((a, b) => a.eventIndex - b.eventIndex);
  const { turns, messageTurnIndexes, promptTurns } = buildTurns(sortedEvents, historyDetail);
  const steps: MutableStep[] = [];
  const toolStepsByCallId = new Map<string, MutableStep>();

  for (const [index, tool] of (historyDetail?.tool_events ?? []).entries()) {
    const turnIndex = Math.min(turns.length - 1, historyTurnIndexForMessage(messageTurnIndexes, tool.message_index));
    const step = createHistoryToolStep(tool, turnIndex, index);
    steps.push(step);
    if (tool.call_id) toolStepsByCallId.set(tool.call_id, step);
  }

  for (const event of sortedEvents) {
    if (event.kind !== "tool" && event.kind !== "mcp" && event.kind !== "skill") continue;
    const turnIndex = Math.min(turns.length - 1, replayTurnIndexForEvent(promptTurns, event));
    const callId = payloadString(event, "toolUseId");
    let step = callId ? toolStepsByCallId.get(callId) : undefined;
    if (!step) {
      step = {
        id: callId ? `tool-${callId}` : `replay-tool-${event.eventIndex}`,
        turnIndex,
        order: 10_000 + event.eventIndex,
        kind: event.kind,
        activity: "other",
        target: null,
        title: payloadString(event, "toolName") ?? event.title,
        summary: compactText(event.detail || event.title),
        status: event.status,
        startedAt: null,
        endedAt: null,
        durationMs: event.durationMs,
        sourceLabel: payloadString(event, "mcpServer") ?? payloadString(event, "skillName"),
        inputSummary: payloadString(event, "message"),
        outputSummary: null,
        rawEvents: [],
        files: [],
        snapshotEvent: null,
      };
      steps.push(step);
      if (callId) toolStepsByCallId.set(callId, step);
    }
    applyReplayToolEvent(step, event);
  }

  const subtaskSteps = new Map<string, MutableStep>();
  for (const event of sortedEvents) {
    const turnIndex = Math.min(turns.length - 1, replayTurnIndexForEvent(promptTurns, event));
    if (event.kind === "subtask") {
      const agentId = payloadString(event, "agentId");
      const key = agentId ?? `event-${event.eventIndex}`;
      let step = subtaskSteps.get(key);
      if (!step) {
        step = {
          id: `subtask-${key}`,
          turnIndex,
          order: 20_000 + event.eventIndex,
          kind: "subtask",
          activity: "subtask",
          target: null,
          title: payloadString(event, "agentType") ?? event.title,
          summary: compactText(event.detail || event.title),
          status: event.status,
          startedAt: null,
          endedAt: null,
          durationMs: event.durationMs,
          sourceLabel: agentId,
          inputSummary: payloadString(event, "message"),
          outputSummary: null,
          rawEvents: [],
          files: [],
          snapshotEvent: null,
        };
        steps.push(step);
        subtaskSteps.set(key, step);
      }
      step.rawEvents.push(event);
      if (replayEventName(event).endsWith("Start")) {
        step.startedAt = step.startedAt ?? event.timestamp;
        step.status = "running";
      } else if (replayEventName(event).endsWith("Stop")) {
        step.endedAt = event.timestamp;
        step.status = event.status === "failed" ? "failed" : "completed";
      }
      step.durationMs = durationBetween(step.startedAt, step.endedAt) ?? step.durationMs;
      continue;
    }
    if (event.kind === "snapshot" || event.kind === "permission" || event.kind === "notification" || event.kind === "error") {
      steps.push({
        id: `${event.kind}-${event.eventIndex}`,
        turnIndex,
        order: 30_000 + event.eventIndex,
        kind: event.kind,
        activity: event.kind,
        target: null,
        title: event.title,
        summary: compactText(event.detail || event.title),
        status: event.status,
        startedAt: event.timestamp,
        endedAt: event.timestamp,
        durationMs: event.durationMs,
        sourceLabel: null,
        inputSummary: null,
        outputSummary: null,
        rawEvents: [event],
        files: [],
        snapshotEvent: event.kind === "snapshot" ? event : null,
      });
    }
  }

  const fileChangesByTurn = groupFileChangesByTurn(
    historyDetail?.file_changes ?? [],
    messageTurnIndexes,
    turns.length
  );
  for (const [turnIndex, files] of fileChangesByTurn) {
    const timestamps = files
      .map((file) => file.latest_timestamp ?? null)
      .filter((value): value is string => Boolean(value))
      .sort((a, b) => (timestampMs(a) ?? 0) - (timestampMs(b) ?? 0));
    const latestTimestamp = timestamps[timestamps.length - 1] ?? null;
    steps.push({
      id: `files-${turnIndex}`,
      turnIndex,
      order: 25_000 + turnIndex,
      kind: "file",
      activity: "file",
      target: null,
      title: files.length === 1 ? files[0].file_path : `${files.length} files`,
      summary: files.map((file) => file.file_path).join(", "),
      status: "completed",
      startedAt: latestTimestamp,
      endedAt: latestTimestamp,
      durationMs: null,
      sourceLabel: null,
      inputSummary: null,
      outputSummary: null,
      rawEvents: [],
      files,
      snapshotEvent: null,
    });
  }

  if (sessionStatus && sessionStatus !== "running") {
    for (const step of steps) {
      if (step.status === "running") step.status = "incomplete";
    }
  }
  const finalizedTurns = finalizeTurns(turns, steps);
  const latestTurn = finalizedTurns[0] ?? null;
  const currentStep = latestTurn
    ? [...latestTurn.steps].reverse().find((step) => step.status === "running") ?? latestTurn.steps[latestTurn.steps.length - 1] ?? null
    : null;
  const current = latestTurn
    ? {
        title: currentStep?.title || latestTurn.prompt,
        summary: currentStep?.summary || latestTurn.response || latestTurn.prompt,
        status: currentStep?.status ?? latestTurn.status,
        timestamp: currentStep?.startedAt ?? latestTurn.startedAt,
      }
    : null;
  const allSteps = finalizedTurns.flatMap((turn) => turn.steps);
  const files = new Set(allSteps.flatMap((step) => step.files.map((file) => file.file_path)));

  return {
    turns: finalizedTurns,
    current,
    counts: {
      turns: finalizedTurns.length,
      tools: allSteps.filter((step) => step.kind === "tool" || step.kind === "mcp" || step.kind === "skill").length,
      files: files.size,
      validations: allSteps.filter((step) => step.kind === "validation").length,
      errors: allSteps.filter((step) => step.kind === "error" || step.status === "failed").length,
      workMs: finalizedTurns.reduce((sum, turn) => sum + (turn.durationMs ?? 0), 0),
    },
  };
}

export function createReplayEventMatcher(query: string): (event: ReplayEvent) => boolean {
  const normalized = query.trim();
  if (!normalized) return () => true;
  const matcher = new RegExp(normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  return (event) => {
    const fields = [
      event.title,
      event.detail,
      ...event.tags,
      payloadString(event, "toolName"),
      payloadString(event, "mcpServer"),
      payloadString(event, "skillName"),
      payloadString(event, "message"),
    ];
    return fields.some((value) => value && matcher.test(value));
  };
}
